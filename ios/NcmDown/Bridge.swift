import Foundation
import UIKit
import WebKit

/// JS ↔ 原生 的桥：HTTP 代理、下载队列、配置、Toast。
final class Bridge {
    static let appVersion = "1.4.0"

    private weak var webView: WKWebView?
    private let downloader = Downloader()
    private let httpQueue = DispatchQueue(label: "ncm.http", qos: .userInitiated, attributes: .concurrent)

    func attach(webView: WKWebView) {
        self.webView = webView
        downloader.onEvent = { [weak self] json in
            self?.send("window.NcmEvents&&NcmEvents.task(\(json))")
        }
        downloader.prepare()
    }

    // MARK: - 消息分发
    func handle(_ body: Any) {
        guard let dict = body as? [String: Any], let action = dict["action"] as? String else { return }
        switch action {
        case "http":
            handleHttp(dict)
        case "enqueue":
            downloader.enqueue(dict["json"] as? String ?? "[]")
        case "stop":
            downloader.stopAll()
        case "setConcurrency":
            downloader.setConcurrency(dict["n"] as? Int ?? 6)
        case "toast":
            toast(dict["msg"] as? String ?? "")
        case "openFolder":
            toast(Storage.displayFolder)
        case "setPref":
            UserDefaults.standard.set(dict["value"], forKey: "pref." + (dict["key"] as? String ?? ""))
        default:
            break
        }
    }

    // MARK: - HTTP
    private func handleHttp(_ dict: [String: Any]) {
        let id = dict["id"] as? Int ?? 0
        let method = dict["method"] as? String ?? "GET"
        let url = dict["url"] as? String ?? ""
        let headers = dict["headers"] as? String ?? "{}"
        let form = dict["body"] as? String

        httpQueue.async { [weak self] in
            Http.request(method: method, url: url, headersJSON: headers, body: form) { status, text, finalURL in
                let js = "window.__ncmHttp&&__ncmHttp(\(id),\(status),\(Bridge.js(text)),\(Bridge.js(finalURL)))"
                self?.send(js)
            }
        }
    }

    // MARK: - 发送
    func send(_ js: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    func sendShare(_ url: String) {
        send("window.NcmEvents&&NcmEvents.share(\(Bridge.js(url)))")
        toast("已接收分享链接，正在解析…")
    }

    func toast(_ msg: String) {
        DispatchQueue.main.async {
            guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                  let root = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController else { return }
            let alert = UIAlertController(title: nil, message: msg, preferredStyle: .alert)
            root.present(alert, animated: true)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { alert.dismiss(animated: true) }
        }
    }

    // MARK: - JS 字符串转义
    static func js(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\\": out += "\\\\"
            case "\"": out += "\\\""
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 || scalar.value == 0x2028 || scalar.value == 0x2029 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }
}

/// 处理「分享到本应用」带进来的链接。
final class ShareInbox {
    static let shared = ShareInbox()
    var pendingURL: String?
}
