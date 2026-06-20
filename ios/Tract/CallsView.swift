import SwiftUI

struct CallsView: View {
    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            EmptyHint(icon: "phone",
                      title: "Журнал звонков пуст",
                      subtitle: "Звоните из чата по кнопке 📞. Рядом — по мешу, по интернету — скоро (WebRTC).")
        }
        .safeAreaInset(edge: .top) {
            ScreenHeader(title: "Звонки")
        }
    }
}
