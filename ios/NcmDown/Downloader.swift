import Foundation
import AVFoundation

/// 下载队列：URLSession 下载 → 校验时长（识别 45 秒试听）→ 写标签 → 存入沙盒 Music。
final class Downloader: NSObject, URLSessionDelegate, URLSessionDownloadDelegate {

    var onEvent: ((String) -> Void)?

    private struct Job {
        let key: String
        let url: String
        let cookie: String
        let ext: String
        let size: Int64
        let expectedMs: Int64
        let filename: String
        let title: String
        let artist: String
        let album: String
        let lyric: String
        var retries = 0
        var resumeData: Data?
    }

    private var session: URLSession!
    private let lock = NSLock()
    private var pending: [Job] = []
    private var running: [Int: Job] = [:]          // taskIdentifier -> job
    private var lastEmit: [String: TimeInterval] = [:]
    private var active = 0
    private var concurrency = 6
    private var stopped = false

    func prepare() {
        let conf = URLSessionConfiguration.default
        conf.timeoutIntervalForRequest = 30
        conf.timeoutIntervalForResource = 600
        conf.httpAdditionalHeaders = ["Accept-Encoding": "identity"]
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 8
        session = URLSession(configuration: conf, delegate: self, delegateQueue: queue)
    }

    // MARK: - 队列控制
    func setConcurrency(_ n: Int) {
        lock.lock(); concurrency = max(1, min(12, n)); lock.unlock()
        pump()
    }

    func enqueue(_ json: String) {
        guard let data = json.data(using: .utf8),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
        lock.lock()
        stopped = false
        for o in arr {
            let job = Job(
                key: o["key"] as? String ?? UUID().uuidString,
                url: o["url"] as? String ?? "",
                cookie: o["cookie"] as? String ?? "",
                ext: o["ext"] as? String ?? "",
                size: (o["size"] as? NSNumber)?.int64Value ?? 0,
                expectedMs: (o["expectedMs"] as? NSNumber)?.int64Value ?? 0,
                filename: o["filename"] as? String ?? "audio",
                title: o["title"] as? String ?? "",
                artist: o["artist"] as? String ?? "",
                album: o["album"] as? String ?? "",
                lyric: o["lyric"] as? String ?? "")
            pending.append(job)
        }
        lock.unlock()
        pump()
    }

    func stopAll() {
        lock.lock()
        stopped = true
        let jobs = pending
        pending.removeAll()
        let runningKeys = running.values.map { $0.key }
        lock.unlock()
        for j in jobs { emit(["key": j.key, "status": "cancel", "message": "已取消"]) }
        session.getAllTasks { tasks in
            for t in tasks {
                if let key = t.taskDescription, runningKeys.contains(key) { t.cancel() }
            }
        }
    }

    private func pump() {
        lock.lock()
        var startable: [Job] = []
        while active < concurrency && !pending.isEmpty && !stopped {
            startable.append(pending.removeFirst())
            active += 1
        }
        lock.unlock()
        for job in startable { start(job) }
    }

    private func start(_ job: Job) {
        guard let u = URL(string: job.url) else {
            finish(job: job, ok: false, message: "链接无效")
            return
        }
        var req = URLRequest(url: u)
        req.setValue(Http.userAgent, forHTTPHeaderField: "User-Agent")
        req.setValue("https://music.163.com/", forHTTPHeaderField: "Referer")
        req.setValue("*/*", forHTTPHeaderField: "Accept")
        if !job.cookie.isEmpty { req.setValue(job.cookie, forHTTPHeaderField: "Cookie") }

        let task: URLSessionDownloadTask
        if let rd = job.resumeData, !rd.isEmpty {
            task = session.downloadTask(withResumeData: rd)
        } else {
            task = session.downloadTask(with: req)
        }
        task.taskDescription = job.key
        lock.lock(); running[task.taskIdentifier] = job; lock.unlock()
        emit(["key": job.key, "status": "start"])
        task.resume()
    }

    private func finish(job: Job, ok: Bool, message: String) {
        lock.lock()
        active = max(0, active - 1)
        lock.unlock()
        if !ok { emit(["key": job.key, "status": "fail", "message": message]) }
        pump()
    }

