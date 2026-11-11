'use strict';

// android/app/src/main/assets/folia-node/electron-shim.cjs
//
// `BrowserWindow` / `ipcMain` / `screen` / `app` 的替身，供安卓宿主的
// `require('electron')` 拦截使用。
//
// 桌面模组（歌词浮岛那类）在 main 里 `new BrowserWindow({...})` 建真正的系统窗口，靠
// `setIgnoreMouseEvents` 做点击穿透、`webContents.send` 下发数据、`screen` 算位置。
// 安卓只有 `TYPE_APPLICATION_OVERLAY` 悬浮窗，这一层把前者的方法翻译过去
// （原生实现在 OverlayWindowManager.java / OverlayBridge.java）。
//
// 三个必须做对的点：
//   1. `webContents` 必须**每个窗口独立、引用稳定**——模组用
//      `event.sender !== win.webContents` 判断消息来源，给错就全部静默失效。
//   2. `ready-to-show` 要等页面首帧之后才发，早了用户看到的是空白窗。
//   3. `-webkit-app-region: drag` 在安卓 WebView 无效，拖动由原生接管触摸完成，
//      模组只要把窗口标记成可拖（`setDraggable(true)`）即可。

const { EventEmitter } = require('events');

/**
 * 向 Java 侧发一次 overlay 请求并等回应。
 * 由 host.js 注入（它持有 foliaNode 通道），这样这个文件不依赖原生 binding。
 */
let callOverlayImpl = async () => {
    throw new Error('overlay bridge is not installed');
};
let logWarn = () => undefined;

const installOverlayBridge = (callOverlay, warn) => {
    if (typeof callOverlay === 'function') callOverlayImpl = callOverlay;
    if (typeof warn === 'function') logWarn = warn;
};

/** 窗口 id → BrowserWindow 实例。`getAllWindows()` 与 sender 查表都靠它。 */
const windows = new Map();

class ShimWebContents extends EventEmitter {
    constructor(windowId) {
        super();
        this.__windowId = windowId;
        this.__destroyed = false;
    }

    send(channel, payload) {
        if (this.__destroyed || this.__windowId == null) return;
        void callOverlayImpl('send', {
            id: this.__windowId,
            channel: String(channel),
            payload: payload === undefined ? null : payload,
        }).catch((error) => logWarn(`窗口消息发送失败：${error && error.message ? error.message : error}`));
    }

    isDestroyed() {
        return this.__destroyed;
    }

    // 安卓 WebView 不会开新窗口；给空实现让模组能注册上（它会读返回值里的 action）。
    setWindowOpenHandler() {
        return undefined;
    }

    reload() {
        return undefined;
    }

    isLoading() {
        return false;
    }

    invalidate() {
        return undefined;
    }
}

class BrowserWindow extends EventEmitter {
    constructor(options = {}) {
        super();
        this.__options = options || {};
        this.__destroyed = false;
        this.__visible = this.__options.show !== false;
        this.__alwaysOnTop = this.__options.alwaysOnTop !== false;
        this.__id = null;
        this.__bounds = {
            x: Number(this.__options.x) || 0,
            y: Number(this.__options.y) || 0,
            width: Number(this.__options.width) || 480,
            height: Number(this.__options.height) || 200,
        };
        this.webContents = new ShimWebContents(null);
        this.__creating = this.__create();
    }

    async __create() {
        try {
            const result = await callOverlayImpl('create', { options: this.__options });
            if (result && result.id != null) {
                this.__id = result.id;
                windows.set(result.id, this);
                // 换成一个带真实 id 的 webContents：此后 sender 的比对才有意义。
                const next = new ShimWebContents(result.id);
                next.on('newListener', () => undefined);
                this.webContents = next;
            } else {
                this.__destroyed = true;
                logWarn('悬浮窗没建起来（可能是缺少悬浮窗权限）');
            }
        } catch (error) {
            this.__destroyed = true;
            logWarn(`创建悬浮窗失败：${error && error.message ? error.message : error}`);
        }
        return this;
    }

