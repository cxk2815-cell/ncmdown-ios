/* iOS 桥：在 app.js 之前加载，用 WKWebView 的 messageHandler 实现与 Android 相同的 Ncm API。 */
(function () {
  var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ncm;
  if (!handler) return;   // 非 iOS：保持 app.js 自己的 Ncm / mock 分支

  function post(obj) {
    try { handler.postMessage(obj); } catch (e) { }
  }

  var info = window.__IOS_INFO || {};

  window.Ncm = {
    http: function (id, method, url, headers, body) {
      post({
        action: 'http', id: id, method: method || 'GET', url: url,
        headers: headers || '{}', body: body == null ? null : String(body)
      });
    },
    enqueue: function (json) { post({ action: 'enqueue', json: json }); },
    stop: function () { post({ action: 'stop' }); },
    setConcurrency: function (n) { post({ action: 'setConcurrency', n: n }); },
    toast: function (m) { post({ action: 'toast', msg: m }); },
    openFolder: function () { post({ action: 'openFolder' }); },
    pref: function (k, d) { return (info.prefs && info.prefs[k]) || d || ''; },
    setPref: function (k, v) { post({ action: 'setPref', key: k, value: v }); },
    saveDir: function () { return info.saveDir || '「文件」→ 我的 iPhone → 网易云下载器 → Music'; },
    device: function () { return info.device || 'iPhone'; },
    version: function () { return info.version || '1.4.0'; }
  };
})();