    // MARK: - URLSessionDownloadDelegate
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        guard let key = downloadTask.taskDescription else { return }
        let now = Date().timeIntervalSince1970
        lock.lock()
        let last = lastEmit[key] ?? 0
        let should = now - last > 0.25
        if should { lastEmit[key] = now }
        lock.unlock()
        guard should else { return }
        let total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : 0
        let pct = total > 0 ? Int(min(100, totalBytesWritten * 100 / total)) : 0
        emit(["key": key, "status": "progress", "done": totalBytesWritten,
              "total": total, "pct": pct])
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        guard let key = downloadTask.taskDescription else { return }
        lock.lock()
        let job = running.removeValue(forKey: downloadTask.taskIdentifier)
        lock.unlock()
        guard let job = job else { return }

        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            finish(job: job, ok: false, message: "HTTP \(status)")
            return
        }
        let ctype = (downloadTask.response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
        if ctype.contains("text/html") || ctype.contains("application/json") {
            finish(job: job, ok: false, message: "返回的不是音频")
            return
        }

        let fm = FileManager.default
        let work = Storage.tempWorkDir()
        try? fm.createDirectory(at: work, withIntermediateDirectories: true)
        let tmp = work.appendingPathComponent(job.key + ".part")
        try? fm.removeItem(at: tmp)
        do {
            try fm.moveItem(at: location, to: tmp)
        } catch {
            finish(job: job, ok: false, message: "写入临时文件失败")
            return
        }
        process(job: job, file: tmp)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error = error else { return }
        guard let key = task.taskDescription else { return }
        lock.lock()
        var job = running.removeValue(forKey: task.taskIdentifier)
        lock.unlock()
        guard var j = job else { return }

        let ns = error as NSError
        if let rd = ns.userInfo[NSURLSessionDownloadTaskResumeData] as? Data,
           j.retries < 3, !stopped {
            j.retries += 1
            j.resumeData = rd
            job = j
            lock.lock(); pending.insert(j, at: 0); lock.unlock()
            active = max(0, active - 1)
            pump()
            return
        }
        finish(job: j, ok: false, message: error.localizedDescription)
    }

    // MARK: - 处理文件
    private func process(job: Job, file: URL) {
        let ext0 = Util.detectExt(file)
        let ext = ext0.isEmpty ? (job.ext.isEmpty ? "mp3" : job.ext) : ext0

        let dur = durationMs(file)
        if job.expectedMs > 0 && dur > 0 && dur < job.expectedMs * 72 / 100 {
            try? FileManager.default.removeItem(at: file)
            emit(["key": job.key, "status": "retry",
                  "message": "仅 \(dur / 1000)s 试听片段"])
            finish(job: job, ok: false, message: "试听片段")
            return
        }

        let tagged = Tagger.tag(file, title: job.title, artist: job.artist,
                                album: job.album, lyric: job.lyric)
        let name = buildName(job: job, ext: ext)
        do {
            let rel = try Storage.save(file, displayName: name)
            try? FileManager.default.removeItem(at: file)
            emit(["key": job.key, "status": "done", "path": rel,
                  "name": name, "size": max(job.size, 0), "durationMs": dur,
                  "ext": ext, "tagged": tagged])
            finish(job: job, ok: true, message: "")
        } catch {
            try? FileManager.default.removeItem(at: file)
            finish(job: job, ok: false, message: "保存失败: \(error.localizedDescription)")
        }
    }

    private func buildName(job: Job, ext: String) -> String {
        var base = job.filename
        if base.isEmpty {
            base = Util.safeName("\(job.title) \(job.artist)")
        }
        if base.lowercased().hasSuffix("." + ext) { return base }
        if let dot = base.lastIndex(of: "."), base.distance(from: dot, to: base.endIndex) <= 5 {
            base = String(base[..<dot])
        }
        return base + "." + ext
    }

    private func durationMs(_ url: URL) -> Int64 {
        let asset = AVURLAsset(url: url)
        let seconds = CMTimeGetSeconds(asset.duration)
        guard seconds.isFinite, seconds > 0 else { return 0 }
        return Int64(seconds * 1000)
    }

    // MARK: - 事件
    private func emit(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
              let s = String(data: data, encoding: .utf8) else { return }
        onEvent?(s)
    }
}
