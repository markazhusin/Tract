import Foundation

/// Minimal bencode codec (BEP-3 wire format) — just enough for KRPC (BEP-5) and
/// mutable items (BEP-44). A direct Swift port of internal/mainline/bencode.go so
/// the iOS client speaks the EXACT same bytes as the Go node and the public DHT.
///
/// bencode "strings" are byte strings (they hold ids/keys/signatures = raw bytes),
/// so we model them as `Data`, never `String`. Dictionary keys are emitted in
/// lexicographic BYTE order, as the spec requires — this is also what makes BEP-44
/// signatures reproducible across implementations.
indirect enum Bencode {
    case int(Int64)
    case bytes(Data)
    case list([Bencode])
    case dict([String: Bencode])   // keys are ASCII in KRPC; stored as String, encoded as UTF-8 bytes

    // MARK: Convenience constructors / accessors

    static func string(_ s: String) -> Bencode { .bytes(Data(s.utf8)) }

    var dataValue: Data? { if case .bytes(let d) = self { return d } else { return nil } }
    var stringValue: String? { dataValue.flatMap { String(data: $0, encoding: .utf8) } }
    var intValue: Int64? { if case .int(let i) = self { return i } else { return nil } }
    var listValue: [Bencode]? { if case .list(let l) = self { return l } else { return nil } }
    var dictValue: [String: Bencode]? { if case .dict(let d) = self { return d } else { return nil } }

    subscript(_ key: String) -> Bencode? {
        if case .dict(let d) = self { return d[key] } else { return nil }
    }
}

enum BencodeError: Error { case malformed }

// MARK: - Encode

extension Bencode {
    func encoded() -> Data {
        var out = Data()
        Bencode.encode(self, into: &out)
        return out
    }

    private static func encode(_ v: Bencode, into out: inout Data) {
        switch v {
        case .int(let n):
            out.append(UInt8(ascii: "i"))
            out.append(contentsOf: Array(String(n).utf8))
            out.append(UInt8(ascii: "e"))
        case .bytes(let d):
            out.append(contentsOf: Array(String(d.count).utf8))
            out.append(UInt8(ascii: ":"))
            out.append(d)
        case .list(let items):
            out.append(UInt8(ascii: "l"))
            for it in items { encode(it, into: &out) }
            out.append(UInt8(ascii: "e"))
        case .dict(let d):
            out.append(UInt8(ascii: "d"))
            // Sort keys by raw UTF-8 byte order (spec requirement + signature stability).
            let keys = d.keys.sorted { a, b in
                let ab = Array(a.utf8), bb = Array(b.utf8)
                for i in 0..<min(ab.count, bb.count) where ab[i] != bb[i] { return ab[i] < bb[i] }
                return ab.count < bb.count
            }
            for k in keys {
                let kb = Array(k.utf8)
                out.append(contentsOf: Array(String(kb.count).utf8))
                out.append(UInt8(ascii: ":"))
                out.append(contentsOf: kb)
                encode(d[k]!, into: &out)
            }
            out.append(UInt8(ascii: "e"))
        }
    }
}

// MARK: - Decode

extension Bencode {
    static func decode(_ data: Data) throws -> Bencode {
        var d = Decoder(buf: [UInt8](data))
        return try d.value()
    }

    private struct Decoder {
        let buf: [UInt8]
        var pos = 0

        mutating func value() throws -> Bencode {
            guard pos < buf.count else { throw BencodeError.malformed }
            let c = buf[pos]
            switch c {
            case UInt8(ascii: "i"): return .int(try integer())
            case UInt8(ascii: "l"): return try list()
            case UInt8(ascii: "d"): return try dict()
            case UInt8(ascii: "0")...UInt8(ascii: "9"): return .bytes(try str())
            default: throw BencodeError.malformed
            }
        }

        mutating func integer() throws -> Int64 {
            pos += 1 // 'i'
            let start = pos
            while pos < buf.count && buf[pos] != UInt8(ascii: "e") { pos += 1 }
            guard pos < buf.count else { throw BencodeError.malformed }
            guard let n = Int64(String(decoding: buf[start..<pos], as: UTF8.self)) else { throw BencodeError.malformed }
            pos += 1 // 'e'
            return n
        }

        mutating func str() throws -> Data {
            let start = pos
            while pos < buf.count && buf[pos] != UInt8(ascii: ":") { pos += 1 }
            guard pos < buf.count else { throw BencodeError.malformed }
            guard let n = Int(String(decoding: buf[start..<pos], as: UTF8.self)), n >= 0 else { throw BencodeError.malformed }
            pos += 1 // ':'
            guard pos + n <= buf.count else { throw BencodeError.malformed }
            let d = Data(buf[pos..<pos + n])
            pos += n
            return d
        }

        mutating func list() throws -> Bencode {
            pos += 1 // 'l'
            var out: [Bencode] = []
            while pos < buf.count && buf[pos] != UInt8(ascii: "e") { out.append(try value()) }
            guard pos < buf.count else { throw BencodeError.malformed }
            pos += 1 // 'e'
            return .list(out)
        }

        mutating func dict() throws -> Bencode {
            pos += 1 // 'd'
            var out: [String: Bencode] = [:]
            while pos < buf.count && buf[pos] != UInt8(ascii: "e") {
                let k = try str()
                let v = try value()
                out[String(decoding: k, as: UTF8.self)] = v
            }
            guard pos < buf.count else { throw BencodeError.malformed }
            pos += 1 // 'e'
            return .dict(out)
        }
    }
}
