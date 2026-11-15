import Foundation

/// 保存到 App 沙盒的 Documents/Music，并通过 Info.plist 的文件共享出现在「文件」App 里。
enum Storage {

    static var displayFolder: String {
        "「文件」→ 我的 iPhone → 网易云下载器 → Music"
    }

    static func documentsURL() -> URL {
        let fm = FileManager.default
        return fm.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
    }

    static func musicDir() -> URL {
        documentsURL().appendingPathComponent("Music", isDirectory: true)
    }

    static func tempWorkDir() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("ncm", isDirectory: true)
    }

    /// 把下载好的文件存进 Music 目录，返回可展示的相对路径。
    @discardableResult
    static func save(_ src: URL, displayName: String) throws -> String {
        let dir = musicDir()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dst = unique(dir, displayName)
        try FileManager.default.moveItem(at: src, to: dst)
        return "Documents/Music/" + dst.lastPathComponent
    }

    private static func unique(_ dir: URL, _ name: String) -> URL {
        let fm = FileManager.default
        var candidate = dir.appendingPathComponent(name)
        if !fm.fileExists(atPath: candidate.path) { return candidate }
        let ext = (name as NSString).pathExtension
        let base = ext.isEmpty ? name : (name as NSString).deletingPathExtension
        var i = 2
        while i < 1000 {
            let n = ext.isEmpty ? "\(base) (\(i))" : "\(base) (\(i)).\(ext)"
            candidate = dir.appendingPathComponent(n)
            if !fm.fileExists(atPath: candidate.path) { return candidate }
            i += 1
        }
        return dir.appendingPathComponent(name)
    }
}
