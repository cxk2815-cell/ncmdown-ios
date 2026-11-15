import SwiftUI
import UIKit
import WebKit

/// WKWebView 容器：加载内置的 web 界面，并把 JS 的消息转给 Bridge。
struct ContentView: View {
    @StateObject private var holder = WebHolder()
    var body: some View {
        WebViewRepresentable(holder: holder)
            .background(Color(red: 0.95, green: 0.95, blue: 0.97))
    }
}

final class WebHolder: ObservableObject {
    let controller = WebController()
}

struct WebViewRepresentable: UIViewRepresentable {
    let holder: WebHolder

    func makeUIView(context: Context) -> WKWebView {
        holder.controller.webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// 负责 WebView 生命周期、注入 __IOS_INFO、加载本地页面。
final class WebController: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let webView: WKWebView
    private let bridge: Bridge

    override init() {
        let conf = WKWebViewConfiguration()
        conf.allowsInlineMediaPlayback = true
        conf.defaultWebpagePreferences.allowsContentJavaScript = true
        conf.preferences.javaScriptCanOpenWindowsAutomatically = false

        let info: [String: Any] = [
            "saveDir": Storage.displayFolder,
            "device": "\(UIDevice.current.model) · iOS \(UIDevice.current.systemVersion)",
            "version": Bridge.appVersion
        ]
        if let data = try? JSONSerialization.data(withJSONObject: info, options: []),
           let json = String(data: data, encoding: .utf8) {
            let script = "window.__IOS_INFO = \(json);"
            conf.userContentController.addUserScript(
                WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }

        self.webView = WKWebView(frame: .zero, configuration: conf)
        self.bridge = Bridge()
        super.init()

        bridge.attach(webView: webView)
        conf.userContentController.add(self, name: "ncm")
        webView.navigationDelegate = self
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.95, green: 0.95, blue: 0.97, alpha: 1)

        loadLocalPage()
    }

    private func loadLocalPage() {
        let dir = Bundle.main.bundleURL.appendingPathComponent("web", isDirectory: true)
        let index = dir.appendingPathComponent("index.html")
        guard FileManager.default.fileExists(atPath: index.path) else {
            assertionFailure("web assets missing at \(index.path)")
            return
        }
        webView.loadFileURL(index, allowingReadAccessTo: dir)
    }

    // MARK: - WKScriptMessageHandler
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "ncm" else { return }
        bridge.handle(message.body)
    }

    // MARK: - WKNavigationDelegate
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 页面加载完成后，若启动时带着分享链接就交给 JS
        if let url = ShareInbox.shared.pendingURL {
            ShareInbox.shared.pendingURL = nil
            bridge.sendShare(url)
        }
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // 只允许加载本地页面，外链一律忽略
        if let u = navigationAction.request.url, u.scheme == "file" {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
        }
    }
}
