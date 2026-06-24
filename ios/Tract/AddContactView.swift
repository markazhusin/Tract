import SwiftUI
import CoreImage.CIFilterBuiltins

struct AddContactView: View {
    @EnvironmentObject var mesh: MeshService
    @EnvironmentObject var node: NodeConfig
    @EnvironmentObject var identity: IdentityStore
    @EnvironmentObject var loc: AppLanguage
    @Environment(\.dismiss) private var dismiss

    @State private var input = ""
    @State private var status = ""
    @State private var busy = false
    @State private var copied = false
    @State private var showScanner = false

    private var myId: String { identity.identity?.userId ?? "" }
    private var myPk: String { identity.identity?.publicKeyHex ?? "" }
    private var shareString: String { "tract:\(myId):\(myPk)" }

    var body: some View {
        NavigationView {
            ZStack {
                Theme.bg.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 22) {
                        // Your ID + QR (others scan/paste this to add you — works offline).
                        VStack(spacing: 14) {
                            if let img = qr(shareString) {
                                Image(uiImage: img)
                                    .interpolation(.none)
                                    .resizable()
                                    .frame(width: 184, height: 184)
                                    .padding(10)
                                    .background(.white)
                                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            }
                            Text(loc.t("add.yourId")).font(.system(size: 13)).foregroundStyle(Theme.muted)
                            Text(myId)
                                .font(.system(size: 20, weight: .bold, design: .monospaced))
                                .foregroundStyle(Theme.accent)
                            Button {
                                UIPasteboard.general.string = myId
                                copied = true
                                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                            } label: {
                                Label(copied ? loc.t("add.copied") : loc.t("add.copyId"),
                                      systemImage: copied ? "checkmark" : "doc.on.doc")
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(Theme.accent)
                            }
                            .buttonStyle(.plain)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 18)
                        .background(Theme.panel, in: RoundedRectangle(cornerRadius: 22, style: .continuous))

                        // Scan someone's QR (works offline).
                        Button { showScanner = true } label: {
                            Label(loc.t("add.scanQR"), systemImage: "qrcode.viewfinder")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(Theme.onAccent)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .background(Theme.accent, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        }
                        .buttonStyle(.plain)

                        // Add someone by their ID.
                        VStack(alignment: .leading, spacing: 10) {
                            Text(loc.t("add.byId").uppercased())
                                .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.muted)
                            HStack(spacing: 10) {
                                TextField(loc.t("add.placeholder"), text: $input)
                                    .font(.system(size: 16))
                                    .foregroundStyle(Theme.text)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                    .padding(.horizontal, 14).padding(.vertical, 13)
                                    .background(Theme.panelInput, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                Button(action: add) {
                                    if busy { ProgressView().tint(Theme.onAccent) }
                                    else { Image(systemName: "plus").font(.system(size: 18, weight: .bold)) }
                                }
                                .frame(width: 50, height: 48)
                                .background(canAdd ? Theme.accent : Theme.muted.opacity(0.4),
                                            in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .foregroundStyle(Theme.onAccent)
                                .buttonStyle(.plain)
                                .disabled(!canAdd)
                            }
                            if !status.isEmpty {
                                Text(status).font(.system(size: 13)).foregroundStyle(Theme.muted)
                            }
                        }
                    }
                    .padding(18)
                }
            }
            .navigationTitle(loc.t("add.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(loc.t("common.done")) { dismiss() }.foregroundStyle(Theme.accent)
                }
            }
        }
        .navigationViewStyle(.stack)
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showScanner) {
            ZStack(alignment: .top) {
                QRScannerView(
                    onScan: { value in showScanner = false; handleScanned(value) },
                    onError: { _ in showScanner = false; status = loc.t("add.scanError") }
                )
                .ignoresSafeArea()
                HStack {
                    Spacer()
                    Button(loc.t("common.done")) { showScanner = false }
                        .foregroundStyle(.white).padding()
                }
            }
        }
    }

    /// Handle a scanned payload: accept a `tract:<id>:<pk>` code (offline-capable) or
    /// a bare @id, then look it up and add the contact.
    private func handleScanned(_ value: String) {
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        input = v
        busy = true
        status = loc.t("add.searching")
        Task {
            let ok = await mesh.lookupContact(by: v, node: node)
            await MainActor.run {
                busy = false
                if ok { dismiss() } else { status = loc.t("add.notFound") }
            }
        }
    }

    private var canAdd: Bool {
        !busy && !input.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func add() {
        let raw = input
        guard node.isConfigured || raw.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("tract:") else {
            status = loc.t("add.connecting")
            return
        }
        busy = true
        status = loc.t("add.searching")
        Task {
            let ok = await mesh.lookupContact(by: raw, node: node)
            await MainActor.run {
                busy = false
                if ok { dismiss() }
                else { status = loc.t("add.notFound") }
            }
        }
    }

    private func qr(_ string: String) -> UIImage? {
        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = context.createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
