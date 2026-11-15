/* 网易云下载器 · Android 前端
   逻辑与桌面版一致：官方接口 → GD 镜像 → Meting → 外链，逐个尝试；
   下载/保存/写标签交给 Java 层。 */
(function () {
  'use strict';

  /* ============================================================
     1. 与 Java 的桥
     ============================================================ */
  var B = (typeof Ncm !== 'undefined' && Ncm) ? Ncm : null;
  var httpSeq = 0;
  var httpWait = new Map();

  window.__ncmHttp = function (id, status, body, url) {
    var cb = httpWait.get(id);
    if (cb) { httpWait.delete(id); cb({ status: status, body: body || '', url: url || '' }); }
  };

  function http(method, url, headers, body) {
    if (!B) return mockHttp(method, url, headers, body);
    var id = ++httpSeq;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        httpWait.delete(id); reject(new Error('网络超时'));
      }, 40000);
      httpWait.set(id, function (r) { clearTimeout(timer); resolve(r); });
      try {
        B.http(id, method, url, JSON.stringify(headers || {}), body == null ? null : String(body));
      } catch (e) {
        clearTimeout(timer); httpWait.delete(id); reject(e);
      }
    });
  }

  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('show'); }, 1800);
  }

  /* ============================================================
     2. 配置
     ============================================================ */
  var DEFAULTS = {
    quality: 'auto', fmt: 'auto', naming: '{title} {artist}',
    concurrency: 6, lyric: true, cookie: '', autoDl: true
  };
  var CFG = Object.assign({}, DEFAULTS, safeParse(localStorage.getItem('ncm.cfg')));

  function safeParse(s) { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } }
  function saveCfg() {
    try { localStorage.setItem('ncm.cfg', JSON.stringify(CFG)); } catch (e) {}
    if (B && B.setPref) { try { B.setPref('cfg', JSON.stringify(CFG)); } catch (e) {} }
  }

  /* ============================================================
     3. 接口层
     ============================================================ */
  function headers(extra) {
    var h = { 'Referer': 'https://music.163.com/', 'Accept': '*/*' };
    if (CFG.cookie) h['Cookie'] = CFG.cookie;
    return Object.assign(h, extra || {});
  }

  async function postForm(url, form) {
    var r = await http('POST', url, headers({ 'Content-Type': 'application/x-www-form-urlencoded' }), form);
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    return safeParse(r.body);
  }

  async function getText(url) {
    var r = await http('GET', url, headers({}), null);
    return r.body;
  }

  function normalizeSong(raw) {
    if (!raw) return null;
    var sid = raw.id || raw.songId;
    if (!sid) return null;
    var ar = raw.ar || raw.artists || raw.artist || [];
    if (!Array.isArray(ar)) ar = [ar];
    var names = ar.map(function (a) { return (a && a.name) || (typeof a === 'string' ? a : ''); })
      .filter(function (x) { return x; });
    var al = raw.al || raw.album || {};
    if (typeof al === 'string') al = { name: al };
    var priv = raw.privilege || {};
    var fee = (raw.fee == null ? (priv.fee || 0) : raw.fee);
    var maxbr = priv.maxbr || raw.maxbr || 0;
    var dur = raw.dt || raw.duration || 0;
    return {
      id: sid,
      title: raw.name || raw.title || '',
      artist: names.join('、') || '未知歌手',
      album: al.name || '',
      duration: dur,
      durationText: fmtDur(dur),
      fee: fee,
      vip: fee === 1 || fee === 4 || fee === 8,
      maxbr: maxbr,
      sq: !!(raw.sq || raw.sqMusic),
      hr: !!(raw.hr || raw.hrMusic),
      hires: !!(raw.hires || raw.hiresMusic),
      maxLevel: priv.maxBrLevel || ''
    };
  }

  function fmtDur(ms) {
    var s = Math.floor((ms || 0) / 1000);
    var m = Math.floor(s / 60);
    return (m < 10 ? '0' : '') + m + ':' + ((s % 60) < 10 ? '0' : '') + (s % 60);
  }

  function qualityLabel(s) {
    if (s.hires) return 'Hi-Res';
    if (s.hr) return '母带';
    if (s.sq) return '无损';
    if (s.maxbr >= 900000) return '无损';
    if (s.maxbr >= 320000 || s.maxLevel === 'exhigh' || s.maxLevel === 'lossless' || s.maxLevel === 'jymaster') return '320K';
    if (s.maxbr >= 192000 || s.maxLevel === 'higher') return '192K';
    if (s.maxbr) return '128K';
    return '—';
  }

  async function apiSearch(kw, limit, offset) {
    var form = 's=' + encodeURIComponent(kw) + '&type=1&limit=' + limit + '&offset=' + offset + '&total=true';
    var hosts = ['interface.music.163.com', 'music.163.com', 'interface3.music.163.com'];
    var lastErr = null;
    for (var i = 0; i < hosts.length; i++) {
      try {
        var j = await postForm('https://' + hosts[i] + '/api/cloudsearch/pc', form);
        var res = j.result || {};
        var songs = (res.songs || []).map(normalizeSong).filter(Boolean);
        if (songs.length || res.songCount) {
          return { songs: songs, count: res.songCount || songs.length };
        }
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('搜索失败');
  }

  async function apiPlaylist(pid) {
    var urls = [
      'https://music.163.com/api/v6/playlist/detail?id=' + pid + '&n=1000',
      'https://interface.music.163.com/api/v6/playlist/detail?id=' + pid + '&n=1000',
      'https://music.163.com/api/playlist/detail?id=' + pid + '&n=1000'
    ];
    var meta = null;
    for (var i = 0; i < urls.length; i++) {
      try {
        var body = await getText(urls[i]);
        var j = safeParse(body);
        var pl = j.playlist || j.result;
        if (!pl || !(pl.name || pl.trackIds || pl.tracks)) continue;
        meta = {
          id: pl.id || pid,
          name: pl.name || ('歌单' + pid),
          creator: (pl.creator && pl.creator.nickname) || '',
          count: pl.trackCount || 0,
          trackIds: (pl.trackIds || []).map(function (t) { return t.id; }).filter(Boolean),
          songs: (pl.tracks || []).map(normalizeSong).filter(Boolean)
        };
        break;
      } catch (e) {}
    }
    if (!meta) throw new Error('歌单不存在，或私密歌单需要先填 Cookie');
    if (meta.trackIds.length > meta.songs.length) {
      var need = meta.trackIds.filter(function (id) {
        return !meta.songs.some(function (s) { return s.id === id; });
      });
      var extra = await apiDetails(need.slice(0, 500));
      meta.songs = meta.songs.concat(extra);
    }
    var order = {};
    meta.trackIds.forEach(function (id, i) { order[id] = i; });
    meta.songs.sort(function (a, b) { return (order[a.id] == null ? 1e9 : order[a.id]) - (order[b.id] == null ? 1e9 : order[b.id]); });
    return meta;
  }

  async function apiDetails(ids) {
    var out = [];
    for (var i = 0; i < ids.length; i += 200) {
      var chunk = ids.slice(i, i + 200);
      try {
        var body = await getText('https://music.163.com/api/song/detail?ids=' + encodeURIComponent(JSON.stringify(chunk)));
        var j = safeParse(body);
        (j.songs || []).forEach(function (raw) {
          var privs = (j.privileges || []).find(function (p) { return p.id === raw.id; });
          if (privs && !raw.privilege) raw.privilege = privs;
          var s = normalizeSong(raw); if (s) out.push(s);
        });
      } catch (e) {}
    }
    return out;
  }

  async function apiArtistTop(aid) {
    var body = await getText('https://music.163.com/api/artist/top/song?id=' + aid);
    var j = safeParse(body);
    return (j.songs || []).map(normalizeSong).filter(Boolean);
  }

  async function apiLyric(id) {
    try {
      var body = await getText('https://music.163.com/api/song/lyric?id=' + id + '&lv=-1&kv=-1&tv=-1&rv=-1');
      var j = safeParse(body);
      var lrc = (j.lrc && j.lrc.lyric) || (j.lyric && j.lyric.lyric) || '';
      var tr = (j.tlyric && j.tlyric.lyric) || '';
      lrc = lrc.trim();
      return tr.trim() ? (lrc + '\n\n' + tr.trim()) : lrc;
    } catch (e) { return ''; }
  }

  function parsePlaylistId(text) {
    if (!text) return null;
    text = String(text).trim();
    if (/^\d+$/.test(text)) return parseInt(text, 10);
    var m = text.match(/playlist[/?=&]?(?:id=)?(\d+)/) || text.match(/[?&]id=(\d+)/) || text.match(/(\d{5,})/);
    return m ? parseInt(m[1], 10) : null;
  }

  /** 短链（163cn.tv / 163cn.com）需要先跟随跳转再取 ID。 */
  async function resolvePlaylistRef(text) {
    text = String(text || '').trim();
    var id = parsePlaylistId(text);
    var urlMatch = text.match(/https?:\/\/[^\s，。、）)\]】"']+/);
    if (id && !/163cn\.(tv|com)/.test(text)) return id;
    if (!urlMatch) return id;
    try {
      var r = await http('GET', urlMatch[0], headers({}), null);
      var fromUrl = parsePlaylistId(r.url || '');
      if (fromUrl) return fromUrl;
      var body = (r.body || '').slice(0, 6000);
      var m2 = body.match(/playlist\?id=(\d+)/) || body.match(/playlistId["':\s]+(\d+)/)
        || body.match(/orpheus:\/\/[a-z]+\/(\d+)/);
      if (m2) return parseInt(m2[1], 10);
    } catch (e) { /* 跟随失败就用原解析结果 */ }
    return id;
  }

  /* ============================================================
     4. 音源解析（官方 → 镜像 → Meting → 外链）
     ============================================================ */
  var LEVEL_PLAN = {
    '128': ['standard'], '192': ['higher'], '320': ['exhigh'],
    'lossless': ['lossless', 'exhigh'], 'auto': ['lossless', 'exhigh']
  };

  async function officialCandidate(song, level, enc) {
    try {
      var form = 'ids=' + encodeURIComponent(JSON.stringify([song.id]))
        + '&level=' + level + '&encodeType=' + enc;
      var j = await postForm('https://interface.music.163.com/api/song/enhance/player/url/v1', form);
      var d = (j.data || [])[0];
      if (!d || !d.url) return null;
      if (d.freeTrialInfo) return { trial: true };
      return {
        url: d.url, ext: (d.type || (enc === 'flac' ? 'flac' : 'mp3')).toLowerCase(),
        size: d.size || 0, br: d.br || 0, provider: '官方', level: d.level || level
      };
    } catch (e) { return null; }
  }

  async function gdCandidate(song, quality) {
    try {
      var br = quality === 'lossless' || quality === 'auto' ? 999 : parseInt(quality === '320' ? '320' : quality, 10);
      var u = 'https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=' + song.id + '&br=' + br;
      var body = await getText(u);
      var j = safeParse(body);
      if (!j.url) return null;
      var ext = '';
      var path = String(j.url).split('?')[0].toLowerCase();
      ['flac', 'mp3', 'm4a'].forEach(function (e) { if (path.endsWith('.' + e)) ext = e; });
      var rawBr = j.br || 0;
      return {
        url: j.url, ext: ext, size: j.size || 0,
        br: rawBr < 10000 ? rawBr * 1000 : rawBr,
        provider: 'GD镜像', level: ext === 'flac' ? 'lossless' : 'exhigh'
      };
    } catch (e) { return null; }
  }

  function metingCandidate(song) {
    return { url: 'https://api.injahow.cn/meting/?type=url&id=' + song.id, ext: '', size: 0, provider: 'Meting' };
  }

  function outerCandidate(song) {
    return { url: 'https://music.163.com/song/media/outer/url?id=' + song.id + '.mp3', ext: 'mp3', size: 0, provider: '外链' };
  }

  async function buildCandidates(song, quality, fmt) {
    var list = [];
    var plan = LEVEL_PLAN[quality] || LEVEL_PLAN.auto;
    var seen = {};
    function push(c) {
      if (!c || !c.url || seen[c.url]) return;
      seen[c.url] = 1; list.push(c);
    }
    for (var i = 0; i < plan.length; i++) {
      var level = plan[i];
      var enc = (fmt === 'm4a' || fmt === 'aac') ? 'aac' : (level === 'lossless' ? 'flac' : 'mp3');
      var r = await officialCandidate(song, level, enc);
      if (r && r.trial) continue;
      if (r) push(r);
      if (quality !== 'lossless' && quality !== 'auto' && r) break;
    }
    var gd = await gdCandidate(song, quality);
    if (gd) push(gd);
    push(metingCandidate(song));
    push(outerCandidate(song));
    return list;
  }

  /* ============================================================
     5. 队列
     ============================================================ */
  var seq = 0;
  var tasks = new Map();
  var order = [];
  var resolverBusy = 0;

  window.NcmEvents = {
    task: function (o) { onTask(o); },
    share: function (url) {
      showPage('crawl');
      var el = document.getElementById('plink');
      el.value = url;
      setTimeout(function () { fetchPlaylist(url); }, 120);
    },
    back: function () { return false; }
  };

  function enqueue(songs) {
    if (!songs.length) { toast('先选歌'); return; }
    songs.forEach(function (s) {
      var key = 't' + (++seq);
      var t = {
        key: key, song: s, status: 'wait', pct: 0, cands: null,
        idx: 0, note: '', size: 0, path: '', lyric: ''
      };
      tasks.set(key, t); order.push(key);
    });
    renderQueue(); updateStats();
    toast('已加入队列 ' + songs.length + ' 首');
    pumpResolvers();
  }

  function pumpResolvers() {
    if (resolverBusy >= 3) return;
    var next = null;
    for (var i = 0; i < order.length; i++) {
      var t = tasks.get(order[i]);
      if (t && t.status === 'wait' && !t.cands) { next = t; break; }
    }
    if (!next) return;
    resolverBusy++;
    next.status = 'resolving'; renderQueue();
    (async function (t) {
      try {
        if (CFG.lyric) t.lyric = await apiLyric(t.song.id);
        t.cands = await buildCandidates(t.song, CFG.quality, CFG.fmt);
        if (!t.cands.length) { t.status = 'fail'; t.note = '无可用音源'; }
        else { sendTask(t); }
      } catch (e) {
        t.status = 'fail'; t.note = String(e.message || e);
      }
      resolverBusy--;
      renderQueue(); updateStats();
      setTimeout(pumpResolvers, 80);
    })(next);
  }

  function sendTask(t) {
    var c = t.cands[t.idx];
    if (!c) { t.status = 'fail'; t.note = '无可用音源'; renderQueue(); return; }
    t.status = 'downloading'; t.pct = 0; t.note = c.provider;
    renderQueue();
    var payload = {
      key: t.key, url: c.url, ext: c.ext || '', size: c.size || 0,
      expectedMs: t.song.duration || 0,
      filename: buildName(t.song, CFG.naming),
      lyric: CFG.lyric ? (t.lyric || '') : '',
      cookie: CFG.cookie || '',
      title: t.song.title, artist: t.song.artist, album: t.song.album,
      tag: true
    };
    if (B && B.setConcurrency) { try { B.setConcurrency(CFG.concurrency); } catch (e) {} }
    if (!B) { mockDownload(t); return; }
    try { B.enqueue(JSON.stringify([payload])); }
    catch (e) { t.status = 'fail'; t.note = '启动下载失败'; renderQueue(); }
  }

  function onTask(o) {
    var t = tasks.get(o.key);
    if (!t) return;
    if (o.status === 'start') { t.status = 'downloading'; t.pct = 0; }
    else if (o.status === 'progress') {
      t.status = 'downloading';
      t.pct = o.pct || 0;
      t.size = o.total || t.size;
    } else if (o.status === 'retry' || o.status === 'fail') {
      t.idx++;
      if (t.cands && t.idx < t.cands.length) { sendTask(t); return; }
      t.status = 'fail';
      t.note = (o.message || '下载失败') + (o.status === 'retry' ? '（无备用音源）' : '');
    } else if (o.status === 'done') {
      t.status = 'done'; t.pct = 100;
      t.size = o.size || t.size;
      t.path = o.path || '';
      t.note = (t.note ? t.note + ' · ' : '') + (o.ext ? o.ext.toUpperCase() : '');
    } else if (o.status === 'cancel') {
      t.status = 'cancel'; t.note = '已取消';
    }
    renderQueue(); updateStats();
  }

  function stopAll() {
    if (B) { try { B.stop(); } catch (e) {} }
    tasks.forEach(function (t) {
      if (t.status !== 'done' && t.status !== 'fail') { t.status = 'cancel'; t.note = '已停止'; }
    });
    renderQueue(); updateStats();
    toast('已停止');
  }

  function clearQueue() {
    tasks.clear(); order = [];
    renderQueue(); updateStats();
  }

  function updateStats() {
    var done = 0, fail = 0, wait = 0;
    tasks.forEach(function (t) {
      if (t.status === 'done') done++;
      else if (t.status === 'fail') fail++;
      else if (t.status !== 'cancel') wait++;
    });
    document.getElementById('statDone').textContent = done;
    document.getElementById('statFail').textContent = fail;
    document.getElementById('statWait').textContent = wait;
    var badge = document.getElementById('badge');
    if (wait > 0) { badge.hidden = false; badge.textContent = wait > 99 ? '99+' : wait; }
    else badge.hidden = true;
    var st = document.getElementById('statusText'), dot = document.getElementById('dot');
    if (wait > 0) { st.textContent = '下载中 ' + wait; dot.classList.add('busy'); }
    else { st.textContent = done || fail ? '完成' : '就绪'; dot.classList.remove('busy'); }
  }

  /* ============================================================
     6. 渲染
     ============================================================ */
  var searchState = { songs: [], page: 1, total: 0, sel: new Set() };
  var crawlState = { songs: [], sel: new Set(), id: null, title: '' };

  function songNode(s, index, sel, onToggle) {
    var el = document.createElement('div');
    el.className = 'song' + (sel.has(s.id) ? ' sel' : '');
    var q = qualityLabel(s);
    el.innerHTML =
      '<div class="idx">' + index + '</div>' +
      '<div class="body">' +
        '<div class="t"></div>' +
        '<div class="s"></div>' +
        '<div class="tags"></div>' +
      '</div>' +
      '<div class="check">' + (sel.has(s.id) ? '✓' : '') + '</div>';
    el.querySelector('.t').textContent = s.title;
    el.querySelector('.s').textContent = s.artist + (s.album ? ' · ' + s.album : '') + ' · ' + s.durationText;
    var tags = el.querySelector('.tags');
    if (q && q !== '—') {
      var tag = document.createElement('span');
      tag.className = 'tag q'; tag.textContent = q; tags.appendChild(tag);
    }
    if (s.vip) {
      var vip = document.createElement('span');
      vip.className = 'tag vip'; vip.textContent = 'VIP'; tags.appendChild(vip);
    }
    el.addEventListener('click', function () {
      if (sel.has(s.id)) sel.delete(s.id); else sel.add(s.id);
      el.classList.toggle('sel');
      el.querySelector('.check').textContent = sel.has(s.id) ? '✓' : '';
      updateActionBar();
    });
    return el;
  }

  function renderSearch() {
    var box = document.getElementById('searchList');
    var empty = document.getElementById('searchEmpty');
    box.innerHTML = '';
    if (!searchState.songs.length) { empty.hidden = false; return; }
    empty.hidden = true;
    searchState.songs.forEach(function (s, i) {
      box.appendChild(songNode(s, i + 1, searchState.sel));
    });
    updateActionBar();
  }

  function renderCrawl() {
    var box = document.getElementById('crawlList');
    box.innerHTML = '';
    crawlState.songs.forEach(function (s, i) {
      box.appendChild(songNode(s, i + 1, crawlState.sel));
    });
    updateActionBar();
  }

  var TASK_LABEL = {
    wait: '排队中', resolving: '解析中', downloading: '下载中',
    done: '已完成', fail: '失败', cancel: '已取消'
  };

  function renderQueue() {
    var box = document.getElementById('taskList');
    var empty = document.getElementById('queueEmpty');
    box.innerHTML = '';
    if (!order.length) { empty.hidden = false; return; }
    empty.hidden = true;
    order.slice().reverse().forEach(function (k) {
      var t = tasks.get(k); if (!t) return;
      var el = document.createElement('div');
      el.className = 'task' + (t.status === 'done' ? ' done' : t.status === 'fail' ? ' fail' : '');
      var pct = t.status === 'done' ? 100 : (t.pct || 0);
      var sub = t.status === 'fail' ? (t.note || '失败')
        : t.status === 'done' ? (t.path || (t.note || ''))
          : [t.note, t.size ? fmtSize(t.size) : ''].filter(Boolean).join(' · ');
      el.innerHTML =
        '<div class="top"><div class="name"></div><div class="st">' + (TASK_LABEL[t.status] || '') + '</div></div>' +
        '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
        '<div class="sub"></div>';
      el.querySelector('.name').textContent = t.song.title;
      el.querySelector('.sub').textContent = sub;
      box.appendChild(el);
    });
  }

  function fmtSize(n) {
    if (!n) return '';
    if (n < 1024 * 1024) return Math.round(n / 1024) + 'KB';
    return (n / 1048576).toFixed(1) + 'MB';
  }

  function updateActionBar() {
    var n = currentSel().size;
    var btn = document.getElementById('btnDownload');
    btn.textContent = '下载选中 (' + n + ')';
    btn.disabled = n === 0;
  }

  function currentSel() {
    return activePage === 'crawl' ? crawlState.sel : searchState.sel;
  }
  function currentSongs() {
    return activePage === 'crawl' ? crawlState.songs : searchState.songs;
  }

  /* ============================================================
     7. 交互
     ============================================================ */
  var activePage = 'search';
  var crawlMode = 'playlist';

  function showPage(name) {
    activePage = name;
    ['search', 'crawl', 'queue', 'settings'].forEach(function (p) {
      var el = document.getElementById('page-' + p);
      if (el) el.hidden = (p !== name);
    });
    document.querySelectorAll('.tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.page === name);
    });
    document.getElementById('actionbar').classList.toggle('show', name === 'search' || name === 'crawl');
    if (name === 'queue') renderQueue();
    updateActionBar();
    document.getElementById('scroller').scrollTop = 0;
  }

  async function doSearch() {
    var kw = document.getElementById('kw').value.trim();
    if (!kw) { toast('输入歌名或歌手'); return; }
    var meta = document.getElementById('searchMeta');
    meta.textContent = '搜索中…';
    document.getElementById('searchList').innerHTML = '<div class="loading"><span class="spinner"></span>正在搜索</div>';
    try {
      var limit = 30;
      var res = await apiSearch(kw, limit, (searchState.page - 1) * limit);
      searchState.songs = res.songs;
      searchState.total = res.count;
      searchState.sel.clear();
      meta.textContent = '共 ' + res.count + ' 条 · 第 ' + searchState.page + ' 页';
      document.getElementById('pageNo').textContent = searchState.page;
      renderSearch();
    } catch (e) {
      meta.textContent = '搜索失败';
      document.getElementById('searchList').innerHTML = '<div class="loading">' + (e.message || '网络异常') + '</div>';
    }
  }

  async function fetchPlaylist(ref) {
    var id = await resolvePlaylistRef(ref);
    if (!id) { toast('链接里没识别到歌单 ID'); return; }
    var title = document.getElementById('crawlTitle');
    title.textContent = '拉取中…';
    document.getElementById('crawlList').innerHTML = '<div class="loading"><span class="spinner"></span>正在拉取歌单</div>';
    try {
      var meta = await apiPlaylist(id);
      crawlState.id = id;
      crawlState.title = meta.name;
      crawlState.songs = meta.songs;
      crawlState.sel.clear();
      title.textContent = (meta.creator ? meta.name + ' · ' + meta.creator : meta.name) + ' · ' + meta.songs.length + ' 首';
      renderCrawl();
      toast('已拉取 ' + meta.songs.length + ' 首');
      if (document.getElementById('autoDl').checked && meta.songs.length) {
        enqueue(meta.songs.slice());
      }
    } catch (e) {
      title.textContent = '拉取失败';
      document.getElementById('crawlList').innerHTML = '<div class="loading">' + (e.message || '网络异常') + '</div>';
    }
  }

  function buildName(s, tpl) {
    var t = tpl || '{title} {artist}';
    var out = t.replace(/\{title\}/g, s.title || '').replace(/\{artist\}/g, s.artist || '')
      .replace(/\{album\}/g, s.album || '').replace(/\{quality\}/g, qualityLabel(s))
      .replace(/\{id\}/g, s.id || '').replace(/\{index\}/g, '');
    out = out.replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    return out || String(s.id);
  }

  /* ============================================================
     8. 设置界面
     ============================================================ */
  function initSettings() {
    document.getElementById('setQuality').value = CFG.quality;
    document.getElementById('setFmt').value = CFG.fmt;
    document.getElementById('setNaming').value = CFG.naming;
    document.getElementById('setConc').value = CFG.concurrency;
    document.getElementById('concVal').textContent = CFG.concurrency;
    document.getElementById('setLyric').checked = !!CFG.lyric;
    document.getElementById('setCookie').value = CFG.cookie || '';
    document.getElementById('autoDl').checked = CFG.autoDl !== false;
    document.getElementById('saveDir').textContent = (B && B.saveDir) ? B.saveDir() : '内部存储/Music/网易云音乐';
    document.getElementById('deviceInfo').textContent = (B && B.device) ? B.device() : '预览模式';
    document.getElementById('verInfo').textContent = 'v' + ((B && B.version) ? B.version() : '1.4.0');
    namingHint();

    document.getElementById('setQuality').onchange = function () { CFG.quality = this.value; saveCfg(); };
    document.getElementById('setFmt').onchange = function () { CFG.fmt = this.value; saveCfg(); };
    document.getElementById('setNaming').oninput = function () { CFG.naming = this.value; saveCfg(); namingHint(); };
    document.getElementById('setConc').oninput = function () {
      CFG.concurrency = parseInt(this.value, 10) || 6;
      document.getElementById('concVal').textContent = CFG.concurrency;
      saveCfg();
      if (B && B.setConcurrency) { try { B.setConcurrency(CFG.concurrency); } catch (e) {} }
    };
    document.getElementById('setLyric').onchange = function () { CFG.lyric = this.checked; saveCfg(); };
    document.getElementById('autoDl').onchange = function () { CFG.autoDl = this.checked; saveCfg(); };
    document.getElementById('btnClearCookie').onclick = function () {
      document.getElementById('setCookie').value = '';
      CFG.cookie = ''; saveCfg(); toast('已清空，记得点保存');
    };
    document.getElementById('btnSaveCookie').onclick = function () {
      CFG.cookie = document.getElementById('setCookie').value.trim();
      saveCfg(); toast(CFG.cookie ? 'Cookie 已保存' : 'Cookie 已清空');
    };
    document.getElementById('btnSelftest').onclick = selftest;
    document.getElementById('btnAbout').onclick = function () {
      toast('网易云下载器 v1.4.0 · 歌单批量 / 多音质 / 歌词内嵌');
    };
  }

  function namingHint() {
    var demo = buildName({ title: '演员', artist: '薛之谦', album: '绅士', id: 1 }, CFG.naming);
    document.getElementById('namingHint').textContent = '例：' + demo + '.mp3';
  }

  async function selftest() {
    toast('正在自检…');
    var lines = [];
    try {
      var r = await apiSearch('晴天', 1, 0);
      lines.push('搜索接口：正常（' + r.count + ' 条）');
    } catch (e) { lines.push('搜索接口：异常 ' + e.message); }
    try {
      var c = await officialCandidate({ id: 2076488356 }, 'exhigh', 'mp3');
      lines.push(c && c.url ? '播放地址：正常' : '播放地址：无直链');
    } catch (e) { lines.push('播放地址：异常'); }
    lines.push('保存目录：' + ((B && B.saveDir) ? B.saveDir() : '预览模式'));
    lines.push('Cookie：' + (CFG.cookie ? '已配置' : '未配置'));
    alert(lines.join('\n'));
  }

  /* ============================================================
     9. 启动
     ============================================================ */
  async function fetchArtist(ref) {
    var text = String(ref || '').trim();
    var id = null;
    var m = text.match(/artist[/?=&]?(?:id=)?(\d+)/) || text.match(/[?&]id=(\d+)/);
    if (m) id = parseInt(m[1], 10);
    else if (/^\d+$/.test(text)) id = parseInt(text, 10);
    if (!id) { toast('请粘贴歌手主页链接或歌手 ID'); return; }
    var title = document.getElementById('crawlTitle');
    title.textContent = '拉取中…';
    document.getElementById('crawlList').innerHTML = '<div class="loading"><span class="spinner"></span>正在拉取歌手歌曲</div>';
    try {
      var songs = await apiArtistTop(id);
      crawlState.id = null; crawlState.title = '歌手 ' + id; crawlState.songs = songs; crawlState.sel.clear();
      title.textContent = '歌手 ' + id + ' · 热门 ' + songs.length + ' 首';
      renderCrawl();
      toast('已拉取 ' + songs.length + ' 首');
      if (document.getElementById('autoDl').checked && songs.length) enqueue(songs.slice());
    } catch (e) {
      title.textContent = '拉取失败';
      document.getElementById('crawlList').innerHTML = '<div class="loading">' + (e.message || '网络异常') + '</div>';
    }
  }

  function setCrawlMode(mode) {
    crawlMode = mode;
    document.querySelectorAll('.mode').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    document.getElementById('plink').placeholder =
      mode === 'artist' ? '歌手主页链接 / 歌手 ID' : '分享链接 / 歌单 ID';
    document.getElementById('crawlHint').textContent = mode === 'artist'
      ? '粘贴歌手主页链接，或直接填歌手 ID（例如 6452）'
      : '支持 music.163.com/#/playlist?id=… 、y.music.163.com、163cn.tv 短链、整段分享文案';
  }

  function doFetch() {
    var val = document.getElementById('plink').value;
    if (crawlMode === 'artist') fetchArtist(val); else fetchPlaylist(val);
  }

  function bind() {
    document.querySelectorAll('.tab').forEach(function (b) {
      b.onclick = function () { showPage(b.dataset.page); };
    });
    document.getElementById('btnSearch').onclick = doSearch;
    document.getElementById('kw').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); this.blur(); doSearch(); }
    });
    document.getElementById('btnFetch').onclick = doFetch;
    document.getElementById('plink').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); this.blur(); doFetch(); }
    });
    document.querySelectorAll('.mode').forEach(function (b) {
      b.onclick = function () { setCrawlMode(b.dataset.mode); };
    });
    document.getElementById('quickCharts').addEventListener('click', function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      setCrawlMode('playlist');
      document.getElementById('plink').value = b.dataset.pid;
      fetchPlaylist(b.dataset.pid);
    });
    document.getElementById('prevPage').onclick = function () {
      if (searchState.page <= 1) return;
      searchState.page--; doSearch();
    };
    document.getElementById('nextPage').onclick = function () {
      if (searchState.songs.length < 30) { toast('没有下一页了'); return; }
      searchState.page++; doSearch();
    };
    document.getElementById('btnSelectAll').onclick = function () {
      var sel = currentSel(), songs = currentSongs();
      var all = songs.length > 0 && songs.every(function (s) { return sel.has(s.id); });
      sel.clear();
      if (!all) songs.forEach(function (s) { sel.add(s.id); });
      renderSearch(); renderCrawl();
    };
    document.getElementById('btnDownload').onclick = function () {
      var sel = currentSel(), songs = currentSongs();
      var picked = songs.filter(function (s) { return sel.has(s.id); });
      if (!picked.length) { toast('先选歌'); return; }
      enqueue(picked);
      sel.clear();
      renderSearch(); renderCrawl();
    };
    document.getElementById('btnStop').onclick = stopAll;
    document.getElementById('btnClear').onclick = clearQueue;
  }

  document.addEventListener('DOMContentLoaded', function () {
    bind();
    initSettings();
    showPage('search');
  });
  // WebView 里 DOMContentLoaded 可能已触发
  if (document.readyState !== 'loading') {
    bind(); initSettings(); showPage('search');
  }

  /* ============================================================
     10. 浏览器预览用的假数据（APK 内不会走到）
     ============================================================ */
  var MOCK = {
    晴天: [
      { id: 2668397359, title: '晴天 (原唱 周杰伦)', artists: [{ name: 'RyaVocal' }], album: { name: '晴天' }, duration: 270000, fee: 8, sq: {}, hr: {} },
      { id: 3439604863, title: '晴天（史詩版）', artists: [{ name: 'GYBeat' }], album: { name: '晴天 (女声版)' }, duration: 268000, fee: 8, sq: {} },
      { id: 2076488356, title: '晴天', artists: [{ name: '梦想里啥都有' }], album: { name: '晴天' }, duration: 228000, fee: 0 },
      { id: 1945894789, title: '晴天 (钢琴版)', artists: [{ name: '纪钧瀚' }], album: { name: '钢琴放松音乐' }, duration: 236000, fee: 1, sq: {}, hr: {} },
      { id: 3379716579, title: '晴天 (R&B版)', artists: [{ name: '温栗' }], album: { name: '晴天合集' }, duration: 214000, fee: 0 }
    ]
  };

  function mockHttp(method, url, headers, body) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        if (url.indexOf('cloudsearch') >= 0) {
          var kw = decodeURIComponent((body || '').replace(/^.*s=([^&]*).*$/, '$1'));
          var songs = MOCK[Object.keys(MOCK)[0]] || [];
          resolve({ status: 200, body: JSON.stringify({ code: 200, result: { songCount: 333, songs: songs } }), url: url });
        } else if (url.indexOf('playlist/detail') >= 0) {
          resolve({
            status: 200, url: url, body: JSON.stringify({
              code: 200, playlist: {
                name: '我喜欢的音乐', trackCount: 5, creator: { nickname: 'MuLin木' },
                trackIds: MOCK[Object.keys(MOCK)[0]].map(function (s) { return { id: s.id }; }),
                tracks: MOCK[Object.keys(MOCK)[0]]
              }
            })
          });
        } else if (url.indexOf('lyric') >= 0) {
          resolve({ status: 200, body: JSON.stringify({ lrc: { lyric: '[00:00.00] 作词 : 测试\n[00:01.00] 作曲 : 测试\n[00:02.00] 这是一行歌词' } }), url: url });
        } else if (url.indexOf('player/url') >= 0) {
          resolve({ status: 200, body: JSON.stringify({ code: 200, data: [{ id: 1, url: 'http://example.com/a.mp3', type: 'mp3', size: 1024, br: 320000, level: 'exhigh' }] }), url: url });
        } else {
          resolve({ status: 200, body: '{}', url: url });
        }
      }, 260);
    });
  }

  function mockDownload(t) {
    var p = 0;
    var timer = setInterval(function () {
      p += 12 + Math.random() * 18;
      if (p >= 100) {
        clearInterval(timer);
        t.status = 'done'; t.pct = 100; t.size = 8.4 * 1048576;
        t.note = 'MP3'; t.path = 'Music/网易云音乐/' + buildName(t.song, CFG.naming) + '.mp3';
      } else { t.status = 'downloading'; t.pct = Math.round(p); }
      renderQueue(); updateStats();
    }, 220);
  }
})();
