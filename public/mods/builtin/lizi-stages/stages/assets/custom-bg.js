/* ============================================================================
   custom-bg.js —— 形态的「可选背景切换」
   ----------------------------------------------------------------------------
   同源、无依赖。通过 <script src="assets/custom-bg.js"></script> 引入。

   window.LIZI_BG = {
     active()                当前是否真的在用自定义背景
     cover(ctx, w, h)        把壁纸铺满画进 ctx（cover 裁切 + 暗化），
                             未开启 / 媒体未就绪 / 失败时返回 false
     attachCanvas(canvas)    告诉模块主 canvas（可选，用于页面隐藏时暂停视频）
     mountDOM(container, nativeEl?)
                             给 DOM 形态用：插一个铺满的 <img>/<video> 背景层。
                             nativeEl 可选；传入时模块会把它 display:none，
                             并把背景层插在它后面，保证字层仍然在上面。
     scrim                   暗化强度，默认 0.45（可写）
   }

   UI：全部长在宿主形态设置面板里（window.__stagePanel），模块不创建任何浮层。
     同步项：bg（switch）、scrim（range）。
     异步项：/api/wallpaper/list 回来后，向同一个 items 数组 push
             { key:'bgpick', type:'gallery', ... }。
   设置消息：{ __c100:1, type:'setting', payload:{ key, value } }

   持久化：localStorage['lizi:bg:<stageId>'] = wallpaper id | 'current' | 'native'
           current = 跟随本机当前 Wallpaper Engine 壁纸（/api/wallpaper）
   stageId：window.LIZI_STAGE_ID > document.title 的数字前缀 / 标题 > 文件名
   ========================================================================== */
