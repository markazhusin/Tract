import Foundation
import Combine
import CryptoKit
import CommonCrypto

// MARK: - Hex helpers

extension Data {
    var hex: String { map { String(format: "%02x", $0) }.joined() }

    init?(hexString: String) {
        let s = hexString.count % 2 == 0 ? hexString : "0" + hexString
        var d = Data(capacity: s.count / 2)
        var idx = s.startIndex
        while idx < s.endIndex {
            let next = s.index(idx, offsetBy: 2)
            guard let b = UInt8(s[idx..<next], radix: 16) else { return nil }
            d.append(b)
            idx = next
        }
        self = d
    }
}

// MARK: - Identity (the key IS the account; userId derived from the public key)

struct Identity: Equatable {
    let privateKey: Curve25519.KeyAgreement.PrivateKey
    let publicKeyHex: String
    let userId: String
    var displayName: String

    static func == (lhs: Identity, rhs: Identity) -> Bool { lhs.userId == rhs.userId }
}

private struct StoredIdentity: Codable {
    var version: Int
    var userId: String
    var publicKeyHex: String
    var displayName: String
    var salt: String   // base64
    var box: String    // base64 (AES-GCM combined: nonce|ciphertext|tag)
}

enum IdentityError: LocalizedError {
    case noAccount
    case corrupt
    case wrongPassword

    var errorDescription: String? {
        switch self {
        case .noAccount: return "Аккаунт не найден"
        case .corrupt: return "Данные аккаунта повреждены"
        case .wrongPassword: return "Неверный пароль"
        }
    }
}

final class IdentityStore: ObservableObject {
    @Published private(set) var identity: Identity?

    private let key = "tract.identity.v2"

    init() {
        // Locked on launch: an account may exist but requires the password to unlock.
    }

    var hasAccount: Bool { UserDefaults.standard.data(forKey: key) != nil }

    var storedDisplayName: String? { stored()?.displayName }
    var storedUserId: String? { stored()?.userId }

    private func stored() -> StoredIdentity? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(StoredIdentity.self, from: data)
    }

    func createAccount(displayName: String, password: String) throws {
        let pk = Curve25519.KeyAgreement.PrivateKey()
        let pubHex = pk.publicKey.rawRepresentation.hex
        let userId = "@" + String(pubHex.prefix(12))

        var saltBytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, saltBytes.count, &saltBytes)
        let salt = Data(saltBytes)

        let aes = try Crypto.deriveAES(password: password, salt: salt)
        let sealed = try AES.GCM.seal(pk.rawRepresentation, using: aes)
        guard let box = sealed.combined else { throw IdentityError.corrupt }

        let record = StoredIdentity(
            version: 2,
            userId: userId,
            publicKeyHex: pubHex,
            displayName: displayName,
            salt: salt.base64EncodedString(),
            box: box.base64EncodedString()
        )
        UserDefaults.standard.set(try JSONEncoder().encode(record), forKey: key)
        identity = Identity(privateKey: pk, publicKeyHex: pubHex, userId: userId, displayName: displayName)
    }

    func login(password: String) throws {
        guard let record = stored() else { throw IdentityError.noAccount }
        guard let salt = Data(base64Encoded: record.salt),
              let box = Data(base64Encoded: record.box) else { throw IdentityError.corrupt }
        let aes = try Crypto.deriveAES(password: password, salt: salt)
        let raw: Data
        do {
            raw = try AES.GCM.open(try AES.GCM.SealedBox(combined: box), using: aes)
        } catch {
            throw IdentityError.wrongPassword
        }
        let pk = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw)
        identity = Identity(privateKey: pk, publicKeyHex: record.publicKeyHex, userId: record.userId, displayName: record.displayName)
    }

    /// Lock the session (keeps the encrypted account on disk).
    func lock() { identity = nil }

    /// Permanently remove the account from this device.
    func deleteAccount() {
        UserDefaults.standard.removeObject(forKey: key)
        identity = nil
    }
}

// MARK: - Crypto (PBKDF2 key wrapping + X25519 → AES-GCM E2E for the mesh)

enum Crypto {
    /// Derive a 256-bit AES key from a password (PBKDF2-HMAC-SHA256, 200k rounds).
    static func deriveAES(password: String, salt: Data) throws -> SymmetricKey {
        var out = Data(repeating: 0, count: 32)
        let status = out.withUnsafeMutableBytes { (outPtr: UnsafeMutableRawBufferPointer) -> Int32 in
            salt.withUnsafeBytes { (saltPtr: UnsafeRawBufferPointer) -> Int32 in
                CCKeyDerivationPBKDF(
                    CCPBKDFAlgorithm(kCCPBKDF2),
                    password, password.utf8.count,
                    saltPtr.bindMemory(to: UInt8.self).baseAddress, salt.count,
                    CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                    UInt32(200_000),
                    outPtr.bindMemory(to: UInt8.self).baseAddress, 32
                )
            }
        }
        guard status == kCCSuccess else { throw IdentityError.corrupt }
        return SymmetricKey(data: out)
    }

    /// Shared symmetric key between my private key and a peer's public key.
    static func sharedKey(my: Curve25519.KeyAgreement.PrivateKey, theirHex: String) -> SymmetricKey? {
        guard let pubData = Data(hexString: theirHex),
              let pub = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: pubData),
              let secret = try? my.sharedSecretFromKeyAgreement(with: pub) else { return nil }
        return secret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: Data("tract-mesh".utf8),
            sharedInfo: Data(),
            outputByteCount: 32
        )
    }

    static func seal(_ text: String, key: SymmetricKey) -> String? {
        guard let sealed = try? AES.GCM.seal(Data(text.utf8), using: key),
              let combined = sealed.combined else { return nil }
        return combined.base64EncodedString()
    }

    static func open(_ b64: String, key: SymmetricKey) -> String? {
        guard let data = Data(base64Encoded: b64),
              let box = try? AES.GCM.SealedBox(combined: data),
              let pt = try? AES.GCM.open(box, using: key) else { return nil }
        return String(data: pt, encoding: .utf8)
    }
}