    async __call(op, args = {}) {
        await this.__creating;
        if (this.__id == null) throw new Error('overlay-window-unavailable');
        return await callOverlayImpl(op, { id: this.__id, ...args });
    }

    /**
     * 模组传的是 `data:text/html;charset=utf-8,<encodeURIComponent(html)>`
     * （见其 main.cjs 里的 WIDGET_HTML / POPUP_HTML）。这里解出 HTML 交给原生
     * `loadDataWithBaseURL`，不用 WebView 的 data: 直载（部分机型有长度限制）。
     */
    loadURL(url) {
        const text = String(url || '');
        const comma = text.indexOf(',');
        let body = comma >= 0 ? text.slice(comma + 1) : text;
        try {
            body = decodeURIComponent(body);
        } catch {
            // 不是 URI 编码就原样用。
        }
        void this.__loadHtml(body);
        return Promise.resolve();
    }

    loadFile() {
        return Promise.resolve();
    }

    async __loadHtml(html) {
        await this.__creating;
        if (this.__id == null) return;
        try {
            await callOverlayImpl('load-html', {
                id: this.__id,
                html,
                injection: buildInjection(this.__id),
            });
            // 页面已经灌进去了；Electron 的 ready-to-show 是「首帧可绘」，
            // 这里 onPageFinished 之后原生会再发一次 did-finish-load。
            this.emit('ready-to-show');
            this.webContents.emit('did-finish-load');
        } catch (error) {
            logWarn(`加载悬浮窗页面失败：${error && error.message ? error.message : error}`);
        }
    }

    isDestroyed() { return this.__destroyed; }

    show() { return this.showInactive(); }

    showInactive() {
        this.__visible = true;
        void this.__call('set-visible', { visible: true }).catch(() => undefined);
        return undefined;
    }

    hide() {
        this.__visible = false;
        void this.__call('set-visible', { visible: false }).catch(() => undefined);
        return undefined;
    }

    isVisible() { return this.__visible && !this.__destroyed; }

    isMinimized() { return false; }

    restore() { return undefined; }

    focus() { return undefined; }

    moveTop() { return undefined; }

    setAlwaysOnTop(next) { this.__alwaysOnTop = Boolean(next); }

    isAlwaysOnTop() { return this.__alwaysOnTop; }

    setIgnoreMouseEvents(ignore) {
        void this.__call('set-ignore-mouse', { ignore: Boolean(ignore) }).catch(() => undefined);
        return undefined;
    }

    /** 安卓专用：允许原生接管触摸拖动整窗（替代无效的 -webkit-app-region: drag）。 */
    setDraggable(draggable) {
        void this.__call('set-draggable', { draggable: Boolean(draggable) }).catch(() => undefined);
        return undefined;
    }

    getBounds() {
        if (this.__id != null) {
            void this.__call('get-bounds').then((bounds) => {
                if (bounds && typeof bounds.width === 'number') {
                    this.__bounds = {
                        x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
                    };
                }
            }).catch(() => undefined);
        }
        return { ...this.__bounds };
    }

    getContentBounds() { return this.getBounds(); }

    setBounds(bounds) {
        if (!bounds) return undefined;
        this.__bounds = {
            x: Number(bounds.x) || 0,
            y: Number(bounds.y) || 0,
            width: Number(bounds.width) || this.__bounds.width,
            height: Number(bounds.height) || this.__bounds.height,
        };
        void this.__call('set-bounds', this.__bounds).catch(() => undefined);
        // 模组靠 resize 事件重算长句滚动与按钮矩形；改尺寸后必须发。
        this.emit('resize');
        this.emit('resized');
        return undefined;
    }

    getSize() {
        const bounds = this.getBounds();
        return [bounds.width, bounds.height];
    }

    setSize(width, height) {
        this.setBounds({ ...this.getBounds(), width, height });
        return undefined;
    }

