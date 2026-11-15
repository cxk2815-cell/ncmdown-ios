import Foundation

/// 给 MP3 写 ID3v2.4 标签、给 FLAC 写 VorbisComment（含歌词）。
/// 采用流式重写，避免把几十 MB 的音频整体读进内存。
public enum Tagger {

    @discardableResult
    public static func tag(_ url: URL, title: String, artist: String, album: String, lyric: String) -> Bool {
        let ext = Util.detectExt(url)
        do {
            if ext == "mp3" { return try id3(url, title: title, artist: artist, album: album, lyric: lyric) }
            if ext == "flac" { return try flac(url, title: title, artist: artist, album: album, lyric: lyric) }
        } catch {
            return false
        }
        return true
    }

    // MARK: - ID3v2.4

    private static func id3(_ url: URL, title: String, artist: String, album: String, lyric: String) throws -> Bool {
        var frames = Data()
        if !title.isEmpty { frames.append(textFrame("TIT2", title)) }
        if !artist.isEmpty { frames.append(textFrame("TPE1", artist)) }
        if !album.isEmpty { frames.append(textFrame("TALB", album)) }
        if !lyric.isEmpty { frames.append(usltFrame(lyric)) }

        var audioStart: UInt64 = 0
        if let fh = try? FileHandle(forReadingFrom: url) {
            if let head = try? fh.read(upToCount: 10), let h = head, h.count == 10,
               h[0] == 0x49, h[1] == 0x44, h[2] == 0x33 {
                let size = synchsafeDecode(h, 6)
                let flags = h[5]
                audioStart = 10 + UInt64(size) + ((flags & 0x10) != 0 ? 10 : 0)
            }
            try? fh.close()
        }

        let tmp = url.deletingLastPathComponent().appendingPathComponent(url.lastPathComponent + ".tag")
        FileManager.default.createFile(atPath: tmp.path, contents: nil)
        guard let out = try? FileHandle(forWritingTo: tmp) else { return false }
        var header = Data([0x49, 0x44, 0x33, 0x04, 0x00, 0x00])
        header.append(synchsafeEncode(frames.count))
        out.write(header)
        out.write(frames)

        if let input = try? FileHandle(forReadingFrom: url) {
            try? input.seek(toOffset: audioStart)
            copyTail(from: input, to: out)
            try? input.close()
        }
        try? out.close()
        return replace(tmp: tmp, dst: url)
    }

    private static func textFrame(_ id: String, _ value: String) -> Data {
        let body = Data([0x03]) + Data(value.utf8)          // UTF-8
        var d = Data(id.utf8)
        d.append(synchsafeEncode(body.count))
        d.append(contentsOf: [0x00, 0x00])                  // frame flags
        d.append(body)
        return d
    }

    private static func usltFrame(_ lyric: String) -> Data {
        let body = Data([0x03]) + Data("chi".utf8) + Data([0x00]) + Data(lyric.utf8)
        var d = Data("USLT".utf8)
        d.append(synchsafeEncode(body.count))
        d.append(contentsOf: [0x00, 0x00])
        d.append(body)
        return d
    }

    private static func synchsafeDecode(_ d: Data, _ offset: Int) -> Int {
        let b = [UInt8](d)
        return (Int(b[offset] & 0x7F) << 21) | (Int(b[offset + 1] & 0x7F) << 14)
            | (Int(b[offset + 2] & 0x7F) << 7) | Int(b[offset + 3] & 0x7F)
    }

    private static func synchsafeEncode(_ v: Int) -> Data {
        Data([UInt8((v >> 21) & 0x7F), UInt8((v >> 14) & 0x7F),
              UInt8((v >> 7) & 0x7F), UInt8(v & 0x7F)])
    }

    // MARK: - FLAC

    private static func flac(_ url: URL, title: String, artist: String, album: String, lyric: String) throws -> Bool {
        guard let fh = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? fh.close() }

        guard let magicData = try? fh.read(upToCount: 4), let magic = magicData, magic.count == 4,
              magic[0] == 0x66, magic[1] == 0x4C, magic[2] == 0x61, magic[3] == 0x43 else { return false }

        var blocks: [Data] = []
        var vc: [(String, String)] = []
        var streamInfo: Data?
        var audioStart: UInt64 = 0
        let total = (try? fh.seekToEnd()) ?? 0
        var pos: UInt64 = 4

