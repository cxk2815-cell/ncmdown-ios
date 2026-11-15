import Foundation

/// 容器识别 / 文件名清理 / 大小格式化（纯 Foundation，可在 macOS 与 Windows 上编译测试）
public enum Util {

    /// 读文件头判断真实音频容器
    public static func detectExt(_ url: URL) -> String {
        guard let fh = try? FileHandle(forReadingFrom: url) else { return "" }
        defer { try? fh.close() }
        guard let head = try? fh.read(upToCount: 16), let data = head, data.count >= 4 else { return "" }
        let b = [UInt8](data)
        if b[0] == 0x66 && b[1] == 0x4C && b[2] == 0x61 && b[3] == 0x43 { return "flac" }
        if b[0] == 0x49 && b[1] == 0x44 && b[2] == 0x33 { return "mp3" }
        if b[0] == 0x4F && b[1] == 0x67 && b[2] == 0x67 && b[3] == 0x53 { return "ogg" }
        if b[0] == 0x52 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x46 { return "wav" }
        if b.count >= 8 && b[4] == 0x66 && b[5] == 0x74 && b[6] == 0x79 && b[7] == 0x70 { return "m4a" }
        if b[0] == 0xFF && (b[1] & 0xF0) == 0xF0 || b[0] == 0xFF && (b[1] & 0xE0) == 0xE0 {
            let layer = (b[1] >> 1) & 0x03
            return (layer == 1 || layer == 2) ? "aac" : "mp3"
        }
        return ""
    }

    public static func mime(of ext: String) -> String {
        switch ext.lowercased() {
        case "mp3": return "audio/mpeg"
        case "flac": return "audio/flac"
        case "m4a": return "audio/mp4"
        case "aac": return "audio/aac"
        case "wav": return "audio/wav"
        case "ogg": return "audio/ogg"
        default: return "audio/mpeg"
        }
    }

    /// 文件名清洗：非法字符换成空格，压缩空白，限制长度
    public static func safeName(_ name: String, max length: Int = 100) -> String {
        let illegal = CharacterSet(charactersIn: "\\/:*?\"<>|\r\n\t")
        var s = name.components(separatedBy: illegal).joined(separator: " ")
        s = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasPrefix(".") { s.removeFirst() }
        if s.count > length { s = String(s.prefix(length)).trimmingCharacters(in: .whitespaces) }
        return s.isEmpty ? "未命名" : s
    }

    public static func human(_ bytes: Int64) -> String {
        if bytes < 1024 { return "\(bytes)B" }
        let kb = Double(bytes) / 1024.0
        if kb < 1024 { return String(format: "%.0fKB", kb) }
        let mb = kb / 1024.0
        if mb < 1024 { return String(format: "%.1fMB", mb) }
        return String(format: "%.2fGB", mb / 1024.0)
    }
}