    getPosition() {
        const bounds = this.getBounds();
        return [bounds.x, bounds.y];
    }

    setPosition(x, y) {
        this.setBounds({ ...this.getBounds(), x, y });
        return undefined;
    }

    setMenuBarVisibility() { return undefined; }

    setVisibleOnAllWorkspaces() { return undefined; }

    getOpacity() { return 1; }

    setOpacity() { return undefined; }

    close() { return this.destroy(); }

    destroy() {
        if (this.__destroyed) return;
        this.__destroyed = true;
        this.webContents.__destroyed = true;
        if (this.__id != null) {
            windows.delete(this.__id);
            void callOverlayImpl('destroy', { id: this.__id }).catch(() => undefined);
        }
        this.emit('closed');
    }

    static getAllWindows() {
        return [...windows.values()];
    }
}

/**
 * 页面里的 Electron 替身。
 *
 * 模组页面开头是 `const { ipcRenderer } = require('electron')`（两页各一处），
 * 而安卓 WebView 没有 `require`。这里注入一个最小实现：`require('electron')` 给出
 * `ipcRenderer`，其余模块名一律抛错（页面本来也只用这一个）。
 */
const buildInjection = (windowId) => `(function(){
  if (window.__foliaIpcReady) return;
  window.__foliaIpcReady = true;
  var bridge = window.__foliaIpcNative;
  var listeners = {};
  window.__foliaIpc = {
    receive: function(raw){
      var msg; try { msg = JSON.parse(raw); } catch (e) { return; }
      if (msg && msg.channel) { window.__foliaLastIpcAt[msg.channel] = Date.now(); }
      var list = listeners[msg.channel] || [];
      for (var i = 0; i < list.length; i++) {
        try { list[i]({}, msg.payload); } catch (e) { console.error(e); }
      }
    }
  };
  /* 每个通道最后一次收到消息的时刻，用来判断「宿主那条链还在不在动」。 */
  window.__foliaLastIpcAt = {};
  /*
   * 原生歌词兜底。
   *
   * 模组的歌词由宿主 WebView 经 IPC 推入，**App 一退后台 WebView 被冻结就断**，
   * 页面上那句歌词从此不再变化。原生侧另有一份常驻的播放快照（壁纸/叠层共用），
   * 由 OverlayWindowManager 按固定节拍调到 window.foliaNativeLyrics。
   *
   * 这里把那份快照转成模组认得的 IPC_DATA 形状，**只在原生数据比 IPC 新时才喂**：
   * 前台时 IPC 更细（有逐字时间轴），仍然优先；后台 IPC 停了，才由原生接手。
   */
  window.__foliaApplyNativeLyrics = function(native){
    if (!native || typeof native !== 'object') return;
    var now = Date.now();
    if (native.playing !== window.__foliaNativePlaying) {
      window.__foliaNativePlaying = native.playing;
      window.__foliaNativeSince = now;
    }
    window.foliaNativeLyrics = native;
    if (native.playing) window.__foliaNativeSince = now;
    /* IPC 刚来过就完全交给它，别抢占。 */
    var lastIpc = window.__foliaLastIpcAt['lyric-float:data-from-client'] || 0;
    if (now - lastIpc < 4000) return;
    var text = typeof native.text === 'string' ? native.text : '';
    if (!text) return;
    var key = text + '|' + native.index;
    if (key === window.__foliaNativeKey) return;
    window.__foliaNativeKey = key;
    var payload = {
      state: native.playing ? 'playing' : 'paused',
      line: { text: text, translation: native.translation || '' },
      song: { title: native.title || '', artist: native.artist || '' }
    };
    var list = listeners['lyric-float:data-from-client'] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i]({}, payload); } catch (e) { console.error(e); }
    }
  };
  /*
   * 字体跟随原生那份设置。
   *
   * 模组自己的字体栈是桌面端的写法（'Microsoft YaHei UI' / 'PingFang SC' …），安卓上
   * 一个都没有，于是永远落在兜底字体上 —— 用户在设置里换字体，歌词不会跟着变。
   *
   * 原生那边存的是字体**文件**（壁纸渲染器按路径自绘），不是字体名，所以这里拿到的是
   * 一段 data: 字节，注册成 @font-face 再顶掉页面字体栈。只在换了字体时才推一次。
   */
  window.__foliaApplyNativeFont = function(font){
    if (!font || typeof font.data !== 'string' || !font.data) return;
    var stamp = String(font.stamp || '');
    if (stamp && stamp === window.__foliaNativeFontStamp) return;
    window.__foliaNativeFontStamp = stamp;
    var family = '__folia_native_font_family';
    var style = document.getElementById('__folia_native_font');
    if (!style) {
      style = document.createElement('style');
      style.id = '__folia_native_font';
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = '@font-face { font-family: "' + family + '"; src: url("' + font.data + '"); }'
      + 'body, body *:not(script):not(style) { font-family: "' + family + '", system-ui, sans-serif !important; }';
  };
  var ipcRenderer = {
    send: function(channel, payload){
      try { bridge.send(String(channel), JSON.stringify(payload === undefined ? null : payload)); }
      catch (e) { console.error(e); }
    },
    invoke: function(){ return Promise.reject(new Error('ipcRenderer.invoke is not available on android')); },
    on: function(channel, fn){ (listeners[channel] = listeners[channel] || []).push(fn); return ipcRenderer; },
    once: function(channel, fn){
      var wrapped = function(e, p){ ipcRenderer.removeListener(channel, wrapped); fn(e, p); };
      return ipcRenderer.on(channel, wrapped);
    },
    removeListener: function(channel, fn){
      var list = listeners[channel]; if (!list) return ipcRenderer;
      var at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); return ipcRenderer;
    },
    removeAllListeners: function(channel){ delete listeners[channel]; return ipcRenderer; }
  };
  window.require = function(name){
    if (name === 'electron') return { ipcRenderer: ipcRenderer };
    throw new Error('module not available in overlay page: ' + name);
  };
  if (bridge && typeof bridge.ready === 'function') bridge.ready();
})();`;

