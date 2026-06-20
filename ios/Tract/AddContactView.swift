import SwiftUI
import CoreImage.CIFilterBuiltins

struct AddContactView: View {
    @EnvironmentObject var mesh: MeshService
    @EnvironmentObject var node: NodeConfig
    @EnvironmentObject var identity: IdentityStore
    @Environment(\.dismiss) private var dismiss

    @State private var input = ""
    @State private var status = ""
    @State private var busy = false
    @State private var copied = false

    private var myId: String { identity.identity?.userId ?? "" }
    private var myPk: String { identity.identity?.publicKeyHex ?? "" }
    private var shareString: String { "tract:\(myId):\(myPk)" }

    var body: some View {
        NavigationStack {
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
                            Text("Ваш ID").font(.system(size: 13)).foregroundStyle(Theme.muted)
                            Text(myId)
                                .font(.system(size: 20, weight: .bold, design: .monospaced))
                                .foregroundStyle(Theme.accent)
                            Button {
                                UIPasteboard.general.string = myId
                                copied = true
                                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                            } label: {
                                Label(copied ? "Скопировано" : "Скопировать ID",
                                      systemImage: copied ? "checkmark" : "doc.on.doc")
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(Theme.accent)
                            }
                            .buttonStyle(.plain)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 18)
                        .background(Theme.panel, in: RoundedRectangle(cornerRadius: 22, style: .continuous))

                        // Add someone by their ID.
                        VStack(alignment: .leading, spacing: 10) {
                            Text("ДОБАВИТЬ ПО ID")
                                .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.muted)
                            HStack(spacing: 10) {
                                TextField("@id или tract-ссылка", text: $input)
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
            .navigationTitle("Новый контакт")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Готово") { dismiss() }.foregroundStyle(Theme.accent)
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private var canAdd: Bool {
        !busy && !input.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func add() {
        busy = true
        status = "Ищу контакт…"
        let raw = input
        Task {
            let ok = await mesh.lookupContact(by: raw, node: node)
            await MainActor.run {
                busy = false
                if ok { dismiss() }
                else { status = "Не найдено. Контакт должен быть онлайн хотя бы раз — или добавьте по его QR / tract-ссылке." }
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