(function () {
  'use strict';

  if (window.LIZI_BG) return; /* 幂等 */

  var NATIVE = 'native';
  var CURRENT = 'current';
  var DEFAULT_SCRIM = 0.45;

  /* ================= 0. 宿主形态设置面板（同步声明） ================= */
  /* 187/520 没有自己的面板：直接得到 { title:'背景', items:[bg,scrim] }。
     504 会在 body 脚本里再赋值一次 __stagePanel：用访问器把它原有的设置项
     与 bg/scrim 合并，不覆盖形态自己的设置。 */
  var PANEL_ITEMS = [
    { key: 'bg', label: '自定义背景', type: 'switch', def: false },
    { key: 'scrim', label: '壁纸暗化', type: 'range', min: 0, max: 0.9, step: 0.05, def: 0.45 }
  ];
  var galleryItem = null;

  function mergePanel(p) {
    if (!p || typeof p !== 'object') p = {};
    var src = Array.isArray(p.items) ? p.items : [];
    var kept = [];
    for (var i = 0; i < src.length; i++) {
      var it = src[i];
      if (!it || (it.key !== 'bg' && it.key !== 'scrim' && it.key !== 'bgpick')) kept.push(it);
    }
    p.items = kept.concat(PANEL_ITEMS);
    if (!p.title) p.title = '背景';
    return p;
  }

  /* 把异步 gallery 项塞进同一个 items 数组（宿主若持有该数组引用即可看到） */
  function appendGallery(p) {
    if (!galleryItem || !p || !Array.isArray(p.items)) return;
    for (var i = 0; i < p.items.length; i++) {
      if (p.items[i] && p.items[i].key === 'bgpick') return;
    }
    p.items.push(galleryItem);
  }

  (function installStagePanel() {
    var curPanel = mergePanel(window.__stagePanel);
    try {
      Object.defineProperty(window, '__stagePanel', {
        configurable: true,
        enumerable: true,
        get: function () { return curPanel; },
        set: function (v) {
          curPanel = mergePanel(v);
          appendGallery(curPanel);
        }
      });
    } catch (e) {
      try { window.__stagePanel = curPanel; } catch (e2) {}
      setTimeout(function () {
        try {
          if (window.__stagePanel !== curPanel) curPanel = mergePanel(window.__stagePanel);
          appendGallery(curPanel);
        } catch (e3) {}
      }, 0);
    }
  })();

  /* ================= 0b. stageId / 存储 ================= */
  function stageIdFromEnv() {
    try {
      var g = window.LIZI_STAGE_ID;
      if (g != null && String(g).trim()) return String(g).trim();
      var t = (document.title || '').trim();
      if (t) {
        var m = t.match(/^(\d{2,4})/);
        return m ? m[1] : t;
      }
    } catch (e0) {}
    var p = '';
    try { p = String(location.pathname || '').split('/').pop() || ''; } catch (e1) {}
    return p.replace(/\.html?$/i, '') || 'stage';
  }

  var STAGE_ID = stageIdFromEnv();
  var STORE_KEY = 'lizi:bg:' + STAGE_ID;

  function readPick() {
    try { return localStorage.getItem(STORE_KEY) || ''; } catch (e) { return ''; }
  }
  function writePick(id) {
    try {
      if (id) localStorage.setItem(STORE_KEY, String(id));
      else localStorage.removeItem(STORE_KEY);
    } catch (e) {}
  }

  /* ================= 1. 运行时状态 ================= */
  var currentId = NATIVE;          /* 'native' 或壁纸 id / current */
  var bgOn = false;                /* 宿主 bg 开关：状态只有这一份 */
  var ready = false;               /* DOM 是否已就绪 */
  var pendingSettings = [];        /* ready 之前宿主推来的设置，按顺序重放 */
  var cur = null;                  /* { id, kind, el, ready, failed, provisional, timer } */
  var hiddenHostEl = null;
  var domLayer = null, domScrim = null, nativeEl = null, nativeDisplay = '';
  var canvasEl = null;

  function scrimValue() {
    var a = Number(window.LIZI_BG && window.LIZI_BG.scrim);
    if (!isFinite(a)) a = DEFAULT_SCRIM;
    return Math.max(0, Math.min(1, a));
  }
  function truthy(v) {
    return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
  }
  function enc(s) { return encodeURIComponent(String(s)); }

  function mediaUrl(kind, id) {
    /* current：接口不带 id，直接取本机当前 WE 壁纸 */
    if (String(id) === CURRENT) {
      return kind === 'video' ? '/api/wallpaper/media' : '/api/wallpaper/preview';
    }
    return (kind === 'video' ? '/api/wallpaper/media?id=' : '/api/wallpaper/preview?id=') + enc(id);
  }

  /* ================= 2. 媒体元素 ================= */
  function hiddenHost() {
    if (!hiddenHostEl) {
      hiddenHostEl = document.createElement('div');
      hiddenHostEl.className = 'lzbg-media-host';
      hiddenHostEl.setAttribute('aria-hidden', 'true');
      hiddenHostEl.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;' +
        'overflow:hidden;opacity:0;pointer-events:none';
    }
    if (!hiddenHostEl.parentNode && document.body) document.body.appendChild(hiddenHostEl);
    return hiddenHostEl;
  }

  function placeElement(el) {
    if (domLayer && domScrim) {
      domLayer.insertBefore(el, domScrim);
      return;
    }
    if (document.body) {
      try { hiddenHost().appendChild(el); } catch (e) {}
    }
  }

  function disposeMedia() {
    if (cur && cur.timer) {
      try { clearTimeout(cur.timer); } catch (e) {}
    }
    if (cur && cur.el) {
      var el = cur.el;
      try {
        if (el.tagName === 'VIDEO') {
          el.pause();
          el.removeAttribute('src');
          el.load();
        } else {
          el.onload = null;
          el.onerror = null;
          el.removeAttribute('src');
        }
      } catch (e2) {}
      try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e3) {}
    }
    cur = null;
  }

  function loadMedia(id, kind, opts) {
    opts = opts || {};
    disposeMedia();
    currentId = String(id);

    var rec = {
      id: String(id),
      kind: (kind === 'video') ? 'video' : 'image',
      el: null,
      ready: false,
      failed: false,
      provisional: !!opts.provisional,
      timer: 0
    };
    cur = rec;

    /* 新媒资还没就绪：DOM 形态先恢复原生背景，避免上一个视频消失时闪黑 */
    syncDom();

    var el, onReady, onError;

    onReady = function () {
      if (cur !== rec) return;
      rec.ready = true;
      if (rec.timer) { try { clearTimeout(rec.timer); } catch (e) {} rec.timer = 0; }
      syncDom();
    };

    onError = function () {
      if (cur !== rec || rec.failed) return;
      if (rec.timer) { try { clearTimeout(rec.timer); } catch (e) {} rec.timer = 0; }
      rec.ready = false;

      /* 视频失败：退回同 id 的预览图，仍然不黑 */
      if (rec.kind === 'video' && !opts.otherTried) {
        rec.failed = true;
        loadMedia(id, 'image', { provisional: rec.provisional, otherTried: true });
        return;
      }
      /* 启动时 kind 未知：先试图片失败后再试视频，只互试一次 */
      if (rec.kind === 'image' && rec.provisional && !opts.otherTried) {
        rec.failed = true;
        loadMedia(id, 'video', { provisional: true, otherTried: true });
        return;
      }
      rec.failed = true;
      syncDom();
    };

    if (rec.kind === 'video') {
      el = document.createElement('video');
      el.muted = true;
      el.loop = true;
      el.autoplay = true;
      el.setAttribute('muted', '');
      el.setAttribute('loop', '');
      el.setAttribute('autoplay', '');
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', '');
      el.preload = 'auto';
      el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;' +
        'display:block;pointer-events:none;background:transparent';
      el.addEventListener('loadeddata', onReady);
      el.addEventListener('canplay', onReady);
      el.addEventListener('error', onError);
    } else {
      el = new Image();
      el.decoding = 'async';
      el.alt = '';
      el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;' +
        'display:block;pointer-events:none;background:transparent';
      el.onload = onReady;
      el.onerror = onError;
    }

    rec.el = el;
    placeElement(el);
    el.src = mediaUrl(rec.kind, id);

    if (rec.kind === 'video') {
      var pr = null;
      try { pr = el.play(); } catch (e4) {}
      if (pr && pr.catch) pr.catch(function () {});
    }

    rec.timer = setTimeout(function () {
      if (cur === rec && !rec.ready) onError();
    }, 12000);
  }

  /* ================= 3. 选择 / DOM 同步 ================= */
  function syncDom() {
    if (!domLayer) return;
    var selected = bgOn && currentId !== NATIVE;
    var live = !!(cur && cur.el && cur.ready && !cur.failed);

    if (domScrim) domScrim.style.background = 'rgba(0,0,0,' + scrimValue().toFixed(3) + ')';
    domLayer.style.display = selected ? 'block' : 'none';
    domLayer.style.opacity = (selected && live) ? '1' : '0';

    if (nativeEl) {
      nativeEl.style.display = (selected && live) ? 'none' : nativeDisplay;
    }
  }

  /* ================= 4. 公开 API ================= */
  function cover(g, w, h) {
    if (!g || !bgOn || currentId === NATIVE || !cur || !cur.el || !cur.ready || cur.failed) return false;

    var el = cur.el, iw = 0, ih = 0;
    try {
      if (cur.kind === 'video') {
        iw = el.videoWidth | 0;
        ih = el.videoHeight | 0;
      } else {
        iw = el.naturalWidth | 0;
        ih = el.naturalHeight | 0;
      }
    } catch (e) {}
    if (!iw || !ih || !w || !h) return false;

    var s = Math.max(w / iw, h / ih);
    var dw = iw * s, dh = ih * s;

    g.save();
    try {
      g.drawImage(el, (w - dw) / 2, (h - dh) / 2, dw, dh);
      var a = scrimValue();
      if (a > 0) {
        g.fillStyle = 'rgba(0,0,0,' + a.toFixed(3) + ')';
        g.fillRect(0, 0, w, h);
      }
    } catch (e2) {
      g.restore();
      return false;
    }
    g.restore();
    return true;
  }

  function attachCanvas(canvas) {
    canvasEl = canvas || null;
  }

  function mountDOM(container, native) {
    container = container || document.body;
    if (!container) return;

    nativeEl = native || null;
    if (nativeEl) nativeDisplay = nativeEl.style.display || '';

    if (!domLayer) {
      domLayer = document.createElement('div');
      domLayer.className = 'lzbg-layer';
      domLayer.setAttribute('aria-hidden', 'true');
      domLayer.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:0;' +
        'pointer-events:none;overflow:hidden;background:transparent';

      domScrim = document.createElement('div');
      domScrim.className = 'lzbg-scrim';
      domScrim.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;' +
        'pointer-events:none;background:rgba(0,0,0,' + scrimValue().toFixed(3) + ')';
      domLayer.appendChild(domScrim);
    }

    /* 关键：插在原生背景后面，而不是 append 到 body 末尾 —— 字层自然在上面 */
    if (nativeEl && nativeEl.parentNode === container) {
      container.insertBefore(domLayer, nativeEl.nextSibling);
    } else if (domLayer.parentNode !== container) {
      container.appendChild(domLayer);
    }

    /* 媒体元素已经创建：从隐藏宿主搬进来 */
    if (cur && cur.el && cur.el.parentNode !== domLayer) {
      try { domLayer.insertBefore(cur.el, domScrim); } catch (e) {}
    }
    syncDom();
  }

  /* ================= 5. 列表 / 本机 WE 探测 ================= */
  var listState = { p: null, items: [], ok: false, failed: false };

  function fetchList() {
    if (listState.p) return listState.p;
    listState.p = fetch('/api/wallpaper/list', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) {
        if (!r || !r.ok) throw new Error('list');
        return r.json();
      })
      .then(function (d) {
        if (!d || !d.ok || !Array.isArray(d.items)) throw new Error('list');
        var out = [], i, it, kind;
        for (i = 0; i < d.items.length; i++) {
          it = d.items[i];
          if (!it || it.id == null) continue;
          kind = String(it.kind || 'image');
          if (kind === 'none') continue;
          out.push({
            id: String(it.id),
            title: String(it.title || ''),
            kind: kind === 'video' ? 'video' : 'image'
          });
        }
        listState.items = out;
        listState.ok = true;
        return listState;
      });
    listState.p.catch(function () { listState.failed = true; });
    return listState.p;
  }

  function findItem(id) {
    for (var i = 0; i < listState.items.length; i++) {
      if (listState.items[i].id === String(id)) return listState.items[i];
    }
    return null;
  }

  var we = { p: null, ok: false, kind: 'image' };

  function fetchWE() {
    if (we.p) return we.p;
    we.p = fetch('/api/wallpaper', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) {
        if (!r || !r.ok) throw new Error('we');
        return r.json();
      })
      .then(function (d) {
        if (!d || !d.ok) throw new Error('we');
        we.ok = true;
        we.kind = String(d.kind || 'image') === 'video' ? 'video' : 'image';
        return we;
      });
    we.p.catch(function () {
      we.ok = false;
      we.p = null; /* WE 可能稍后才启动：下次再探测 */
    });
    return we.p;
  }

  /* ================= 6. gallery 数据（异步填充） ================= */
  function buildGallery() {
    if (galleryItem) return;

    var items = [];
    if (listState.ok) {
      items.push({
        v: CURRENT,
        t: '当前 Wallpaper Engine 壁纸',
        thumb: '/api/wallpaper/preview'
      });
      for (var i = 0; i < listState.items.length; i++) {
        var it = listState.items[i];
        items.push({
          v: it.id,
          t: it.title || it.id,
          thumb: '/api/wallpaper/preview?id=' + enc(it.id)
        });
      }
    } else {
      /* 列表 404 / ok:false：只放 current 一项，title 用「当前壁纸」 */
      items.push({
        v: CURRENT,
        t: '当前壁纸',
        thumb: '/api/wallpaper/preview'
      });
    }

    galleryItem = {
      key: 'bgpick',
      label: '选择壁纸',
      type: 'gallery',
      def: '',                 /* 空 = 还没选过；避免宿主 pushAll 默认值把背景打开 */
      onSelect: { key: 'bg', value: true },  /* 声明：选图 = 打开「自定义背景」开关 */
      items: items
    };
    appendGallery(window.__stagePanel);
  }

  function loadGallery() {
    fetchList().then(buildGallery, buildGallery);
  }

  /* ================= 7. 应用背景 ================= */
  function applyCurrent() {
    currentId = CURRENT;
    syncDom();
    fetchWE().then(function () {
      if (!bgOn || currentId !== CURRENT) return;
      loadMedia(CURRENT, we.kind, { provisional: false });
    }, function () {
      /* WE 没开：原生背景显示；bg 开关保持宿主给的状态 */
      if (!bgOn || currentId !== CURRENT) return;
      currentId = NATIVE;
      syncDom();
    });
  }

  function applyStored(id) {
    /* 先按图片猜（preview 对视频通常是封面图），列表回来后再按 kind 校正 */
    loadMedia(id, 'image', { provisional: true });
    fetchList().then(function () {
      if (!bgOn || currentId !== id) return;
      var it = findItem(id);
      if (it && it.kind === 'video') loadMedia(id, 'video', { provisional: false });
    }, function () {});
  }

  function applyPick(v) {
    v = (v == null || v === '') ? CURRENT : String(v);
    if (v === NATIVE) v = CURRENT;
    if (v === CURRENT) {
      applyCurrent();
    } else {
      var it = findItem(v);
      if (it) loadMedia(v, it.kind, { provisional: false });
      else applyStored(v);
    }
    syncDom();
  }

  function startBg() {
    bgOn = true;
    var v = readPick();
    if (!v || v === NATIVE) v = CURRENT;
    applyPick(v);
  }

  function stopBg() {
    bgOn = false;
    currentId = NATIVE;
    /* 视频在这里停：pause → removeAttribute('src') → load() → 从 DOM 移除 */
    disposeMedia();
    syncDom();
    /* localStorage 里的具体壁纸保留，下次打开开关还能直接应用 */
  }

  function setBg(on) {
    on = truthy(on);
    if (on === bgOn) return;
    bgOn = on;
    if (on) startBg(); else stopBg();
  }

  /* ================= 8. 宿主设置 / 启动 ================= */
  /* scrim 只改暗化：不重建媒体；canvas 下一帧 cover() 自然读到新值 */
  function applyScrimSetting(v) {
    var n = Number(v);
    if (!isFinite(n)) n = DEFAULT_SCRIM;
    n = Math.max(0, Math.min(1, n));
    if (window.LIZI_BG) window.LIZI_BG.scrim = n;
    if (domScrim) domScrim.style.background = 'rgba(0,0,0,' + scrimValue().toFixed(3) + ')';
  }

  function handleSetting(key, value) {
    if (key === 'bg') {
      setBg(value);
      return;
    }
    if (key === 'scrim') {
      applyScrimSetting(value);
      return;
    }
    if (key === 'bgpick') {
      /* 宿主 stage:ready 会把 def 空值推一遍：那不是用户选择，直接忽略 */
      if (value == null || value === '') return;
      var v = String(value);
      if (v === NATIVE) v = CURRENT;
      /* 和已存的值相同 = 重放，不是新选择：直接忽略，避免开着背景进形态时二次重载 */
      if (v === String(readPick() || '')) return;
      writePick(v);
      bgOn = true;
      applyPick(v);
    }
  }

  function init() {
    ready = true;
    syncDom();
    loadGallery();
    while (pendingSettings.length) {
      var s = pendingSettings.shift();
      handleSetting(s.key, s.value);
    }
  }

  function pauseVideo() {
    if (cur && cur.el && cur.kind === 'video') {
      try { cur.el.pause(); } catch (e) {}
    }
  }
  function resumeVideo() {
    if (bgOn && currentId !== NATIVE && cur && cur.el && cur.kind === 'video' && cur.ready) {
      try { var pr = cur.el.play(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) {}
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') pauseVideo();
    else resumeVideo();
  }, false);

  window.addEventListener('pagehide', function () {
    disposeMedia();
    if (hiddenHostEl) {
      try { if (hiddenHostEl.parentNode) hiddenHostEl.parentNode.removeChild(hiddenHostEl); } catch (e) {}
      hiddenHostEl = null;
    }
  }, false);

  window.LIZI_BG = {
    scrim: DEFAULT_SCRIM,
    stageId: STAGE_ID,
    active: function () { return bgOn && currentId !== NATIVE; },
    cover: cover,
    attachCanvas: attachCanvas,
    mountDOM: mountDOM
  };

  window.addEventListener('message', function (ev) {
    var d = ev && ev.data;
    if (!d || d.__c100 !== 1 || d.type !== 'setting') return;
    var p = d.payload || {};
    if (!ready) {
      pendingSettings.push({ key: p.key, value: p.value });
      return;
    }
    handleSetting(p.key, p.value);
  }, false);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, false);
  } else {
    init();
  }
})();
