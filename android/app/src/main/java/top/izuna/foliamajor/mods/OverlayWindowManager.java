package top.izuna.foliamajor.mods;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 桌面端 `BrowserWindow` 在安卓上的对应物：一个系统悬浮窗（`TYPE_APPLICATION_OVERLAY`）
 * 加一个渲染模组页面的 WebView。
 *
 * 为什么需要它：模组（例如歌词浮岛）在 `main.cjs` 里 `new BrowserWindow(...)` 建真正的
 * 操作系统窗口，靠 `setIgnoreMouseEvents` 做点击穿透、靠 `-webkit-app-region: drag` 拖动。
 * 安卓没有这些，只有「悬浮在其它应用之上的一层 View」——这个类就是那层 View 的壳，
 * 同时把桌面端那几个方法翻译成 `WindowManager.LayoutParams` 上的 flag。
 *
 * 与桌面端的语义差异（都是安卓的硬限制，不是没做完）：
 *
 *   · `setIgnoreMouseEvents` → `FLAG_NOT_TOUCHABLE`。桌面端还能 `forward: true` 把移动
 *     事件继续转给页面，安卓没有等价物，穿透期间页面收不到触摸。
 *   · `-webkit-app-region: drag` 无效：拖动必须自己接管触摸，见 {@link DragTouchListener}。
 *   · `setAlwaysOnTop` / `moveTop` 基本无意义：overlay 天生在最上层，`moveTop` 只影响
 *     多个 overlay 之间的先后。
 *   · `screen.getCursorScreenPoint()` 没有对应 API：触摸设备只有「正在触摸时」才知道
 *     坐标，所以这里记住最后一次落点，供模组的悬停轮询使用。
 */
final class OverlayWindowManager {

    private static final String TAG = "FoliaOverlay";

    /** overlay 窗口的身份，对应桌面端的 BrowserWindow 实例。 */
    static final class OverlayWindow {
        final long id;
        final WebView webView;
        WindowManager.LayoutParams params;
        boolean destroyed = false;
        boolean visible = true;
        boolean ignoringMouse = false;
        /** 模组在页面上画的拖动区；为 true 时触摸会拖动整个窗口而不是交给页面。 */
        boolean draggable = false;
        /** 页面脚本，在 onPageStarted 注入（早于页面自己的内联脚本）。 */
        String injection = null;
        /** 页面加载完成回调（对应桌面端的 `did-finish-load`）。 */
        Runnable onPageFinished = null;
        final List<Runnable> closedListeners = new ArrayList<>();

        OverlayWindow(long id, WebView webView, WindowManager.LayoutParams params) {
            this.id = id;
            this.webView = webView;
            this.params = params;
        }
    }

    /** 页面 → 主进程的回传接口（`addJavascriptInterface` 的那个对象），由 OverlayBridge 造。 */
    interface PageInterfaceFactory {
        Object create(long windowId);
    }

    private final Context context;
    private final WindowManager windowManager;
    private PageInterfaceFactory pageInterfaceFactory = null;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final AtomicLong ids = new AtomicLong(1);
    private final ConcurrentHashMap<Long, OverlayWindow> windows = new ConcurrentHashMap<>();

    /** 最后一次已知的触摸落点（屏幕坐标），给 `screen.getCursorScreenPoint()` 用。 */
    private volatile int lastTouchX = -1;
    private volatile int lastTouchY = -1;

    OverlayWindowManager(Context context) {
        this.context = context.getApplicationContext();
        this.windowManager = (WindowManager) this.context.getSystemService(Context.WINDOW_SERVICE);
    }

    void setPageInterfaceFactory(PageInterfaceFactory factory) {
        this.pageInterfaceFactory = factory;
    }

