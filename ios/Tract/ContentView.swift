import SwiftUI

struct ContentView: View {
    var body: some View {
        WebView()
            .ignoresSafeArea()          // the web UI manages its own safe-area insets
            .background(Color.black)
            .preferredColorScheme(.dark)
    }
}
