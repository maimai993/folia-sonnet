package top.izuna.foliamajor.mods;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * 桌面端 `ipcMain` / `ipcRenderer` 在安卓上的对应物，以及 `BrowserWindow` 的 JS 侧替身
 * （`require('electron')` 拿到的那个对象）。
 *
 * 协议：Node 宿主（模组主进程）建窗口、发消息；页面里通过注入的
 * `window.__foliaIpc` 往回收。两条方向都经过 {@link OverlayWindowManager}。
 *
 * 关键一点是 **`event.sender` 的身份**：桌面模组普遍写成
 *
 *     ipcMain.on('xxx', (event, payload) => {
 *       if (event.sender !== state.win.webContents) return;   // 丢弃非本窗口的消息
 *       ...
 *     });
 *
 * 所以每个窗口必须有一个引用稳定、彼此不相等的 `webContents` 替身对象，否则所有来源
 * 校验都会静默失败（模组只打一行日志，很难查）。这里用窗口 id 做键，保证同一个窗口
 * 每次拿到的都是同一个对象。
 */
final class OverlayBridge {

    private static final String TAG = "FoliaOverlayIpc";

    /** 一个窗口的 `webContents` 替身。身份由 id 决定，跨调用稳定。 */
    static final class WebContentsStub {
        final long windowId;
        final String modId;

        WebContentsStub(long windowId, String modId) {
            this.windowId = windowId;
            this.modId = modId;
        }
    }

    /** 主进程侧注册的监听器：channel -> 回调。 */
    private final ConcurrentHashMap<String, CopyOnWriteArrayList<IpcHandler>> handlers = new ConcurrentHashMap<>();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Context context;
    private final OverlayWindowManager overlays;
    /** 窗口 id -> webContents 替身。 */
    private final ConcurrentHashMap<Long, WebContentsStub> contents = new ConcurrentHashMap<>();
    /** 页面缓冲：页面脚本未就绪时先攒着，就绪后补发。 */
    private final ConcurrentHashMap<Long, List<String>> pendingSends = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Long, Boolean> pageReady = new ConcurrentHashMap<>();

    interface IpcHandler {
        void onMessage(IpcEvent event, JSONObject payload);
    }

    /** 桌面端 `IpcMainEvent` 的最小形状。`sender` 是身份判别用的那个对象。 */
    static final class IpcEvent {
        final WebContentsStub sender;
        final String channel;

        IpcEvent(WebContentsStub sender, String channel) {
            this.sender = sender;
            this.channel = channel;
        }
    }

    OverlayBridge(Context context, OverlayWindowManager overlays) {
        this.context = context.getApplicationContext();
        this.overlays = overlays;
    }

    void on(String channel, IpcHandler handler) {
        if (channel == null || channel.isEmpty() || handler == null) return;
        handlers.computeIfAbsent(channel, key -> new CopyOnWriteArrayList<>()).add(handler);
    }

    void removeListener(String channel, IpcHandler handler) {
        if (channel == null) return;
        CopyOnWriteArrayList<IpcHandler> list = handlers.get(channel);
        if (list == null) return;
        if (handler != null) {
            list.remove(handler);
        } else {
            list.clear();
        }
    }

    /**
     * 主进程 → 页面（对应 `webContents.send`）。
     *
     * 页面还没加载完时先缓冲：模组在建完窗口后立刻下发配置，那时 `loadHTML` 还没跑完，
     * 直接 `evaluateJavascript` 会打在空气里。
     */
    void sendToWindow(long windowId, String channel, JSONObject payload) {
        JSONObject envelope = new JSONObject();
        try {
            envelope.put("channel", channel);
            envelope.put("payload", payload == null ? JSONObject.NULL : payload);
        } catch (Exception error) {
            Log.w(TAG, "构造 IPC 消息失败", error);
            return;
        }
        String script = "window.__foliaIpc && window.__foliaIpc.receive("
                + JSONObject.quote(envelope.toString()) + ");";
        if (!Boolean.TRUE.equals(pageReady.get(windowId))) {
            pendingSends.computeIfAbsent(windowId, key -> new ArrayList<>()).add(script);
            return;
        }
        OverlayWindowManager.OverlayWindow window = findWindow(windowId);
        if (window != null) overlays.evaluate(window, script);
    }

    /** 页面加载完成：把攒下的消息补发出去。 */
    void markPageReady(long windowId) {
        pageReady.put(windowId, Boolean.TRUE);
        List<String> queued = pendingSends.remove(windowId);
        if (queued == null) return;
        OverlayWindowManager.OverlayWindow window = findWindow(windowId);
        if (window == null) return;
        for (String script : queued) {
            overlays.evaluate(window, script);
        }
    }

    void forgetWindow(long windowId) {
        pageReady.remove(windowId);
        pendingSends.remove(windowId);
        contents.remove(windowId);
    }