    /** 有没有悬浮窗权限。没有的话 `addView` 会直接抛异常。 */
    boolean canDrawOverlays() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        return Settings.canDrawOverlays(context);
    }

    /** 屏幕可用区域（不含系统栏），给 `screen.getPrimaryDisplay().workArea` 用。 */
    int[] workArea() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.view.WindowMetrics metrics = windowManager.getCurrentWindowMetrics();
                android.graphics.Insets insets = metrics.getWindowInsets()
                        .getInsetsIgnoringVisibility(android.view.WindowInsets.Type.systemBars());
                android.graphics.Rect bounds = metrics.getBounds();
                return new int[]{
                        bounds.left + insets.left,
                        bounds.top + insets.top,
                        Math.max(1, bounds.width() - insets.left - insets.right),
                        Math.max(1, bounds.height() - insets.top - insets.bottom),
                };
            }
            android.util.DisplayMetrics metrics = new android.util.DisplayMetrics();
            //noinspection deprecation — getRealMetrics 在 R 以下没有替代品。
            windowManager.getDefaultDisplay().getRealMetrics(metrics);
            return new int[]{0, 0, metrics.widthPixels, metrics.heightPixels};
        } catch (Throwable error) {
            Log.w(TAG, "取工作区失败", error);
            return new int[]{0, 0, 1080, 1920};
        }
    }

    int[] cursorPoint() {
        return new int[]{lastTouchX, lastTouchY};
    }

    /**
     * 建一个 overlay 窗口并把它显示出来。
     *
     * `opts` 接受桌面端 `new BrowserWindow({...})` 的那套键；这里只消费几何相关的
     * （`x` / `y` / `width` / `height`），其余选项在安卓上没有语义，静默忽略 ——
     * 忽略比报错好，模组不该因为一个 `skipTaskbar` 就起不来。
     */
    @SuppressLint("SetJavaScriptEnabled")
    OverlayWindow create(JSONObject opts) {
        if (!canDrawOverlays()) return null;
        int[] work = workArea();
        int width = clamp(opts.optInt("width", 480), 1, work[2]);
        int height = clamp(opts.optInt("height", 200), 1, work[3]);
        int x = opts.has("x") ? opts.optInt("x", 0) : (work[2] - width) / 2;
        int y = opts.has("y") ? opts.optInt("y", 0) : work[1] + work[3] - height - 48;

        WebView webView = new WebView(context);
        // 模组页面里要 require('electron')，靠 addJavascriptInterface 注入（见 OverlayBridge）。
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.setBackgroundColor(0x00000000);
        // WebViewClient 要先于 OverlayWindow 建（它挂在 webView 上），而回调里又需要窗口，
        // 所以用一个单元素数组把引用留给回调，避免声明顺序打架。
        final OverlayWindow[] holder = new OverlayWindow[1];
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                OverlayWindow target = holder[0];
                // 每个新文档都要重新注入（导航会清掉上一个文档的 window）。
                if (target != null && target.injection != null && !target.injection.isEmpty()) {
                    view.evaluateJavascript(target.injection, null);
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                OverlayWindow target = holder[0];
                if (target != null && target.onPageFinished != null) target.onPageFinished.run();
            }
        });

        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                width,
                height,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                        : WindowManager.LayoutParams.TYPE_PHONE,
                // 透明 + 不抢焦点：对应桌面端的 transparent + showInactive。
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.LEFT;
        params.x = x;
        params.y = y;

        OverlayWindow window = new OverlayWindow(ids.getAndIncrement(), webView, params);
        holder[0] = window;
        if (pageInterfaceFactory != null) {
            Object pageInterface = pageInterfaceFactory.create(window.id);
            if (pageInterface != null) {
                webView.addJavascriptInterface(pageInterface, "__foliaIpcNative");
            }
        }
        webView.setOnTouchListener(new DragTouchListener(window));
        try {
            windowManager.addView(webView, params);
        } catch (Throwable error) {
            Log.w(TAG, "挂载 overlay 失败", error);
            return null;
        }
        windows.put(window.id, window);
        return window;
    }

    OverlayWindow find(long windowId) {
        return windows.get(windowId);
    }

    /** 把 HTML 交给窗口。用 `loadDataWithBaseURL`：`loadUrl("data:")` 在部分 WebView 上有长度限制。 */
    void loadHtml(OverlayWindow window, String html, String injection) {
        if (window == null || window.destroyed) return;
        window.injection = injection;
        window.webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    /** 页面加载完成后执行一段脚本（给 `webContents.send` 用）。 */
    void evaluate(OverlayWindow window, String script) {
        if (window == null || window.destroyed) return;
        window.webView.evaluateJavascript(script, null);
    }

    void setBounds(OverlayWindow window, int x, int y, int width, int height) {
        if (window == null || window.destroyed) return;
        window.params.x = x;
        window.params.y = y;
        window.params.width = Math.max(1, width);
        window.params.height = Math.max(1, height);
        update(window);
    }

    int[] getBounds(OverlayWindow window) {
        if (window == null) return new int[]{0, 0, 0, 0};
        return new int[]{window.params.x, window.params.y, window.params.width, window.params.height};
    }

    /**
     * 点击穿透：`setIgnoreMouseEvents` 的安卓实现。
     *
     * `FLAG_NOT_TOUCHABLE` 一挂上，这一层就完全不收触摸，事件落到下面的应用。
     * 注意桌面端的 `{ forward: true }` 在这里做不到（没有「穿透但仍收移动事件」这一档）。
     */
    void setIgnoreMouseEvents(OverlayWindow window, boolean ignore) {
        if (window == null || window.destroyed) return;
        window.ignoringMouse = ignore;
        if (ignore) {
            window.params.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        } else {
            window.params.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
        }
        update(window);
    }

    /** 显示 / 隐藏。用 `alpha` 而不是 removeView：重建 WebView 会丢页面状态。 */
    void setVisible(OverlayWindow window, boolean visible) {
        if (window == null || window.destroyed) return;
        window.visible = visible;
        window.params.alpha = visible ? 1f : 0f;
        update(window);
    }

    boolean isVisible(OverlayWindow window) {
        return window != null && !window.destroyed && window.visible;
    }

    void destroy(OverlayWindow window) {
        if (window == null || window.destroyed) return;
        window.destroyed = true;
        windows.remove(window.id);
        try {
            windowManager.removeView(window.webView);
        } catch (Throwable error) {
            Log.w(TAG, "移除 overlay 失败", error);
        }
        try {
            window.webView.destroy();
        } catch (Throwable error) {
            Log.w(TAG, "销毁 WebView 失败", error);
        }
        for (Runnable listener : window.closedListeners) {
            try {
                mainHandler.post(listener);
            } catch (Throwable error) {
                Log.w(TAG, "closed 回调失败", error);
            }
        }
        window.closedListeners.clear();
    }

    void destroyAll() {
        for (OverlayWindow window : new ArrayList<>(windows.values())) {
            destroy(window);
        }
    }

    private void update(OverlayWindow window) {
        if (window == null || window.destroyed) return;
        try {
            windowManager.updateViewLayout(window.webView, window.params);
        } catch (Throwable error) {
            Log.w(TAG, "更新 overlay 布局失败", error);
        }
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    /**
     * 拖动。桌面端靠 CSS 的 `-webkit-app-region: drag`，安卓 WebView 不支持那个属性
     * （两页都写了它，实际一律无效），所以只能自己接管触摸去挪 `params.x/y`。
     *
     * 只接管「整窗拖动区」：页面里的按钮、滑块等交互元素由模组自己标出来，这里不去认
     * ——识别 DOM 命中代价太高且不可靠，交给模组用 `setIgnoreMouseEvents` / 可拖动开关
     * 决定什么时候允许拖，比猜 DOM 稳。
     */
    private final class DragTouchListener implements View.OnTouchListener {
        private final OverlayWindow window;
        private float downRawX;
        private float downRawY;
        private int startX;
        private int startY;
        private boolean dragging;

        DragTouchListener(OverlayWindow window) {
            this.window = window;
        }

        @Override
        public boolean onTouch(View view, MotionEvent event) {
            // 无论走不走拖动，都记下落点：模组的悬停轮询要这个值。
            lastTouchX = (int) event.getRawX();
            lastTouchY = (int) event.getRawY();
            if (!window.draggable || window.ignoringMouse) return false;
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downRawX = event.getRawX();
                    downRawY = event.getRawY();
                    startX = window.params.x;
                    startY = window.params.y;
                    dragging = false;
                    return false;
                case MotionEvent.ACTION_MOVE:
                    float dx = event.getRawX() - downRawX;
                    float dy = event.getRawY() - downRawY;
                    // 小位移交给页面，避免把点击误判成拖动。
                    if (!dragging && Math.hypot(dx, dy) < 12) return false;
                    dragging = true;
                    window.params.x = startX + (int) dx;
                    window.params.y = startY + (int) dy;
                    update(window);
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    boolean wasDragging = dragging;
                    dragging = false;
                    return wasDragging;
                default:
                    return false;
            }
        }
    }
}
