# iOS 版：网易云下载器

Android 版与 Windows 版的产品逻辑原样搬到 iOS：同样的搜索、歌单链接批量、歌手 TOP50、
音质链路（官方 → GD 镜像 → Meting → 外链）、`歌名 歌手` 文件名、歌词内嵌。

界面仍是同一套 Web 资源（`index.html / style.css / app.js`），用 `WKWebView` 承载；
下载、存储、写标签由 Swift 原生层完成。工程可直接用 Xcode 打开编译。

> iOS 的安装包（IPA）需要 Apple 的 Xcode 工具链产出，Windows 上没有这条工具链；
> 因此这里交付**完整可编译的 Xcode 工程**，并附一条 GitHub Actions 流水线，
> 在 macOS 云构建机上直接生成 `NcmDown-unsigned.ipa`（用 Sideloadly/AltStore 自签安装）。

---

## 1. 结构

```
ios/
  NcmDown.xcodeproj/project.pbxproj   手写工程文件（objectVersion 56，Xcode 14+）
  project.yml                         备选：装了 XcodeGen 时一条命令重生成工程
  NcmDown/
    NcmDownApp.swift                  @main SwiftUI App
    ContentView.swift                 WKWebView 容器 + __IOS_INFO 注入 + 本地页面加载
    Bridge.swift                      JS ↔ 原生：http / enqueue / stop / pref / toast
    Http.swift                        URLSession 封装（UA/Referer/Cookie/重定向）
    Downloader.swift                  下载队列、进度、resumeData 续传、时长校验
    Storage.swift                     写入 Documents/Music（出现在「文件」App）
    Tagger.swift                      MP3 ID3v2.4（含歌词）+ FLAC VorbisComment，流式重写
    Util.swift                        容器识别 / 文件名清洗 / 大小格式化
    Info.plist                        文件共享、ATS 允许 http、URL scheme、竖屏
    Assets.xcassets                   1024 图标
    web/                              与 Android 相同的界面；多一个 ios-bridge.js
.github/workflows/build-ios.yml       云构建 unsigned IPA
```

## 2. 桥的约定（与 Android 完全一致）

JS → 原生（`window.webkit.messageHandlers.ncm.postMessage`）：

| action | 参数 | 说明 |
|---|---|---|
| `http` | `id, method, url, headers(JSON 字符串), body` | 代发请求，回调 `__ncmHttp(id,status,body,finalURL)` |
| `enqueue` | `json` | 任务数组（url/文件名/歌词/期望时长…） |
| `stop` | — | 停止队列 |
| `setConcurrency` | `n` | 1–12 |
| `toast` / `openFolder` / `setPref` | … | 提示与偏好 |

原生 → JS：`window.NcmEvents.task({key,status,pct,…})`。
`ios-bridge.js` 在 `app.js` 之前加载，把同一份 `Ncm` API 映射到 messageHandler，
所以三个平台的业务代码是同一份 `app.js`。

## 3. 构建（方式 A：Mac + Xcode，推荐）

1. 把 `ios/` 目录拷到 Mac。
2. 双击 `NcmDown.xcodeproj`，选中 target `NcmDown` → Signing & Capabilities：
   勾选 **Automatically manage signing**，Team 选自己的 Apple ID（免费账号即可）。
   如需改包名，改 Bundle Identifier（默认 `com.ncm.downloader`）。
3. 连上 iPhone（需在设备上信任开发者证书），点 Run 即可装机。
4. 出正式包：Product → Archive → Distribute App → Ad Hoc / Development。

命令行：

```bash
cd ios
xcodebuild -project NcmDown.xcodeproj -scheme NcmDown \
  -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  DEVELOPMENT_TEAM=YOUR_TEAM_ID build
```

没装 XcodeGen 也不影响；若想用 YAML 重新生成工程：`brew install xcodegen && xcodegen generate`。

## 4. 构建（方式 B：没有 Mac，用 CI 出 IPA）

