# NcmDown iOS (unsigned IPA builder)

这个仓库只放 iOS 工程与出包工作流，用于在 GitHub Actions 的 macOS 机器上
无签名编译出 NcmDown-unsigned.ipa，再用 Sideloadly / AltStore 自签安装。

- ios/             Swift + WKWebView 原生工程
- .github/         macOS 构建流水线（CODE_SIGNING_ALLOWED=NO）
