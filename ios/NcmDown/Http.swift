import Foundation

/// URLSession 封装的 HTTP（给 JS 当代理，绕开 WebView 的同源限制）。
enum Http {

    static let userAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        + "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

    private static let session: URLSession = {
        let conf = URLSessionConfiguration.ephemeral
        conf.timeoutIntervalForRequest = 30
        conf.timeoutIntervalForResource = 60
        conf.httpAdditionalHeaders = ["Accept-Encoding": "gzip, deflate"]
        return URLSession(configuration: conf)
    }()

    static func request(method: String, url: String, headersJSON: String, body: String?,
                        completion: @escaping (Int, String, String) -> Void) {
        guard let u = URL(string: url) else {
            completion(0, "", "bad url")
            return
        }
        var req = URLRequest(url: u)
        req.httpMethod = method.uppercased()
        req.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        req.setValue("https://music.163.com/", forHTTPHeaderField: "Referer")
        req.setValue("*/*", forHTTPHeaderField: "Accept")
        req.setValue("zh-CN,zh;q=0.9", forHTTPHeaderField: "Accept-Language")

        if let data = headersJSON.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            for (k, v) in obj {
                let key = k.lowercased()
                if key == "content-length" || key == "host" || key == "connection" { continue }
                req.setValue("\(v)", forHTTPHeaderField: k)
            }
        }
        if let b = body {
            req.httpBody = b.data(using: .utf8)
            if req.value(forHTTPHeaderField: "Content-Type") == nil {
                req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            }
        }

        session.dataTask(with: req) { data, response, error in
            if let error = error {
                completion(0, "", error.localizedDescription)
                return
            }
            let http = response as? HTTPURLResponse
            let status = http?.statusCode ?? 0
            var text = ""
            if let d = data, !d.isEmpty {
                text = String(data: d, encoding: .utf8)
                    ?? String(data: d, encoding: .isoLatin1) ?? ""
            }
            completion(status, text, http?.url?.absoluteString ?? url)
        }.resume()
    }
}