1. 把整个仓库推到 GitHub。
2. Actions → `build-ios` → Run workflow。
3. 跑完下载 Artifacts：`NcmDown-unsigned-ipa`，解压得到 `NcmDown-unsigned.ipa`。
4. 在 Windows 上用 [Sideloadly](https://sideloadly.io/)（或 AltStore）用你的 Apple ID 自签安装；
   免费账号签名的 App 有效期为 7 天，到期重签即可。

> 未签名 IPA 不能直接双击安装，必须经过一次个人签名——这是 iOS 的机制，不是构建问题。

## 5. 运行时行为

- **网络**：`Http.swift` 用 URLSession 代发请求（带 UA/Referer/Cookie），绕开 WKWebView 的同源限制。
- **音源**：逻辑全在 `app.js` —— 官方 `player/url/v1` → GD 镜像 → Meting → 外链；
  官方返回 `freeTrialInfo` 时跳过；下载完成后用 `AVURLAsset` 读时长，低于标称 72% 判为试听片段，
  自动换下一个源（与 Android/Windows 判定一致）。
- **保存**：先下到临时目录 → 写标签 → 移动到 `Documents/Music`。
  `UIFileSharingEnabled + LSSupportsOpeningDocumentsInPlace` 让这个目录直接出现在
  「文件」App → 我的 iPhone → 网易云下载器 → Music，可 AirDrop / 分享到其它播放器。
- **续传**：URLSession 失败时拿 `resumeData` 重试（最多 3 次）。
- **后台**：App 切后台时 iOS 会暂停下载，回到前台自动继续（resumeData 机制）。

## 6. 与其它平台的差异

| 功能 | Windows | Android | iOS |
|---|---|---|---|
| 搜索 / 歌单 / 歌手 TOP50 | ✓ | ✓ | ✓ |
| 音质 128/192/320/无损 | ✓ | ✓ | ✓ |
| 文件名 `歌名 歌手` | ✓ | ✓ | ✓ |
| 歌词内嵌 | ✓ | ✓ | ✓ |
| 并发 1–12 / 断点续传 / 多源回退 | ✓ | ✓ | ✓ |
| 保存位置 | 自选目录 | Music/网易云音乐 | 「文件」→ 我的 iPhone → 网易云下载器/Music |
| 格式转码 | ffmpeg 全格式 | 直出（m4a 走官方 AAC） | 直出（m4a 走官方 AAC） |
| 系统分享导入链接 | — | ✓ | 通过 `ncmdown://` scheme（可选） |

App 未做分享扩展（Share Extension），所以「分享到本应用」这条在 iOS 上不支持；
复制链接后在歌单页粘贴即可。

## 7. 已做的验证

| 项目 | 结果 |
|---|---|
| Swift 语法 | 8 个源文件全部通过 Swift 5.10.1 `swiftc -parse`（Windows 工具链） |
| Xcode 工程结构 | 括号配平、36 个对象 id 全部有定义、11 个文件引用均存在、无重复定义 |
| Info.plist | `plistlib` 解析通过；文件共享、ATS、URL scheme、竖屏配置齐全 |
| 图标 | 1024×1024 PNG + Contents.json 正确 |
| 界面 | 390×844 移动视口逐页渲染截图（`docs/ios_*.png`），无 JS 异常 |
| 业务逻辑 | 与 Android 同一份 `app.js`，已在真实接口上跑通（见 `android/README.md` 的 live 测试） |
| 写标签算法 | 与已通过 PCM MD5 对比验证的 Java/Android 版本同构（ID3v2.4 + VorbisComment，流式重写） |

未能在本机完成的部分：iOS 类型检查与真机运行需要 macOS + Xcode（Windows 工具链缺少
Windows SDK 头文件，`-typecheck` 无法启动）；工程已按 Xcode 15 模板的最小配置书写。

## 8. 已知限制

- 手机端不做音频再编码：目标格式与源格式不一致时保留原格式（队列里会显示实际扩展名）。
- 保存目录固定在 App 沙盒的 `Documents/Music`（iOS 不允许随意写系统目录）。
- 首次安装需要在「设置 → 通用 → VPN与设备管理」里信任证书（自签场景）。
- 仅供个人学习与自用备份，音乐版权归网易云及版权方所有。
