import SwiftUI

/// Quick toggles reached from the shield in the Chats header.
struct QuickSettingsView: View {
    @EnvironmentObject var mesh: MeshService
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            ZStack {
                Theme.bg.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 14) {
                        GroupCard {
                            toggleRow(icon: "dot.radiowaves.left.and.right", tint: Theme.online,
                                      title: "Поиск рядом",
                                      subtitle: "Находить устройства по Wi-Fi/Bluetooth без интернета.",
                                      isOn: $mesh.meshEnabled)
                            RowDivider()
                            toggleRow(icon: "eye.slash.fill", tint: Color(hex: "#c77dff"),
                                      title: "Невидимость",
                                      subtitle: "Вас не видно рядом и в сети — но устройство продолжает передавать чужие сообщения, как курьер.",
                                      isOn: $mesh.stealth)
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Приватность и сеть")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Готово") { dismiss() }.foregroundStyle(Theme.accent)
                }
            }
        }
        .navigationViewStyle(.stack)
        .preferredColorScheme(.dark)
    }

    private func toggleRow(icon: String, tint: Color, title: String, subtitle: String, isOn: Binding<Bool>) -> some View {
        HStack(alignment: .top, spacing: 13) {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(tint).frame(width: 30, height: 30)
                .overlay(Image(systemName: icon).font(.system(size: 14, weight: .semibold)).foregroundStyle(.white))
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 17)).foregroundStyle(Theme.text)
                Text(subtitle).font(.system(size: 12.5)).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 8)
            Toggle("", isOn: isOn).labelsHidden().tint(Theme.accent)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }
}