/** `ipcMain`：注册监听即可，事件对象由原生侧（OverlayBridge）构造并带上 sender。 */
const ipcMain = new EventEmitter();

/** `screen`：安卓单显示器，工作区与落点由原生给（`screen` op）。 */
const screen = {
    __workArea: { x: 0, y: 0, width: 1080, height: 1920 },
    __cursor: { x: -1, y: -1 },
    getPrimaryDisplay() {
        return {
            id: 0,
            bounds: { ...screen.__workArea },
            workArea: { ...screen.__workArea },
            scaleFactor: 1,
        };
    },
    getAllDisplays() {
        // 恒一个：模组的「任务栏守卫」靠多屏判断，给单个能让那段自然失效而不是误判。
        return [screen.getPrimaryDisplay()];
    },
    getDisplayMatching() {
        return screen.getPrimaryDisplay();
    },
    getCursorScreenPoint() {
        return { ...screen.__cursor };
    },
};

screen.refresh = async () => {
    try {
        const result = await callOverlayImpl('screen', {});
        if (Array.isArray(result.workArea) && result.workArea.length === 4) {
            screen.__workArea = {
                x: result.workArea[0], y: result.workArea[1],
                width: result.workArea[2], height: result.workArea[3],
            };
        }
        if (Array.isArray(result.cursor) && result.cursor.length === 2) {
            screen.__cursor = { x: result.cursor[0], y: result.cursor[1] };
        }
    } catch {
        // 拿不到就沿用默认值。
    }
};

const app = {
    on() { return undefined; },
    once() { return undefined; },
    removeListener() { return undefined; },
    removeAllListeners() { return undefined; },
    quit() { return undefined; },
    getVersion: () => '30.0.0',
};

module.exports = {
    BrowserWindow,
    ipcMain,
    screen,
    app,
    installOverlayBridge,
    buildInjection,
};