        while pos + 4 <= total {
            try? fh.seek(toOffset: pos)
            guard let headData = try? fh.read(upToCount: 4), let head = headData, head.count == 4 else { break }
            let h0 = head[0]
            let len = (Int(head[1]) << 16) | (Int(head[2]) << 8) | Int(head[3])
            guard let payloadData = try? fh.read(upToCount: len), let payload = payloadData else { break }
            let type = Int(h0 & 0x7F)
            let isLast = (h0 & 0x80) != 0
            if type == 0 {
                streamInfo = payload
            } else if type == 4 {
                vc = parseVorbis(payload)
            } else {
                var blk = Data([UInt8(type)])
                blk.append(contentsOf: [UInt8((len >> 16) & 0xFF), UInt8((len >> 8) & 0xFF), UInt8(len & 0xFF)])
                blk.append(payload)
                blocks.append(blk)
            }
            pos += UInt64(4 + len)
            audioStart = pos
            if isLast { break }
        }
        guard let si = streamInfo else { return false }

        var merged = vc.filter { $0.0 != "TOOL" }
        func put(_ k: String, _ v: String) {
            if v.isEmpty { return }
            merged.removeAll { $0.0 == k }
            merged.append((k, v))
        }
        put("TITLE", title)
        put("ARTIST", artist)
        put("ALBUM", album)
        put("LYRICS", lyric)
        put("TOOL", "NCM Downloader for iOS")

        var outBlocks: [Data] = [blockPayload(0, si), blockPayload(4, buildVorbis(merged))]
        outBlocks.append(contentsOf: blocks)

        let tmp = url.deletingLastPathComponent().appendingPathComponent(url.lastPathComponent + ".tag")
        FileManager.default.createFile(atPath: tmp.path, contents: nil)
        guard let out = try? FileHandle(forWritingTo: tmp) else { return false }
        out.write(Data([0x66, 0x4C, 0x61, 0x43]))
        for (i, blk) in outBlocks.enumerated() {
            var b = blk
            if i == outBlocks.count - 1 { b[0] = b[0] | 0x80 }
            out.write(b)
        }
        if let input = try? FileHandle(forReadingFrom: url) {
            try? input.seek(toOffset: audioStart)
            copyTail(from: input, to: out)
            try? input.close()
        }
        try? out.close()
        return replace(tmp: tmp, dst: url)
    }

    private static func blockPayload(_ type: Int, _ payload: Data) -> Data {
        var d = Data([UInt8(type), UInt8((payload.count >> 16) & 0xFF),
                      UInt8((payload.count >> 8) & 0xFF), UInt8(payload.count & 0xFF)])
        d.append(payload)
        return d
    }

    private static func parseVorbis(_ p: Data) -> [(String, String)] {
        var out: [(String, String)] = []
        let b = [UInt8](p)
        var off = 0
        guard b.count >= 8 else { return out }
        let vlen = Int(b[0]) | Int(b[1]) << 8 | Int(b[2]) << 16 | Int(b[3]) << 24
        off = 4 + vlen
        guard off + 4 <= b.count else { return out }
        let count = Int(b[off]) | Int(b[off + 1]) << 8 | Int(b[off + 2]) << 16 | Int(b[off + 3]) << 24
        off += 4
        for _ in 0..<max(0, count) {
            guard off + 4 <= b.count else { break }
            let len = Int(b[off]) | Int(b[off + 1]) << 8 | Int(b[off + 2]) << 16 | Int(b[off + 3]) << 24
            off += 4
            guard len >= 0, off + len <= b.count else { break }
            let str = String(bytes: b[off..<(off + len)], encoding: .utf8) ?? ""
            off += len
            if let eq = str.firstIndex(of: "=") {
                let k = String(str[str.startIndex..<eq]).uppercased()
                let v = String(str[str.index(after: eq)...])
                out.append((k, v))
            }
        }
        return out
    }

    private static func buildVorbis(_ kv: [(String, String)]) -> Data {
        var d = Data()
        let vendor = Data("NCMDownloader/1.4.0 (iOS)".utf8)
        d.append(le32(vendor.count))
        d.append(vendor)
        d.append(le32(kv.count))
        for (k, v) in kv {
            let line = Data((k + "=" + v).utf8)
            d.append(le32(line.count))
            d.append(line)
        }
        return d
    }

    private static func le32(_ v: Int) -> Data {
        Data([UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8((v >> 24) & 0xFF)])
    }

    // MARK: - IO

    private static func copyTail(from input: FileHandle, to out: FileHandle) {
        while true {
            guard let chunk = try? input.read(upToCount: 262_144), let data = chunk, !data.isEmpty else { break }
            out.write(data)
        }
    }

    private static func replace(tmp: URL, dst: URL) -> Bool {
        let fm = FileManager.default
        if (try? fm.removeItem(at: dst)) == nil {
            // 删除失败则直接覆盖写
            if let data = try? Data(contentsOf: tmp) {
                try? data.write(to: dst)
                try? fm.removeItem(at: tmp)
                return true
            }
            return false
        }
        do {
            try fm.moveItem(at: tmp, to: dst)
            return true
        } catch {
            return false
        }
    }
}
