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
        /** 这个 WebView 当前是否挂在 WindowManager 上（隐藏用的是 removeView，见 setVisible）。 */
        boolean attached = false;
        /**
         * 模组想要的窗口透明度（0..1）。显隐切换时不改写它，只临时把 params.alpha 压到 0，
         * 回来时还原 —— 否则一次 hide()/show() 就会把模组设的半透明改成不透明。
         */
        float alphaHint = 1f;
        boolean ignoringMouse = false;
        /** 模组在页面上画的拖动区；为 true 时触摸会拖动整个窗口而不是交给页面。 */
        /*
         * 默认 true。
         *
         * 桌面端靠 CSS 的 `-webkit-app-region: drag` 让整个窗口可拖，那是 Electron 的
         * 特性，安卓 WebView 不认这个属性 —— 于是模组在安卓上一个窗口都拖不动
         * （实测 lyric-float 的桌面歌词与悬浮窗歌词都拖不走）。
         * 模组也从不调用 setDraggable()，指望它自己打开是不现实的。
         *
         * 所以这里反默认：容器默认可拖，页面里的按钮/滑块自己挡在前面时照样能点
         * （DragTouchListener 只有位移超过 12px 才判定为拖动，点击不受影响）。
         */
        boolean draggable = true;
        /** 页面脚本，在 onPageStarted 注入（早于页面自己的内联脚本）。 */
        String injection = null;
        /** 页面加载完成回调（对应桌面端的 `did-finish-load`）。 */
        Runnable onPageFinished = null;
        final List<Runnable> closedListeners = new ArrayList<>();

        OverlayWindow(long id, WebView webView, WindowManager.LayoutParams params) {
            this.id = id;
            this.webView = webView;
            this.params = params;
            // 建窗时 params.alpha 就是模组（或默认值）想要的那份，记下来当还原值。
            this.alphaHint = params.alpha;
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

    /** 屏幕可用区域（不含系统栏），**物理像素**。给模组的那份要换成 CSS，见 workAreaCss()。 */
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

    /** 同一个工作区，换成模组那套 CSS 像素（它拿去做 `screen.getPrimaryDisplay().workArea`）。 */
    int[] workAreaCss() {
        return toCss(workArea());
    }

    int[] cursorPoint() {
        return new int[]{toCss(lastTouchX), toCss(lastTouchY)};
    }

    /**
     * 屏幕密度（CSS 像素 → 物理像素的倍率）。
     *
     * 模组按桌面端的口径给几何值：它说的 `width: 640` 是**CSS 像素**，页面里的
     * `innerWidth` 也应当是 640。安卓的 WindowManager 只认物理像素，而且 WebView 自己
     * 会按 density 把视口除回去 —— 直接把 640 当物理像素用，模组看到的视口就只有
     * 640/3 ≈ 213（实测 dpr=3，视口 213×60，内容缩在角落、后面透出桌面，看着像一块黑）。
     *
     * 所以两头都要换：给 WindowManager 的是 CSS×density，回报给模组的又是物理÷density。
     */
    private float density() {
        try {
            return Math.max(1f, context.getResources().getDisplayMetrics().density);
        } catch (Throwable error) {
            return 1f;
        }
    }

    private int toPx(int css) {
        return Math.round(css * density());
    }

    private int toCss(int px) {
        return Math.round(px / density());
    }

    private int[] toCss(int[] px) {
        return new int[]{toCss(px[0]), toCss(px[1]), toCss(px[2]), toCss(px[3])};
    }

    /**
     * 把窗口位置钳回屏幕内。
     *
     * 模组按自己的工作区算坐标，单位和时机一旦对不上（例如它缓存了上一次的 CSS 值，
     * 或者拖动中把物理值当 CSS 传回来），窗口就会被推到屏幕外 —— 实测 y=5076、
     * 屏幕高 3200，整个窗口跑出屏幕，用户只看到「不见了」。
     * 这里兜一道底：只要整块窗口完全不可见，就把它拉回来。
     */
    private int clampX(int px, int width) {
        int[] size = displaySize();
        return clamp(px, 0, Math.max(0, size[0] - width));
    }

    private int clampY(int px, int height) {
        int[] size = displaySize();
        return clamp(px, 0, Math.max(0, size[1] - height));
    }

    /**
     * 把请求的 CSS 尺寸收紧到屏幕装得下的范围。
     *
     * 模组是按桌面端的屏幕设计的：lyric-float 默认要 640 CSS 宽。这台机器 density=3、
     * 物理宽 1440，CSS 视口只有 480 —— 640 换算成物理就是 1920，比屏幕还宽 33%，
     * 窗口必然横向溢出、右侧内容永远看不到。所以超了就按可用宽收紧。
     *
     * 收的是**物理**上限：CSS 上限 = 屏幕物理宽 / density（= 480）。
     */
    private int clampCssWidth(int cssWidth) {
        int[] size = displaySize();
        int maxCss = Math.max(1, toCss(size[0]));
        return clamp(cssWidth, 1, maxCss);
    }

    private int clampCssHeight(int cssHeight) {
        int[] size = displaySize();
        int maxCss = Math.max(1, toCss(size[1]));
        return clamp(cssHeight, 1, maxCss);
    }

    /** 整个屏幕的物理尺寸（含系统栏）。 */
    private int[] displaySize() {
        try {
            android.util.DisplayMetrics metrics = new android.util.DisplayMetrics();
            windowManager.getDefaultDisplay().getRealMetrics(metrics);
            return new int[]{metrics.widthPixels, metrics.heightPixels};
        } catch (Throwable error) {
            return new int[]{1080, 1920};
        }
    }

    /**
     * 建一个 overlay 窗口并把它显示出来。
     *
     * `opts` 接受桌面端 `new BrowserWindow({...})` 的那套键；这里只消费几何相关的
     * （`x` / `y` / `width` / `height`），其余选项在安卓上没有语义，静默忽略 ——
     * 忽略比报错好，模组不该因为一个 `skipTaskbar` 就起不来。
     *
     * 几何值都是 **CSS 像素**（见 density()），落到 WindowManager 前换成物理像素。
     */
    @SuppressLint("SetJavaScriptEnabled")
    OverlayWindow create(JSONObject opts) {
        if (!canDrawOverlays()) return null;
        // ⚠ 这一整段都必须在 **CSS 像素**里算完再换物理。workArea() 给的是物理像素，
        // 拿它和模组给的 CSS width 直接相减就是两套单位打架（实测 (1440-640)/2 被当成
        // CSS，再乘 density 得到 1200，窗口直接飞出屏幕）。
        int[] work = workAreaCss();
        int width = clampCssWidth(clamp(opts.optInt("width", 480), 1, work[2]));
        int height = clampCssHeight(clamp(opts.optInt("height", 200), 1, work[3]));
        int cssX = opts.has("x") ? opts.optInt("x", 0) : work[0] + (work[2] - width) / 2;
        int cssY = opts.has("y") ? opts.optInt("y", 0) : work[1] + work[3] - height - 16;
        int x = toPx(cssX);
        int y = toPx(cssY);
        int pxWidth = toPx(width);
        int pxHeight = toPx(height);
        // 建窗这一下也钳一次：模组完全可以给一个屏幕外的坐标（它按自己那套工作区算，
        // 两边一旦差一个状态栏高度就会落到屏幕外）。
        x = clampX(x, pxWidth);
        y = clampY(y, pxHeight);

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
                pxWidth,
                pxHeight,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                        : WindowManager.LayoutParams.TYPE_PHONE,
                // 透明 + 不抢焦点：对应桌面端的 transparent + showInactive。
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.LEFT;
        params.x = x;
        params.y = y;
        /*
         * 坐标用「整个显示器」作参照系，和 workArea() 给模组的那套一致。
         *
         * 原来这里挂 FLAG_LAYOUT_NO_LIMITS：那个标志会让窗口无视 inset 自由越界，可系统仍按
         * fitTypes=statusBars 为它再让一次位，两次抵扣叠在一起，模组算出的 y 落在工作区里、
         * 系统又减掉一遍状态栏高度，窗口就被推到屏幕上方（实测 y=-161，只剩贴边一条黑线）。
         *
         * 所以：不要 NO_LIMITS，显式声明不让系统栏 inset 动这个窗口 —— params.y 就始终是
         * 相对屏幕顶部的绝对像素，和 workArea() 的 y 同一套语义。
         */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            params.setFitInsetsTypes(0);
        }

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
            window.attached = true;
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
        /*
         * 注入脚本要**先于页面自己的脚本**执行：模组的页面里第一件事就是
         * `require('electron')`，那会儿 window.require 必须已经在了。
         *
         * 靠 onPageStarted 里 evaluateJavascript 是不够的 —— 它在文档创建前后触发，
         * 时机并不保证早于页面内联 <script>，于是会看到
         * `Uncaught ReferenceError: require is not defined`。
         * 这里直接把脚本写进 <head> 开头，文档一解析就执行，顺序是确定的。
         */
        String merged = html;
        if (injection != null && !injection.isEmpty()) {
            /*
             * 触摸屏没有鼠标：模组把「显示控制条 + 半透明卡片」挂在 `body.hover` 上，
             * 而那个类只在 mouseenter 里加。这里补两件事：
             *
             *   1. 加一个常驻样式，让控制条在安卓上**始终可点**。它原本在隐藏时是
             *      `pointer-events: none`，摸一下就消失、再摸又出来，于是按钮像坏的；
             *   2. 把 hover 先打成 true，进窗口就能看到控件。
             *
             * 只加样式与类名，不改模组的脚本与逻辑。
             */
            /*
             * 各自独立成标签，**不能拼在同一个 <script> 里**。
             *
             * 以前是 `injection = touchStyle + forcedHover + injection` 再统一包一层
             * <script>，结果 <style> 被当成脚本正文 —— 浏览器解析报错，
             * 于是那一段代码连同样式文本被原样画在页面上（整块乱码）。
             */
            String touchStyle = "<style>\n"
                    + "/* 安卓宿主注入：触摸没有 hover，控制条不能依赖它才可点。 */\n"
                    + "body .controls { opacity: 1 !important; pointer-events: auto !important;\n"
                    + "  transform: none !important; }\n"
                    + "body.pinned .controls-side { visibility: visible !important; }\n"
                    + "body { -webkit-app-region: no-drag !important; }\n"
                    + "</style>";
            String forcedHover = "<script>\n"
                    + "document.addEventListener('DOMContentLoaded', function(){\n"
                    + "  if (document.body) document.body.classList.add('hover');\n"
                    + "});\n"
                    + "</script>";
            String tag = touchStyle
                    + forcedHover
                    + "<script>\n" + injection + "\n</script>";
            String lower = html.toLowerCase(java.util.Locale.ROOT);
            int head = lower.indexOf("<head>");
            if (head >= 0) {
                merged = html.substring(0, head + 6) + tag + html.substring(head + 6);
            } else {
                int htmlTag = lower.indexOf("<html");
                if (htmlTag >= 0) {
                    int close = html.indexOf('>', htmlTag);
                    if (close >= 0) merged = html.substring(0, close + 1) + tag + html.substring(close + 1);
                } else {
                    merged = tag + html;
                }
            }
        }
        window.webView.loadDataWithBaseURL(null, merged, "text/html", "utf-8", null);
        // 页面起来之后就开始喂歌词：模组自己的歌词来自宿主 WebView 的 IPC，
        // 一旦 App 退到后台那条链就断了（页面冻结），只有原生这份是常驻的。
        startLyricsPump();
    }

    /*
     * ---------------------------------------------------------------- 原生歌词泵
     *
     * 桌面端模组的歌词是主进程把播放状态 `webContents.send` 进窗口的；安卓上那套
     * 走的是宿主 WebView 里的 IPC 转发，**App 一退到后台就断**（WebView 冻结），
     * 于是模组的歌词停在最后一句不动。
     *
     * 原生这边本来就有常驻的一份：`WallpaperLyricsState`（壁纸 / 叠层 / 锁屏共用），
     * 由 `FoliaPlaybackService` 在前台后台都持续更新。这里把它按固定节拍算成「当前行
     * + 下一行 + 进度」，通过 `window.foliaNativeLyrics` 交给页面 —— 不碰模组代码，
     * 页面里的注入脚本会用它替换掉自己那份停更的数据。
     */
    private static final long LYRICS_PUMP_MS = 250L;
    private Runnable lyricsPump;
    /** 已经推过的那份字体的判据；变了才重新编码并下发。 */
    private String lastFontStamp = null;

    private void startLyricsPump() {
        if (lyricsPump != null) return;
        lyricsPump = new Runnable() {
            @Override
            public void run() {
                try {
                    pushLyricsOnce();
                } catch (Throwable error) {
                    Log.w(TAG, "推送原生歌词失败", error);
                }
                if (lyricsPump != null) {
                    mainHandler.postDelayed(this, LYRICS_PUMP_MS);
                }
            }
        };
        mainHandler.postDelayed(lyricsPump, LYRICS_PUMP_MS);
    }

    /** 把 WallpaperLyricsState 的当前快照推给每个还活着的 overlay 页面。 */
    private void pushLyricsOnce() {
        if (windows.isEmpty()) return;
        JSONObject payload = NativeLyricsBridge.snapshot();
        if (payload == null) return;
        String json = payload.toString();
        String script = "(function(){try{var p=" + json + ";"
                + "window.foliaNativeLyrics=p;"
                + "if(window.__foliaApplyNativeLyrics){window.__foliaApplyNativeLyrics(p);}"
                + "}catch(err){}})();";

        /*
         * 字体单独一条：它的载荷可能有几 MB，只在换了字体时推一次。
         * 判重放在 NativeLyricsBridge 里做（按文件 mtime+size），这里只比判据。
         */
        String fontScript = null;
        try {
            JSONObject font = NativeLyricsBridge.fontPayload(context);
            String stamp = font == null ? null : font.optString("stamp", null);
            if (stamp != null && !stamp.equals(lastFontStamp)) {
                lastFontStamp = stamp;
                fontScript = "(function(){try{var f=" + font.toString() + ";"
                        + "if(window.__foliaApplyNativeFont){window.__foliaApplyNativeFont(f);}"
                        + "}catch(err){}})();";
            }
        } catch (Throwable error) {
            Log.w(TAG, "推送原生字体失败", error);
        }

        for (OverlayWindow window : windows.values()) {
            if (window == null || window.destroyed || !window.attached) continue;
            try {
                window.webView.evaluateJavascript(script, null);
                if (fontScript != null) {
                    window.webView.evaluateJavascript(fontScript, null);
                }
            } catch (Throwable error) {
                Log.w(TAG, "推送原生歌词到窗口失败", error);
            }
        }
    }

    /** 页面加载完成后执行一段脚本（给 `webContents.send` 用）。 */
    void evaluate(OverlayWindow window, String script) {
        if (window == null || window.destroyed) return;
        window.webView.evaluateJavascript(script, null);
    }

    /** 几何值按 CSS 像素进来 / 出去；内部存的 params 是物理像素（见 density()）。 */
    void setBounds(OverlayWindow window, int x, int y, int width, int height) {
        if (window == null || window.destroyed) return;
        int pxWidth = Math.max(1, toPx(clampCssWidth(width)));
        int pxHeight = Math.max(1, toPx(clampCssHeight(height)));
        window.params.width = pxWidth;
        window.params.height = pxHeight;
        window.params.x = clampX(toPx(x), pxWidth);
        window.params.y = clampY(toPx(y), pxHeight);
        update(window);
    }

    int[] getBounds(OverlayWindow window) {
        if (window == null) return new int[]{0, 0, 0, 0};
        return toCss(new int[]{
                window.params.x, window.params.y, window.params.width, window.params.height,
        });
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
        if (window.visible == visible && window.attached == visible) return;
        window.visible = visible;
        /*
         * 隐藏必须把 View 从 WindowManager 上摘下来。
         *
         * 试过两条路都不行：只把 params.alpha 调 0 —— 窗口依然参与合成，
         * `isOnScreen=true`，模组页面 `visibilityState` 还是 visible；只调
         * `setVisibility(GONE)` —— 这个 WebView 是用 addView 直接挂在窗口上的，
         * 没有父 ViewGroup 会替它应用可见性，于是同样不生效。
         * 结果就是「切到悬浮窗歌词」时桌面歌词并没有真的让开，两套歌词叠着显示。
         *
         * 所以这里改成 add/remove：隐藏即 removeView（窗口连同合成面一起消失，
         * 也就不再吃绘制），显示时按原来的 params 重新 addView。窗口对象与页面都保留，
         * 切回来是即时的。
         */
        try {
            if (visible) {
                if (!window.attached) {
                    window.params.alpha = window.alphaHint;
                    windowManager.addView(window.webView, window.params);
                    window.attached = true;
                } else {
                    window.params.alpha = window.alphaHint;
                    windowManager.updateViewLayout(window.webView, window.params);
                }
            } else {
                if (window.attached) {
                    windowManager.removeView(window.webView);
                    window.attached = false;
                }
            }
        } catch (Throwable error) {
            Log.w(TAG, "切换 overlay 显隐失败", error);
        }
    }

    boolean isVisible(OverlayWindow window) {
        return window != null && !window.destroyed && window.visible;
    }

    void destroy(OverlayWindow window) {
        if (window == null || window.destroyed) return;
        window.destroyed = true;
        windows.remove(window.id);
        try {
            if (window.attached) {
                windowManager.removeView(window.webView);
                window.attached = false;
            }
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
        /*
         * 窗口都没了就把歌词泵停掉。
         *
         * 泵自己每拍只做 `windows.isEmpty()` 就返回，但那还是 250ms 一次的主线程回调 ——
         * 模组浮窗关掉之后它没有理由继续存在。下次开窗时 loadHtml 会重新 startLyricsPump。
         */
        stopLyricsPump();
    }

    /** 停掉歌词泵；`lyricsPump` 置空之后正在排队的那一拍醒来会自己退出（见 run 里的判空）。 */
    private void stopLyricsPump() {
        Runnable pending = lyricsPump;
        lyricsPump = null;
        if (pending != null) mainHandler.removeCallbacks(pending);
    }

    private void update(OverlayWindow window) {
        if (window == null || window.destroyed) return;
        // 隐藏中的窗口已经不在 WindowManager 上：此时 updateViewLayout 只会抛
        // IllegalArgumentException。几何值已经写进 params，show 的时候自然带出去。
        if (!window.attached) return;
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
    /**
     * 触摸接管：合成 hover + 窗口拖动。
     *
     * 桌面端靠 CSS 的 `-webkit-app-region: drag` 拖动整个窗口，安卓 WebView 不认那个属性
     * （两页都写了它，实际一律无效），所以只能自己接管触摸。
     *
     * ⚠ 这里的规矩是「**事件永远先给页面**」：
     *   · 按下 → 先问页面「这个点是不是可交互元素（按钮 / 滑块 / 开关）」，
     *     是就完全不管，让 page 自己走完整的 down/move/up；
     *   · 不是才允许拖动，而且一旦开始拖，就把后续事件从页面手里拿走
     *     （页面此时已经知道「这一下不是点我」）。
     *
     * 之前那两个问题都出在没分清楚这一点上：
     *   · 拖动在 MOVE 里才返回 true，页面前半段收到 MOVE、后半段收不到，
     *     按钮的按下态被打断 —— 表现是「点一下没反应」；
     *   · hover 用固定 2.6 秒定时撤回，撤回后 `.controls` 变回
     *     `pointer-events: none`，于是按钮「出来一下又消失」。
     */
    private final class DragTouchListener implements View.OnTouchListener {
        private final OverlayWindow window;
        private float downRawX;
        private float downRawY;
        private int startX;
        private int startY;
        private boolean dragging;
        /** 这一下落点是否落在可交互元素上（页面回话之前默认按「是」处理，宁可放过不误拖）。 */
        private boolean downOnInteractive;
        /** 页面回话的序号：异步查 DOM 时防止旧结果盖掉新按下。 */
        private int probeSeq;
        /** 拖动进行中：移动事件不再交给页面。 */
        private boolean stole;

        DragTouchListener(OverlayWindow window) {
            this.window = window;
        }

        /**
         * 让页面把「这一点是不是可交互元素」算出来，异步回调。
         *
         * 判据与模组自己的 CSS 对齐：命中 `button / input / select / textarea / a`，
         * 或者命中祖先里带 `-webkit-app-region: no-drag` 的元素（模组就是这么标按钮的），
         * 就当作可交互 —— 这两种覆盖了 lyric-float 的控制条、音量滑条与关闭键。
         */
        private void probeInteractive(float rawX, float rawY, int seq) {
            int cssX = toCss((int) rawX) - toCss(window.params.x);
            int cssY = toCss((int) rawY) - toCss(window.params.y);
            // 直接接返回值：evaluateJavascript 的 ValueCallback 给出同步算好的布尔，
            // 不用在页面里挂全局回调（那样还得自己管请求配对，容易漏）。
            String script = "(function(){try{"
                    + "var el=document.elementFromPoint(" + cssX + "," + cssY + ");"
                    + "var hit=false;"
                    + "if(el){"
                    + "  var tag=(el.tagName||'').toLowerCase();"
                    + "  if(tag==='button'||tag==='input'||tag==='select'||tag==='textarea'||tag==='a'){hit=true;}"
                    + "  var n=el;"
                    + "  while(!hit&&n&&n.nodeType===1){"
                    + "    var r=getComputedStyle(n).getPropertyValue('-webkit-app-region');"
                    + "    if(r&&r.indexOf('no-drag')>=0){hit=true;break;}"
                    + "    n=n.parentElement;"
                    + "  }"
                    + "}"
                    + "return hit?'1':'0';"
                    + "}catch(err){return '1';}})()";
            try {
                window.webView.evaluateJavascript(script, value -> {
                    // 只认最新一次按下的答复；旧的迟到答复直接丢掉。
                    if (seq != probeSeq) return;
                    downOnInteractive = !(value != null && value.indexOf("0") >= 0);
                });
            } catch (Throwable error) {
                Log.w(TAG, "probing interactive element failed", error);
            }
        }

        /** 让页面把 hover 收起（模组自己会在 mouseleave 里改 body.hover）。 */
        private void sendHover(boolean on) {
            if (window == null || window.destroyed) return;
            String type = on ? "mouseenter" : "mouseleave";
            String script = "(function(){try{"
                    + "window.dispatchEvent(new MouseEvent('" + type + "',{bubbles:false,cancelable:false}));"
                    + "document.body&&document.body.classList.toggle('hover'," + on + ");"
                    + "}catch(err){}})();";
            try {
                window.webView.evaluateJavascript(script, null);
            } catch (Throwable error) {
                Log.w(TAG, "sending synthetic hover failed", error);
            }
        }

        @Override
        public boolean onTouch(View view, MotionEvent event) {
            // 无论走不走拖动，都记下落点：模组的悬停轮询要这个值。
            lastTouchX = (int) event.getRawX();
            lastTouchY = (int) event.getRawY();
            if (window == null || window.destroyed) return false;

            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downRawX = event.getRawX();
                    downRawY = event.getRawY();
                    startX = window.params.x;
                    startY = window.params.y;
                    dragging = false;
                    stole = false;
                    // 先按「可交互」放行；页面回话说不是，才允许后面拖。
                    downOnInteractive = true;
                    final int seq = ++probeSeq;
                    probeInteractive(downRawX, downRawY, seq);
                    // 按下即悬停：控制条淡入。**不再定时撤回**，只在真正离开时收。
                    sendHover(true);
                    return false;
                case MotionEvent.ACTION_MOVE: {
                    if (!window.draggable || window.ignoringMouse || downOnInteractive) return false;
                    float dx = event.getRawX() - downRawX;
                    float dy = event.getRawY() - downRawY;
                    if (!dragging && Math.hypot(dx, dy) < 10) return false;
                    dragging = true;
                    stole = true;
                    window.params.x = clampX(startX + (int) dx, window.params.width);
                    window.params.y = clampY(startY + (int) dy, window.params.height);
                    update(window);
                    return true;
                }
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    boolean wasDragging = dragging;
                    dragging = false;
                    /*
                     * 这里原来写着 `window.alphaHint = window.alphaHint;` —— 一句自我赋值，
                     * 什么也没做。它的原意大概是「拖完把透明度还原」，但拖动从头到尾没有改过
                     * `params.alpha`（只挪 x/y，见 ACTION_MOVE），所以没有可还原的东西，删掉。
                     *
                     * 也**不**在这里收回 hover：控制条能不能点已经由注入的样式保证
                     * （`body .controls { pointer-events: auto !important }`，见上面 touchStyle），
                     * 而收回 `body.hover` 会让模组自己那套「悬停时半透明」的状态跟着抖一下。
                     * 手指抬起来之后没有「离开窗口」这个事件，保持现状比假装离开更接近触屏的事实。
                     */
                    return wasDragging || stole;
                default:
                    return false;
            }
        }
    }
}