    WebContentsStub contentsOf(long windowId, String modId) {
        return contents.computeIfAbsent(windowId, key -> new WebContentsStub(key, modId));
    }

    /** 把 {@link PageIpcInterface} 装到 {@link OverlayWindowManager} 上（建窗口时用）。 */
    void install(OverlayWindowManager manager) {
        manager.setPageInterfaceFactory(windowId -> new PageIpcInterface(windowId));
    }

    /**
     * 页面 → 主进程。注入成 `window.__foliaIpcNative`。
     *
     * 注意 `addJavascriptInterface` 的方法都在 WebView 的 JS 线程上调用，而模组的
     * `ipcMain` 回调期望在主线程上跑（桌面端就是主线程），所以统一 post 过去。
     */
    final class PageIpcInterface {
        private final long windowId;

        PageIpcInterface(long windowId) {
            this.windowId = windowId;
        }

        @JavascriptInterface
        public void send(String channel, String jsonPayload) {
            dispatch(windowId, channel, jsonPayload);
        }

        @JavascriptInterface
        public void ready() {
            mainHandler.post(() -> markPageReady(windowId));
        }

        @JavascriptInterface
        public void debug(String message) {
            Log.i(TAG, "[" + windowId + "] " + message);
        }
    }

    private void dispatch(long windowId, String channel, String jsonPayload) {
        JSONObject payload;
        try {
            payload = jsonPayload == null || jsonPayload.isEmpty() || "null".equals(jsonPayload)
                    ? new JSONObject()
                    : new JSONObject(jsonPayload);
        } catch (Exception error) {
            Log.w(TAG, "IPC 载荷不是对象：" + channel, error);
            return;
        }
        final String target = channel;
        mainHandler.post(() -> {
            WebContentsStub sender = contents.get(windowId);
            if (sender == null) return;
            CopyOnWriteArrayList<IpcHandler> list = handlers.get(target);
            if (list == null) return;
            IpcEvent event = new IpcEvent(sender, target);
            for (IpcHandler handler : list) {
                try {
                    handler.onMessage(event, payload);
                } catch (Throwable error) {
                    Log.w(TAG, "IPC 回调失败：" + target, error);
                }
            }
        });
    }

    /** 页面里可用的 `require('electron').ipcRenderer` 注入脚本。 */
    @SuppressLint("JavascriptInterface")
    String pageInjectionScript(long windowId) {
        // 注入 require 的替身：页面里写的是 `const { ipcRenderer } = require('electron')`。
        // 只提供了 ipcRenderer —— 页面除了它不需要别的。
        return "(function(){"
                + "  if (window.__foliaIpcReady) return;"
                + "  window.__foliaIpcReady = true;"
                + "  var bridge = window.__foliaIpcNative;"
                + "  var listeners = {};"
                + "  window.__foliaIpc = {"
                + "    receive: function(raw){"
                + "      var msg; try { msg = JSON.parse(raw); } catch (e) { return; }"
                + "      var list = listeners[msg.channel] || [];"
                + "      for (var i = 0; i < list.length; i++) {"
                + "        try { list[i]({}, msg.payload); } catch (e) { console.error(e); }"
                + "      }"
                + "    }"
                + "  };"
                + "  var ipcRenderer = {"
                + "    send: function(channel, payload){"
                + "      try { bridge.send(String(channel), JSON.stringify(payload === undefined ? null : payload)); } catch (e) { console.error(e); }"
                + "    },"
                + "    invoke: function(channel, payload){"
                + "      return Promise.reject(new Error('ipcRenderer.invoke is not available on android'));"
                + "    },"
                + "    on: function(channel, fn){ (listeners[channel] = listeners[channel] || []).push(fn); return ipcRenderer; },"
                + "    once: function(channel, fn){"
                + "      var wrapped = function(e, p){ ipcRenderer.removeListener(channel, wrapped); fn(e, p); };"
                + "      return ipcRenderer.on(channel, wrapped);"
                + "    },"
                + "    removeListener: function(channel, fn){"
                + "      var list = listeners[channel]; if (!list) return ipcRenderer;"
                + "      var at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); return ipcRenderer;"
                + "    },"
                + "    removeAllListeners: function(channel){ delete listeners[channel]; return ipcRenderer; }"
                + "  };"
                + "  var realRequire = window.require;"
                + "  window.require = function(name){"
                + "    if (name === 'electron') return { ipcRenderer: ipcRenderer };"
                + "    if (typeof realRequire === 'function') return realRequire(name);"
                + "    throw new Error('module not available: ' + name);"
                + "  };"
                + "  if (typeof bridge.ready === 'function') bridge.ready();"
                + "})();";
    }

    private OverlayWindowManager.OverlayWindow findWindow(long windowId) {
        return overlays.find(windowId);
    }
}
