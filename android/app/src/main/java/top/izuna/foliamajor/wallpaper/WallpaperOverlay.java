package top.izuna.foliamajor.wallpaper;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.ActivityOptions;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.util.DisplayMetrics;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.Gravity;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import top.izuna.foliamajor.LockScreenMusicActivity;

import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;

/**
 * 壁纸之上的可视化叠层。
 *
 * 为什么要这么做：WallpaperService 只能往 Surface 上画原生 GLES，而播放页的十几个可视化
 * 是 PixiJS / three.js 场景。想让壁纸「和播放页一模一样」，唯一的办法是让壁纸直接跑
 * 同一套渲染代码 —— 于是叠一层 WebView，加载 dist 里的 wallpaper.html。
 *
 * 几个必须踩准的点：
 *
 * 1. **必须用 TYPE_APPLICATION_OVERLAY 并申请 SYSTEM_ALERT_WINDOW。**
 *    WallpaperService.Engine 只给 SurfaceHolder，没有 View 层级，挂不了 WebView。
 *    拿不到权限时整个叠层静默不启用（原生 GLES 那套照常画，不至于白屏）。
 *
 * 2. **不能用 file:// 加载页面。** 页面是 ES module，file:// 下模块脚本会被当跨源拒绝。
 *    这里用 https://localhost/... 并把请求拦回 assets —— 顺带还有个好处：
 *    origin 和应用主 WebView 完全相同，localStorage 是共享的，
 *    用户的主题/可视化设置不用再重复传一遍。
 *
 * 3. **FLAG_NOT_TOUCHABLE 是必须的。** 叠层盖在桌面上，吃触摸的话桌面就点不动了。
 */
public final class WallpaperOverlay {

    /** 叠层页面的加载地址。host 只是为了对得上拦截规则，不真的发网络请求。 */
    private static final String PAGE_URL = "https://localhost/wallpaper.html";
    private static final String LOCAL_HOST = "localhost";
    /**
     * 检查间隔。注意它只是**多久看一眼有没有变化**，不是推送间隔 ——
     * 没变化就不注入 JS。
     *
     * 为什么不按固定节拍推：每推一次页面就把锚点重设到原生那一刻的位置，
     * 两边的墙钟有几毫秒差，页面自己的插值刚走出去就被拉回来，
     * 看起来就是歌词/动效在抽搐。页面本来就是「锚点 + 自己按 rAF 走」的模型，
     * 持续校正只会帮倒忙。
     */
    private static final long PUSH_INTERVAL_MS = 250L;

    private final Context context;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private WebView webView;
    private WindowManager.LayoutParams params;
    private boolean added = false;
    private boolean pushScheduled = false;

    /** 壁纸当前是否可见（由壁纸服务的 onVisibilityChanged 设置）。 */
    private boolean wallpaperVisible = false;
    /** 应用侧托管：叠层总开关打开时由应用进程直接挂着，不要求系统壁纸是我们。 */
    private boolean appDriven = false;

    /**
     * 屏幕是否亮着。
     *
     * 息屏这件事只有系统广播会说：壁纸服务在息屏时确实会回调不可见，但总开关打开后
     * 叠层由应用进程托管，壁纸不可见也不再收摊（那正是「不要求是我们的壁纸」的代价）。
     * 没有这个标记，WebView 会一整夜在后台跑 rAF。
     */
    private boolean screenOn = true;
    /** 当前是否停在锁屏之上。只有「音乐锁屏」开着时它才参与判定。 */
    private boolean keyguardLocked = false;
    /** 上一次复核锁屏状态的墙钟。见 watchTask 开头那段。 */
    private long keyguardCheckedAtMs = 0L;
    /**
     * Folia 自己的界面是否在前台。
     *
     * 系统壁纸不是我们的时候，「用户现在在不在桌面」这件事没有任何现成信号 ——
     * 壁纸服务根本不会被创建，`wallpaperVisible` 永远是 false，于是叠层开了也不显示
     * （除非先去壁纸选择界面激活一次）。这个标记是那条死路的出口：
     * 我们的界面不在前台，就当用户在桌面上。
     */
    private boolean appForeground = false;

    /** 由 MainActivity 的生命周期报告。 */
    public void setAppForeground(boolean value) {
        runOnUi(() -> {
            if (appForeground == value) {
                return;
            }
            appForeground = value;
            scheduleWatch();
        });
    }

    /** 系统当前选中的动态壁纸是不是我们。带缓存：判定里每秒都可能问到，不必每次都过 binder。 */
    private long ourWallpaperCheckedAtMs = 0L;
    private boolean ourWallpaperCached = false;

    private boolean isOurWallpaperSet() {
        long now = SystemClock.elapsedRealtime();
        if (now - ourWallpaperCheckedAtMs < 3000L) {
            return ourWallpaperCached;
        }
        ourWallpaperCheckedAtMs = now;
        try {
            android.app.WallpaperInfo info =
                    android.app.WallpaperManager.getInstance(context).getWallpaperInfo();
            ourWallpaperCached = info != null
                    && context.getPackageName().equals(info.getPackageName());
        } catch (Throwable error) {
            ourWallpaperCached = false;
        }
        return ourWallpaperCached;
    }

    /**
     * 进程级单例。
     *
     * 壁纸服务和应用在同一个进程里，两边都可能想挂这一层。
     * 各建一份的话桌面上会叠出两层完全重合的画面（还各自跑一份 WebView），
     * 所以统一从这里取。
     */
    private static final String TAG = "WallpaperOverlay";

    private static WallpaperOverlay instance;

    public static synchronized WallpaperOverlay shared(Context context) {
        if (instance == null) {
            instance = new WallpaperOverlay(context.getApplicationContext());
        }
        return instance;
    }

    /**
     * 音乐锁屏页面。非空时叠层挂到**它的窗口**上（TYPE_APPLICATION_PANEL + 它的 token），
     * 于是同一层 WebView 就画在锁屏之上 —— 见 LockScreenMusicActivity 里为什么不走悬浮窗。
     */
    private Activity lockScreenHost = null;

    /**
     * 因为「这一轮已经没东西可显示」退过场（歌词唱完 / 是纯音乐）。
     *
     * 没有这个标记就会陷入死循环：唱完 → 不该显示 → 结束锁屏页 → 宿主变 null →
     * 下一轮巡检看「锁屏条件还成立」又把它起起来 → 还是没内容 → 再结束……
     * 用户看到的就是「锁屏界面进进出出」，而且每次重启都要撞一次后台启动限制，
     * 三次配额用光之后彻底不再起 —— 于是「然后就没反应了」。
     *
     * 和 lockScreenDismissed 分开：那是**用户亲手关的**（换歌也不该自己回来），
     * 这一条是**内容播完了**（换了一首有歌词的歌，当然可以再来）。
     */
    private volatile boolean lockScreenContentDone = false;
    /** 换歌检测：歌名变了就允许锁屏页再来一次。 */
    private String lastSongTitle = null;

    /**
     * 用户自己把锁屏页关掉了（上滑 / ✕ / 返回键）。
     *
     * 不清这个标记的话，下一轮巡检会发现「宿主没了、但锁屏条件还成立」，
     * 于是退回悬浮窗那条路再挂一层上来 —— 用户刚关掉的又自己回来了，看着像关不掉。
     * 下次息屏（新的一轮锁屏）时清零：那时是重新开始，不是"反悔"。
     */
    private volatile boolean lockScreenDismissed = false;

    /** 见 lockScreenDismissed。由 LockScreenMusicActivity 在主动退场时调用。 */
    public void noteLockScreenDismissedByUser() {
        lockScreenDismissed = true;
        /*
         * 用户亲手关掉：稳定结论**立刻**钉成 false，并且当场起步淡出。
         *
         * 少了这一句就是「上滑之后抽搐一下又回来」：
         * finish() 到 onDestroy（宿主置空）之间还有几百毫秒，这段时间
         * `lockScreenHost != null` 仍然成立，shouldShow() 因此一直是 true；
         * 淡出刚起步，巡检下一轮看到 want=true 就把正在淡出的窗口**反向淡回**
         * —— 用户看到的正是一下一下的抽搐，而不是退出。
         */
        runOnUi(() -> {
            settleHidden();
            requestHide();
        });
    }

    /** 音乐锁屏自诊断：起没起来 / 是不是被系统拦了（见 lockScreenStatus）。 */
    private volatile boolean lockScreenStarted = false;
    private volatile boolean lockScreenBlocked = false;
    private volatile int lockScreenAttempts = 0;
    private volatile String lockScreenLastError = null;

    /**
     * 叠层窗口每次挂上之后通知一声。
     *
     * 只服务于锁屏页的底部面板：同级的子窗口按**添加顺序**叠，而叠层在锁屏期间会被
     * 反复摘掉重挂（换宿主、自愈、转屏），每重挂一次它就变成最后添加的那一个，
     * 把面板压在下面 —— 画面上看不见面板（虽然因为叠层是 NOT_TOUCHABLE，点得到）。
     * 面板拿到这个通知就把自己摘了再挂一次，重新回到最上面。
     */
    private volatile Runnable windowAttachedListener = null;

    public void setWindowAttachedListener(Runnable listener) {
        windowAttachedListener = listener;
    }

    /**
     * 切换叠层的宿主：null = 挂在系统悬浮窗上（桌面 / 所有应用），非 null = 挂在锁屏页面上。
     *
     * 宿主一换，窗口类型就变了（OVERLAY ↔ PANEL），而 WindowManager 不允许改已加入窗口的
     * 类型 —— 必须整层摘掉再挂。切换本身很少发生（锁屏 / 解锁），代价可以接受。
     */
    public void setLockScreenHost(Activity activity) {
        runOnUi(() -> {
            if (lockScreenHost == activity) {
                return;
            }
            if (activity != null) {
                // 记下"这一层是什么时候露面的"，见 LOCK_SCREEN_MIN_VISIBLE_MS。
                lockScreenShownAtMs = SystemClock.elapsedRealtime();
            }
            lockScreenHost = activity;
            if (added) {
                detach();
            }
            // 宿主交接是显式动作（锁屏页起来了 / 退场了），立刻对齐，别等迟滞。
            alignWantShowNow();
            ensureShown();
            scheduleWatch();
        });
    }

    /**
     * 把稳定结论钉成「不显示」。
     *
     * 收起这个动作一旦真的发生了（淡出到底 / 进入休眠 / 页面已销毁），稳定结论
     * 就必须跟着翻过去，不能还停在 true —— 想再出来，必须重新挣得一段连续的
     * 「该显示」（见 RESHOW_DEBOUNCE_MS）。否则「刚收下就被同一个抖动拉回来」
     * 会在淡出 ↔ 淡入之间无限循环，而那正是「淡出后马上淡入并且不消失」的形状。
     */
    private void settleHidden() {
        wantShow = false;
        flipSinceMs = 0L;
    }

    /**
     * 该显示就确保它在显示：没挂就挂上；正休眠着就在**原页面**上淡回来。
     *
     * 用户动作（开开关 / 回到桌面 / 锁屏页交接）都走这里，和 watchTask 的巡检
     * 走同一条路，免得两处对"休眠"的处理不一样。
     */
    private void ensureShown() {
        if (!wantShowStable()) {
            return;
        }
        if (dormantSinceMs > 0L) {
            wakeFromDormant();
        } else if (!added) {
            attach();
        }
    }

    /** 从休眠里醒过来：淡入的是原来那份页面，不走「销毁 → 重建 → 等首帧」。 */
    private void wakeFromDormant() {
        dormantSinceMs = 0L;
        // 休眠期间巡检是停推的，先把当前歌词整份补推一次再淡入，
        // 免得淡入的是休眠前那一帧的旧内容。
        lastSignature = null;
        pushState();
        startFadeIn();
    }

    /*
     * 起音乐锁屏页。息屏时就起好，亮屏那一刻它已经在锁屏上了。
     *
     * 这里最大的坑不在代码，在 Android 的**后台启动 Activity 限制**（Android 10 起）：
     * 从后台（广播里也算）startActivity 会被**静默拒绝** —— 不抛异常、不返回失败，
     * 只有系统自己往 logcat 里打一行。表现就是「开了开关，什么都没发生」。
     *
     * 系统留的口子主要是两条：
     *  · 应用此刻**有可见窗口**。叠层正挂着就命中这一条 —— 所以调用它的时机必须
     *    在 detach() **之前**：先摘窗口再起 Activity，等于亲手把唯一能用的豁免拆掉。
     *    （这一条就是「息屏起锁屏页」之前一直不生效的原因。）
     *  · Android 14+ 允许应用用 PendingIntent 放行自己
     *    （MODE_BACKGROUND_ACTIVITY_START_ALLOWED），这是官方给的路子。
     *
     * 两条都不保证成功（国内 ROM 还各自有一个「锁屏显示 / 后台弹出界面」开关），
     * 所以下面还带探测与重试，并把结果记进 lockScreenStatus()：用户在设置页里能直接
     * 看到「被系统拦了」，而不是对着一个没反应的开关干瞪眼（logcat 在真机上很难取）。
     */
    private static final int MAX_LOCK_SCREEN_ATTEMPTS = 3;
    /** 起完之后隔多久看一眼宿主有没有真的来报到。 */
    private static final long LOCK_SCREEN_PROBE_MS = 900L;

    private void maybeStartLockScreen() {
        if (lockScreenHost != null) return;
        // 总开关关了就不许再起（见 overlayMasterEnabled：关了还起就是闪烁的来源）。
        if (!overlayMasterEnabled()) return;
        if (!lockScreenWanted()) return;
        /*
         * 这两条「本次锁屏周期内别再来」的标记必须挡在**这里**，不能只挡在
         * ensureLockScreenAttempt() 里。
         *
         * 亮屏那一刻和探测重试都是**直接**调本方法的（不经过 ensure），于是那道检查被绕过：
         * 唱完 → 起页 → 发现没内容 → finish 并把 lockScreenContentDone 钉住 →
         * 下一轮换条路又调本方法 → 根本没看 contentDone → 再起 → 再 finish。
         * 用户看到的就是「锁屏上一直抽出、闪一下又没」，直到三次配额用光才停。
         *
         * 所以这里是唯一入口，守卫全部收在这里。
         */
        if (lockScreenDismissed) return;
        if (lockScreenContentDone) return;
        WallpaperLyricsState.Snapshot snapshot = WallpaperLyricsState.get();
        /*
         * 壁纸样式是「精简」时**根本不该起**锁屏页。
         *
         * 少了这一条就是「闪出播放界面，然后突然消失」的一种：起页 → 叠层一判
         * shouldShow()（精简模式直接返回 false）→ 立刻 finish → 下一轮又起。
         * 用户没解锁、没暂停、也没唱完，看到的却是一次次的闪现。
         */
        if ("minimal".equals(snapshot.visualizerMode)) return;
        // 没在播就别占着锁屏：那只会得到一个空的可视化页面。
        if (!snapshot.playing) return;
        lockScreenAttempts += 1;
        startLockScreenActivity();
        scheduleLockScreenProbe();
    }

    /**
     * 确保「起锁屏页」这件事有人在试（幂等）。
     *
     * 不能只在息屏那一刻试一次：那时可能还没开始播放，或者那一次被系统拦了 ——
     * 之后就再没有别的事件会去补。巡检每轮问一句，代价可以忽略。
     */
    private void ensureLockScreenAttempt() {
        if (lockScreenHost != null) return;
        // 用户刚关掉过：别再硬塞回去（见 lockScreenDismissed）。
        if (lockScreenDismissed) return;
        // 这一轮已经播完了：等换一首有歌词的歌再说（见 lockScreenContentDone）。
        if (lockScreenContentDone) return;
        if (!overlayMasterEnabled()) return;
        if (!lockScreenWanted()) return;
        if (!WallpaperLyricsState.get().playing) return;
        if (lockScreenAttempts >= MAX_LOCK_SCREEN_ATTEMPTS) return;
        // 已经有一条探测链在跑：别叠第二条（每次都会再加一次 attempt，三次配额会被秒光）。
        if (lockScreenProbePending) return;
        maybeStartLockScreen();
    }

    private void startLockScreenActivity() {
        Intent intent = new Intent(context, LockScreenMusicActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_NO_ANIMATION
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        // 第一条路：直接起。命中「应用有可见窗口」那条豁免时就是它成的。
        try {
            context.startActivity(intent);
        } catch (Throwable error) {
            lockScreenLastError = String.valueOf(error.getMessage());
            Log.w(TAG, "Direct lock screen start failed", error);
        }
        /*
         * 第二条路：Android 14+ 允许应用自己放行自己的后台启动。
         *
         * 两条都发（同一个 Activity 带 CLEAR_TOP + SINGLE_TOP，重复启动是幂等的），
         * 哪条先被系统放行算哪条 —— 判别不了时机，就只能都试。
         */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            try {
                PendingIntent pending = PendingIntent.getActivity(context, 0, intent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                ActivityOptions options = ActivityOptions.makeBasic();
                options.setPendingIntentBackgroundActivityStartMode(
                        ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
                pending.send(context, 0, null, null, null, null, options.toBundle());
            } catch (Throwable error) {
                lockScreenLastError = String.valueOf(error.getMessage());
                Log.w(TAG, "PendingIntent lock screen start failed", error);
            }
        }
    }

    private boolean lockScreenProbePending = false;

    /** 锁屏页露面的时刻（见 finishLockScreen 里的「最短可见时长」）。 */
    private long lockScreenShownAtMs = 0L;
    /** 已经排了一次延后退场了，别重复排。 */
    private boolean lockScreenFinishPending = false;
    /**
     * 锁屏页至少要在屏幕上待这么久才允许被判退场。
     *
     * 1.2 秒是权衡：短于它，"刚亮屏就闪一下没了"照样发生；长于它，用户已经解锁了
     * 却还被这一层挡着（它吃触摸）。一瞬间的停留看不出来，挡住操作则立刻能被察觉。
     */
    private static final long LOCK_SCREEN_MIN_VISIBLE_MS = 1200L;

    private void scheduleLockScreenProbe() {
        handler.removeCallbacks(lockScreenProbe);
        handler.postDelayed(lockScreenProbe, LOCK_SCREEN_PROBE_MS);
        lockScreenProbePending = true;
    }

    private final Runnable lockScreenProbe = new Runnable() {
        @Override
        public void run() {
            lockScreenProbePending = false;
            if (lockScreenHost != null) {
                lockScreenStarted = true;
                lockScreenBlocked = false;
                return;
            }
            // 已经不需要它了（用户解锁了 / 关了开关 / 停了）：别再撞系统那道限制。
            if (!overlayMasterEnabled() || !lockScreenWanted()
                    || !WallpaperLyricsState.get().playing) {
                lockScreenStarted = false;
                lockScreenBlocked = false;
                return;
            }
            if (lockScreenAttempts < MAX_LOCK_SCREEN_ATTEMPTS) {
                maybeStartLockScreen();
                return;
            }
            // 三次都起不来：基本可以确定是系统那道限制（或 ROM 的「锁屏显示」开关）。
            lockScreenBlocked = true;
            Log.w(TAG, "Lock screen page never came up after " + lockScreenAttempts
                    + " attempts (last error: " + lockScreenLastError + ")"
                    + " — likely blocked by the background activity start restriction"
                    + " or the ROM's 'show on lock screen' permission");
        }
    };

    /** 音乐锁屏自诊断。设置页直接读它，用户不必去翻 logcat。 */
    public static final class LockScreenStatus {
        public final boolean started;
        public final boolean blocked;
        public final boolean hosted;
        public final int attempts;
        public final String lastError;
        /** 上一次为什么退出。真机上 logcat 基本取不到，只能靠它。 */
        public final String lastExit;

        LockScreenStatus(boolean started, boolean blocked, boolean hosted,
                int attempts, String lastError, String lastExit) {
            this.started = started;
            this.blocked = blocked;
            this.hosted = hosted;
            this.attempts = attempts;
            this.lastError = lastError;
            this.lastExit = lastExit;
        }
    }

    public LockScreenStatus lockScreenStatus() {
        return new LockScreenStatus(lockScreenStarted, lockScreenBlocked, lockScreenHost != null,
                lockScreenAttempts, lockScreenLastError, lockScreenLastExit);
    }

    /** 上一次锁屏页退场的原因。见 describeHideReason。 */
    private volatile String lockScreenLastExit = null;

    /**
     * 这一轮「不该显示」到底卡在哪一条。
     *
     * 没有它，锁屏页"闪一下就没了"只能靠猜：是系统拦了？是没锁着？还是歌词唱完了？
     * 真机上 logcat 基本取不到（应用没在调试、厂商还常把日志级别调高），
     * 所以只能把这个结论写进诊断，让用户在设置页里直接看到。
     */
    private String describeHideReason() {
        if (!overlayMasterEnabled()) {
            return "叠层总开关已关闭";
        }
        if (!screenOn) {
            return "屏幕已熄灭";
        }
        WallpaperLyricsState.Snapshot snapshot = WallpaperLyricsState.get();
        if ("minimal".equals(snapshot.visualizerMode)) {
            return "壁纸样式是「精简」（精简模式不挂叠层）";
        }
        if (snapshot.placeholderOnly && tuningFlag("wp.skipInstrumental", true)
                && snapshot.positionMs() > INSTRUMENTAL_CONFIRM_MS) {
            return "纯音乐，且开了「跳过纯音乐」";
        }
        if (!snapshot.playing && tuningFlag("wp.hideWhenPaused", true)) {
            return "播放已暂停，且开了「暂停时隐藏」";
        }
        if (lyricsFinished(snapshot)) {
            return "歌词已唱完，且开了「唱完自动隐藏」";
        }
        if (lockScreenHost != null) {
            return "未知（锁屏页仍在，但被判为不该显示）";
        }
        return "不在锁屏上，桌面条件也不满足";
    }

    /**
     * 这一轮是不是**真的**没内容可显示。
     *
     * 只有这几种才值得把「本次锁屏周期内别再起来」钉死（见 lockScreenContentDone）。
     * 总开关、精简模式、息屏这些是**暂时**条件：为它们钉死的话，条件一恢复
     * 锁屏页却再也不来了 —— 而反过来不钉，它们各自在 maybeStartLockScreen 里另有守卫。
     */
    private boolean isContentExhausted() {
        WallpaperLyricsState.Snapshot snapshot = WallpaperLyricsState.get();
        if (lyricsFinished(snapshot)) {
            return true;
        }
        if (snapshot.placeholderOnly && tuningFlag("wp.skipInstrumental", true)
                && snapshot.positionMs() > INSTRUMENTAL_CONFIRM_MS) {
            return true;
        }
        return !snapshot.playing && tuningFlag("wp.hideWhenPaused", true);
    }

    /** 锁屏页**不是**我们主动 finish 掉的时候（被系统回收了）由 Activity 调来记一笔。 */
    public void noteLockScreenUnexpectedDestroy() {
        lockScreenLastExit = "被系统回收（不是主动退出）";
    }

    /**
     * 结束音乐锁屏页。宿主没了，setLockScreenHost(null) 会把窗口摘掉。
     *
     * @param contentDone 是不是因为「这一轮已经没东西可显示」而退场（见
     *                    lockScreenContentDone）。解锁 / 亮屏时发现没锁着而退场的
     *                    不算 —— 那是正常的退场，下次锁屏照常再来。
     */
    private void finishLockScreen(boolean contentDone) {
        lockScreenLastExit = describeHideReason();
        Log.w(TAG, "Lock screen page going away: " + lockScreenLastExit);
        if (contentDone) {
            lockScreenContentDone = true;
        }
        Activity host = lockScreenHost;
        if (host == null) return;
        /*
         * 最短可见时长：刚露面就被判退场的话，用户看到的就是「亮屏闪一下就没了，
         * 我啥也没干」—— 而起页本身要跨进程、要重建一次叠层页面，头一秒里
         * 各种信号本来就不稳（keyguard 可能还没挂上、播放状态可能还没推到）。
         *
         * 所以退场请求在最短时长之内一律**推迟**到点再执行，而不是立刻 finish。
         * 推迟的量也就一秒出头，用户解锁后这一层是多留一瞬，不是赖着不走。
         */
        long shownFor = SystemClock.elapsedRealtime() - lockScreenShownAtMs;
        if (shownFor < LOCK_SCREEN_MIN_VISIBLE_MS) {
            if (lockScreenFinishPending) {
                return;
            }
            lockScreenFinishPending = true;
            final boolean done = contentDone;
            handler.postDelayed(() -> {
                lockScreenFinishPending = false;
                finishLockScreenNow(done);
            }, LOCK_SCREEN_MIN_VISIBLE_MS - shownFor);
            return;
        }
        finishLockScreenNow(contentDone);
    }

    private void finishLockScreenNow(boolean contentDone) {
        if (contentDone) {
            lockScreenContentDone = true;
        }
        Activity host = lockScreenHost;
        if (host == null) return;
        try {
            host.finish();
        } catch (Throwable error) {
            Log.w(TAG, "Could not finish the lock screen activity", error);
        }
    }

    /**
     * 屏幕亮灭 / 解锁的广播。
     *
     * 「屏幕灭了」和「用户解锁了」这两件事只有广播会说：锁屏时壁纸照样在画（壁纸服务
     * 的可见性不一定翻转），而叠层由应用托管之后也没有别人替它收摊。
     * 这两个 action 在 manifest 里注册是收不到的（系统只发给动态注册的接收器），
     * 所以必须挂在进程级单例上。
     */
    private void installScreenStateReceiver() {
        android.content.IntentFilter filter = new android.content.IntentFilter();
        filter.addAction(Intent.ACTION_SCREEN_ON);
        filter.addAction(Intent.ACTION_SCREEN_OFF);
        filter.addAction(Intent.ACTION_USER_PRESENT);
        android.content.BroadcastReceiver receiver = new android.content.BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                String action = intent == null ? null : intent.getAction();
                if (Intent.ACTION_SCREEN_OFF.equals(action)) {
                    screenOn = false;
                    /*
                     * 顺序不能换：**先**把锁屏页起起来，**再**摘叠层。
                     *
                     * Android 10+ 拦后台启动 Activity，豁免条件之一是「应用此刻有可见窗口」——
                     * 叠层正挂着就命中这一条。先 detach() 等于亲手把唯一的豁免拆掉，
                     * 之后不管重试几次都只能拿到静默拒绝。这正是「开了音乐锁屏，
                     * 但从来没有锁屏界面」的原因。
                     */
                    lockScreenAttempts = 0;
                    lockScreenBlocked = false;
                    // 新的一轮锁屏：上次"用户自己关掉了"和"上一首唱完了"都不算数了。
                    lockScreenDismissed = false;
                    lockScreenContentDone = false;
                    maybeStartLockScreen();
                    // 息屏看不见动画，直接摘掉（走淡出没有意义，还会让 WebView 多活一秒）。
                    if (added) {
                        detach();
                    }
                    scheduleWatch();
                } else if (Intent.ACTION_SCREEN_ON.equals(action)) {
                    screenOn = true;
                    /*
                     * 亮屏才是这一层真正"露面"的时刻 —— 它多半在息屏那一刻就已经起好了
                     * （那时屏幕是黑的，看不看得见无所谓）。所以最短可见时长要从**这里**
                     * 重新起算：按 Activity 创建时刻算的话，等到亮屏时早已超过 1.2 秒，
                     * 保护形同虚设，"亮屏闪一下就没"照样发生。
                     */
                    if (lockScreenHost != null) {
                        lockScreenShownAtMs = SystemClock.elapsedRealtime();
                    }
                    refreshKeyguardLocked();
                    // 亮屏那一刻 Keyguard 未必已经挂上，隔一拍再确认一次：
                    // 少了这一下，「音乐锁屏」在部分机型上要等下一次事件才出现。
                    handler.postDelayed(() -> {
                        refreshKeyguardLocked();
                        // 补一次：息屏那次启动可能被后台启动限制挡掉了。
                        // 亮屏是全新的一次机会（可能刚好命中豁免），重试计数归零再试。
                        if (keyguardLocked) {
                            lockScreenAttempts = 0;
                            maybeStartLockScreen();
                        } else {
                            /*
                             * 亮屏后发现没锁着 —— **先别急着退场**。
                             *
                             * 亮屏那一刻 keyguard 未必已经挂上（部分机型要等几百毫秒，
                             * 开了人脸/指纹解锁的更是如此），这时读到的"没锁"是假的。
                             * 照它立刻 finish，用户看到的就是「锁屏页闪了一下就没了」——
                             * 而它为了这一下已经跨进程起了 Activity、重建了整层页面。
                             *
                             * 所以再复查一次：仍然没锁着，才当它是正常退场。
                             */
                            handler.postDelayed(() -> {
                                refreshKeyguardLocked();
                                if (!keyguardLocked) {
                                    /*
                                     * 先写原因再退场：describeHideReason 只能给出
                                     * "不在锁屏上"，看不出是**设备根本没锁屏**
                                     * 还是"读到个假信号" —— 而这两种用户要做的
                                     * 事情完全不同（前者无解，后者该换复查时机）。
                                     */
                                    lockScreenLastExit =
                                            "亮屏后系统报告已解锁（设备可能没有锁屏密码，"
                                                    + "或人脸/指纹已自动解锁）";
                                    finishLockScreen(false);
                                }
                            }, 900L);
                        }
                        scheduleWatch();
                    }, 500L);
                    scheduleWatch();
                } else if (Intent.ACTION_USER_PRESENT.equals(action)) {
                    keyguardLocked = false;
                    screenOn = true;
                    // 解锁了：下次锁屏是全新的一轮，"用户关过"不再算数。
                    lockScreenDismissed = false;
                    // 解锁了：锁屏页该退场（它的 onDestroy 会把叠层摘下来，
                    // 之后按桌面/所有应用的条件重新挂）。
                    // 这是正常退场 —— 不是"没内容可显示"，下次锁屏照常再来。
                    //
                    // 走 Now 版本绕开最短可见时长：用户已经解锁进桌面了，
                    // 这一层再赖一秒就是挡操作（它吃触摸），不是"防闪"。
                    finishLockScreenNow(false);
                    scheduleWatch();
                }
            }
        };
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                context.registerReceiver(receiver, filter);
            }
        } catch (Throwable error) {
            Log.w(TAG, "Screen state receiver unavailable", error);
        }
    }

    /** 读一次锁屏状态。拿不到（没有 Keyguard 服务）就当没锁 —— 宁可不显示也别乱盖。 */
    private void refreshKeyguardLocked() {
        try {
            android.app.KeyguardManager manager =
                    (android.app.KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
            keyguardLocked = manager != null && manager.isKeyguardLocked();
        } catch (Throwable error) {
            keyguardLocked = false;
        }
    }

    /**
     * 把一段涉及 View / WindowManager 的动作挪到主线程。
     *
     * Capacitor 的插件方法是跑在 Bridge 自己的后台线程上的（`FoliaWallpaperPlugin.setAppearance`
     * 就是从那里进来的），而叠层要 `new WebView`、要 addView —— 在非 UI 线程上碰 View
     * 会直接抛 `IllegalStateException: Calling View methods on another thread than the UI thread`。
     * 更要命的是那一抛发生在 `setAppDriven` 中间：后面的 `scheduleWatch()` 就再也不会执行，
     * 巡检从此停摆，用户看到的就是"开关点了没反应、而且再也起不来"。
     */
    private void runOnUi(Runnable action) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            action.run();
            return;
        }
        handler.post(action);
    }

    /**
     * 应用侧托管开关。叠层总开关打开就由应用进程直接挂着 ——
     * 这样即使系统壁纸根本不是我们（甚至没设动态壁纸），也能看到叠层。
     */
    public void setAppDriven(boolean enabled) {
        runOnUi(() -> applyAppDriven(enabled));
    }

    private void applyAppDriven(boolean enabled) {
        if (appDriven == enabled) {
            return;
        }
        appDriven = enabled;
        if (!enabled) {
            // 关开关是用户动作：稳定结论立刻归 false（否则它要等迟滞才翻，
            // 期间巡检认为"还该显示"，刚收下又被唤醒），然后同样走渐隐。
            // 巡检循环保持常驻（requestHide 里会续上），
            // 否则关了开关就再也没人盯着它该不该重新挂上。
            settleHidden();
            requestHide();
            return;
        }
        // 用户刚拨的开关，不是抖动：直接对齐稳定结论，别让它再等一秒迟滞。
        alignWantShowNow();
        ensureShown();
        scheduleWatch();
    }

    private final Runnable pushTask = new Runnable() {
        @Override
        public void run() {
            pushScheduled = false;
            lastPushAtMs = SystemClock.elapsedRealtime();
            try {
            // 壁纸样式切到「精简」之后，叠层要收掉 —— 精简要的就是安静的原生画面，
            // 再叠一层可视化就违背这个模式的初衷了。
            // 用 shouldHideNow() 而不是 shouldShow()：抖一下就销毁重建一次页面，
            // 正是用户报的「突然消失然后出现」（见 HIDE_DEBOUNCE_MS）。
            if (shouldHideNow()) {
                requestHide();
                return;
            }
            syncScreenSize();
            reloadOnTuningChange();
            syncWindowFlags();
            applyOpacity();
            pushState();
            // 页面没确认收到就一直补推（见 ensureDelivered）。
            ensureDelivered();
            // 两道自愈：页面彻底没起来就重载一份；页面手里的歌不对就补推一次。
            recoverStalledPage();
            verifyPageContent();
            } catch (Throwable error) {
                // 巡检循环必须活着：这里任何一处抛异常，下面那句 schedulePush 就不会执行，
                // 于是整个巡检从此停摆 —— 什么都不再推送、转屏也不再响应，
                // 只有「暂停（收起）→ 播放（重新挂载一份新页面）」能把整套东西救回来。
                // 用户报的「有概率不工作、转屏也没用」正是这条链断掉的形状。
                Log.w(TAG, "Overlay push tick failed", error);
            }
            if (added) {
                schedulePush();
            }
            // 互相续命：巡检还活着就把另一条循环也兜上，见 watchdog's 说明。
            if (added && !watchScheduled) {
                scheduleWatch();
            }
        }
    };

    /** 上一次 pushTask 真的跑过的墙钟。watchTask 靠它判断巡检有没有停摆。 */
    private long lastPushAtMs = 0L;

    /** 光靠 pushTask 不够：它只在叠层挂着时跑。收掉之后得有人盯着模式什么时候切回来。 */
    private final Runnable watchTask = new Runnable() {
        @Override
        public void run() {
            watchScheduled = false;
            /*
             * 「音乐锁屏」开着时周期性复核一次锁屏状态。
             *
             * 广播是最主要的来源，但它有两个漏洞：亮屏那一刻 Keyguard 未必已经挂上
             * （只靠那一次查询会漏），以及任何一个广播丢了就会一直卡在错误的状态上。
             * 每秒问一次的代价可以忽略，换来的是不用赌时序。
             */
            if (lockScreenWanted() && overlayMasterEnabled()) {
                long elapsed = SystemClock.elapsedRealtime();
                if (elapsed - keyguardCheckedAtMs >= 1000L) {
                    keyguardCheckedAtMs = elapsed;
                    refreshKeyguardLocked();
                }
                /*
                 * 换歌检测：歌名一变，上一首"唱完了"这件事就不作数了，
                 * 锁屏页可以再来一次（否则播完一首之后，整晚都别想再看到它）。
                 */
                String title = WallpaperLyricsState.get().title;
                if (title != null && !title.equals(lastSongTitle)) {
                    lastSongTitle = title;
                    lockScreenContentDone = false;
                }
                // 锁屏页还没起来就再试着起一次：息屏那一刻可能还没开始播放，
                // 也可能那一次恰好被系统的后台启动限制挡掉了 —— 之后没有别的事件会补。
                if (keyguardLocked) {
                    ensureLockScreenAttempt();
                }
            }
            // 「在所有应用上叠加」打开后，即使回到桌面之外也要继续挂着，
            // 所以这里不能只用「壁纸可见」作为前提。
            /*
             * 「该不该显示」每轮只在这里问一次，下面所有分支共用这一个结论。
             *
             * 以前这里直接问 shouldShow()，收起就是它一句话拍板的。而 shouldShow()
             * 里面任何一项抖一下都会给出 false：切歌那一瞬播放状态常经过一次非 PLAYING、
             * 换行校正时位置会短暂越界、壁纸可见性在切应用时来回翻。这些抖动往往只
             * 持续几百毫秒 —— 淡出刚起步，下一轮 shouldShow() 已经变回 true，于是
             * 「正在淡出」那一支就地反向淡入。用户报的「暂停有概率淡出后马上淡入，
             * 而且之后不消失」正是这个形状：淡出不是因为真的暂停，而是抖了一下；
             * 反完之后信号本来就一直是 true，它就理所当然地一直留着。
             *
             * 迟滞（HIDE_DEBOUNCE_MS / SHOW_DEBOUNCE_MS）本来就是为这种抖动准备的，
             * 但它只挂在 pushTask 那条路上（shouldHideNow），而真正拍板收起的是这里的
             * watchTask —— 于是迟滞形同虚设。现在两条路共用同一个迟滞后的结论。
             */
            final boolean want = wantShowStable();
            if (dormantSinceMs > 0L) {
                // 休眠中（窗口还挂着，只是透明）：又能显示了就在**原页面**上淡回来，
                // 不再走「销毁 → 重建 → 等首帧」那一整套。
                if (want) {
                    wakeFromDormant();
                } else if (SystemClock.elapsedRealtime() - dormantSinceMs >= DORMANT_MAX_MS) {
                    detach();
                }
            } else if (want) {
                // 又要显示了：如果正在淡出，立刻改往回收（从当前的不透明度接上，不闪）。
                if (fadingOut) {
                    startFadeIn();
                }
                if (!added) {
                    attach();
                }
                // 「等首帧」的兜底：到点还没收到信号也要把窗口显示出来。
                // 只在"该显示"这一支里做 —— 不该显示的时候强行淡入，
                // 下一轮又要淡出，白晃一下。
                enforceFadeInDeadline();
            } else if (added && !fadingOut) {
                // 该收了：先渐隐，隐完 stepFade 里进入休眠。
                startFadeOut();
            }
            // 息屏这一路不走淡出：屏幕本来就是黑的，动画没人看得见，直接摘掉省电。
            if (added && !screenOn) {
                detach();
            }
            /*
             * 锁屏页还挂着、但现在已经不该显示了（暂停了 / 歌词唱完了 / 开关关了）：
             * 让它退场，别在锁屏上留一层空的可视化。
             */
            /*
             * 没内容可显示（歌词唱完 / 是纯音乐 / 暂停了）而退场：
             * 标记一下，本次锁屏周期内不再把它起回来（见 lockScreenContentDone）。
             */
            /*
             * 总开关关掉是**立刻**生效的，不等迟滞：迟滞是给信号抖动准备的，
             * 用户亲手拨的开关不是抖动，多留 1.2 秒就是多闪一下。
             */
            if (lockScreenHost != null && !overlayMasterEnabled()) {
                finishLockScreen(false);
            } else if (lockScreenHost != null && !want) {
                /*
                 * 只有**真的没内容**才钉住「本次锁屏周期内别再起来」（见 isContentExhausted）。
                 * 一律钉死的话，总开关拨回来 / 样式切回跟随后，锁屏页却再也不出现了。
                 */
                finishLockScreen(isContentExhausted());
            }
            /*
             * 窗口被系统悄悄摘掉了：连续两次都发现它不在，才认定。
             *
             * 一次就 detach 的代价太大 —— 转屏 / 多任务切换的瞬间 isAttachedToWindow
             * 在部分 ROM 上会短暂为 false，误判一次就是一次完整的
             * 销毁 → 重建 → 等首帧 → 淡入，正是"突然消失又淡入出现"的形状。
             */
            if (added && webView != null
                    && SystemClock.elapsedRealtime() - attachAtMs > 5000L
                    && !webView.isAttachedToWindow()) {
                detachedStreak += 1;
                if (detachedStreak >= 2) {
                    detachedStreak = 0;
                    detach();
                }
            } else {
                detachedStreak = 0;
            }
            /*
             * 看门狗：巡检停摆的话，把它重新拧上。
             *
             * 巡检是这个叠层唯一的心脏 —— 推送、转屏重排、两道自愈全在它里面跑。
             * 它一旦因为任何原因（抛异常、消息丢失、被系统推迟）不再往下走，
             * 页面就停在最后一份数据上：歌词不更新、转屏也没反应，看上去就是
             * 「有概率不工作」。而暂停会收起整层、播放时重新挂载一份全新页面，
             * 于是「只有暂停再播放才能救回来」—— 症状完全对得上。
             *
             * 与其去猜它会断在哪一行，不如让两条循环互相盯着：这条循环活着就一定
             * 能发现另一条停了，反之亦然。两边同时停摆的概率基本为零。
             */
            if (added && webView != null && pageReady && lastPushAtMs > 0L
                    && SystemClock.elapsedRealtime() - lastPushAtMs > 2000L
                    && !pushScheduled) {
                schedulePush();
            }
            // 每轮都推进一步过渡（淡入或淡出）。
            stepFade();
            // 这个循环常驻（每次只是读一下静态状态，开销可以忽略）：
            // 用户可能在任意时刻改设置（打开全应用叠加、切到跟随模式），
            // 那时壁纸往往正不可见，没有循环盯着就永远不会重新挂上。
            scheduleWatch();
        }
    };

    private boolean watchScheduled = false;

    /*
     * 淡出。
     *
     * 收起叠层时直接 detach() 是一下子消失，观感很硬 —— 尤其是"歌词唱完了"
     * 这种用户盯着看的时候。这里改成先把窗口不透明度线性降到 0，降完再移除。
     * 淡出期间巡检间隔缩短，帧数够才看得出是"渐变"而不是"跳两下"。
     */
    private static final long FADE_OUT_MS = 700L;
    /** 淡入时长。和淡出对称：出现和消失的节奏一致，观感才像同一次过渡。 */
    private static final long FADE_IN_MS = 900L;
    /** 过渡期间的巡检间隔（平时 PUSH_INTERVAL_MS）。 */
    private static final long FADE_TICK_MS = 60L;

    /**
     * 屏幕是否处于"用户看得见"的状态。
     *
     * 锁屏 / 息屏时收起叠层，解锁时再淡入回来 —— 否则叠层会盖在锁屏之上。
     * 这两个动作只有系统广播会告诉我们，壁纸的可见性在锁屏时不一定翻转。
     */
    private boolean fadingOut = false;
    private boolean fadingIn = false;
    /** 已经挂上窗口、但还没开始淡入（等第一份数据**真的送进页面**）。 */
    private boolean fadeInPending = false;
    /**
     * 「等首帧」的兜底截止时间。
     *
     * 淡入的触发依赖两个信号（页面 onPageFinished + 页面自己回报 __foliaWallpaperPainted），
     * 任何一个丢失（页面加载失败、懒加载 chunk 卡住、切歌时标题还没到）都会让窗口
     * 永远停在 alpha=0 —— 窗口是挂着的，但什么都看不见，而且因为 added 一直是 true
     * 也不会重新挂载，表现就是「下一首再也不出来了」。
     * 到点无条件开始淡入：宁可早一点淡入到空页面，也不能为了一个信号把歌词永远藏着。
     */
    private long fadeInDeadlineMs = 0L;
    /**
     * 「播放位置越过最后一句结束时间」的首次墙钟（0 = 还没越过）。
     *
     * 用锁存而不是每次现算：应用会不定期把锚点推过来（换行校正 / 拖动判定），
     * 而锚点带的是**应用的**位置、和这边的墙钟外推值并不同步。边界上被拉回去一次，
     * 收起流程就整个撤销，于是「唱完了但就是不消失」是概率性的 —— 正好对得上用户报的现象。
     * 锁存之后只有位置真的退回最后一句之内才清零。
     */
    private long lyricsEndSinceMs = 0L;
    /** 当前这份页面是否已就绪（onPageFinished 之后为 true，重新加载前置回 false）。 */
    private boolean pageReady = false;
    /**
     * 这一份页面有没有**确认收到过**至少一次数据。
     *
     * 只靠「我调用过 evaluateJavascript」不算送达：页面还在导航 / JS 上下文刚重建时，
     * 那次调用会被静默丢掉，而调用方看起来是成功的。偏偏签名是在调用前就记下的，
     * 于是之后每一轮都被「状态没变」挡掉 —— 页面永远停在空状态，
     * 用户看到的就是「切到下一首再也不出来了」，而且是概率性的（取决于时序）。
     *
     * 所以让页面回报一个递增计数，收到非空计数才算真的送达；没送达就一直重推。
     */
    private boolean pushConfirmed = false;
    /** 这一份页面就绪的墙钟。补推只在这之后的 10 秒内进行，免得页面坏了还一直空转。 */
    private long pageReadyAtMs = 0L;
    /** 最近一次 loadUrl / reload 的墙钟。拿来卡"重载自救"的节奏，避免每轮都重载。 */
    private long lastLoadAtMs = 0L;
    /** 上次跟页面核对过歌名的墙钟。 */
    private long lastVerifyAtMs = 0L;
    /** 连续几次核对都对不上的计数。到上限就换一份新页面，见 verifyPageContent。 */
    private int contentMismatchStreak = 0;
    /** 页面一直没确认收到数据时，隔这么久重载一份新页面重试。 */
    private static final long PAGE_STALL_RECOVER_MS = 8000L;
    /** 隔多久跟页面核对一次"你手里现在是哪首歌"。 */
    private static final long VERIFY_INTERVAL_MS = 3000L;
    /**
     * 最近一次挂载的墙钟。
     *
     * 用来判断"窗口是不是被系统悄悄摘掉了"：叠层窗口在少数 ROM 上会被系统回收
     * （权限变更、多任务清理），那时 added 还是 true，于是既不会再挂载、
     * 也不会有任何人发现它已经没了 —— 表现同样是"切到下一首再也不出来"。
     * 刚挂载的头两秒不查：addView 返回后窗口真正贴上去还有一点点延迟。
     */
    private long attachAtMs = 0L;
    /** 连续发现"窗口不在窗口树上"的次数。见 watchTask 里那段。 */
    private int detachedStreak = 0;
    private long fadeStartMs = 0L;
    private float fadeFromAlpha = 1f;
    private float fadeToAlpha = 1f;

    /** 缓入缓出：线性淡入淡出会显得两头发死，用 smoothstep 更像"呼吸"。 */
    private static float ease(float t) {
        float clamped = t < 0f ? 0f : t > 1f ? 1f : t;
        return clamped * clamped * (3f - 2f * clamped);
    }

    private void startFadeIn() {
        // 已经有淡入在跑就什么都别做：再进来一次只会把节奏重置一遍
        // （起点有连续性保证，不会跳变，但爬升时长被凭空拉长）。
        // 触发方有三个且互不知情，这条守卫是它们之间的互斥锁。
        if (fadingIn) {
            return;
        }
        /*
         * 连续性是这里的铁律：淡入必须从窗口**当前真实的不透明度**起步。
         *
         * 之前起点取调用方传的 fromAlpha，而淡入有三个互不知情的触发方
         * （等首帧的轮询链、5 秒兜底、淡出中途的反转），它们各自以为的"当前值"
         * 并不一定等于窗口此刻的 alpha —— 一旦某个触发方拿着过期的高值进来，
         * 第一步就把窗口顶到满不透明（用户看到"突然显示已经最大透明度"）；
         * 紧接着另一个触发方又带着 0 进来，起点被重置回 0（"突然降到最小"），
         * 然后才慢慢爬回去。三次跳变全是同一条缝隙漏出来的。
         * currentAlphaOrDefault() 读的是 appliedOpacity —— 每一次写 params.alpha
         * 的地方都同步维护它，所以它就是权威的"现在窗口是多少"。
         */
        cancelPaintPoll();
        fadeInPending = false;
        fadeInDeadlineMs = 0L;
        fadingIn = true;
        fadingOut = false;
        fadeFromAlpha = currentAlphaOrDefault();
        fadeToAlpha = overlayOpacity();
        fadeStartMs = SystemClock.elapsedRealtime();
        // 立刻推一帧（progress=0 时 alpha = fadeFromAlpha，等于当前值，视觉上零跳变），
        // 并把巡检切到过渡节奏 —— 否则下一次 stepFade 最远要等 250ms，
        // 第一步就能凭空跳掉 30% 的不透明度。
        stepFade();
        handler.removeCallbacks(watchTask);
        watchScheduled = false;
        scheduleWatch();
    }

    /**
     * 开始一次淡出。与 startFadeIn 对称：从当前真实 alpha 起步、取消在途的
     * 等首帧轮询（它唯一的职责就是把窗口带进淡入，淡出已经接管就不要再掺和）、
     * 立刻推帧并切到过渡节奏。requestHide 和 watchTask 的收起分支共用，
     * 两处行为必须一致。
     */
    private void startFadeOut() {
        cancelPaintPoll();
        fadingIn = false;
        fadeInPending = false;
        fadeInDeadlineMs = 0L;
        fadingOut = true;
        fadeStartMs = SystemClock.elapsedRealtime();
        fadeFromAlpha = currentAlphaOrDefault();
        stepFade();
        handler.removeCallbacks(watchTask);
        watchScheduled = false;
        scheduleWatch();
    }

    /**
     * 淡出的起点必须取**当前真实的不透明度**。
     *
     * 之前这里写的是 `appliedOpacity > 0f ? appliedOpacity : overlayOpacity()`，
     * 于是「还没淡入（alpha=0 在等首帧）时就收到收起请求」会拿设定值当起点：
     * 窗口会先被拉到满不透明、再淡下去 —— 用户看到的就是凭空闪一下。
     * appliedOpacity 为 0 是合法状态（挂上去就是透明的），只有 -1（还没落过值）
     * 才需要回落到设定值。
     */
    private float currentAlphaOrDefault() {
        return appliedOpacity >= 0f ? Math.max(0f, appliedOpacity) : overlayOpacity();
    }

    /**
     * 请求收起叠层：先渐隐，隐完再移除（唯一的收起入口，两处调用行为必须一致）。
     * 已经不在挂载状态时就直接把巡检续上，等条件再满足时重新挂。
     */
    private void requestHide() {
        // 已经在休眠就别再起一次淡出：窗口此刻就是 alpha=0，再淡一次只是空转，
        // 而 startFadeOut 会把 fadingOut 置回 true、干扰 watchTask 对休眠的判断。
        if (added && !fadingOut && dormantSinceMs == 0L) {
            // 正在淡入的话直接就地反向：从**当前**不透明度往回收。
            // 等淡入走完再回头的话，中间会先亮到满值再暗下去 —— 那一下就是"闪"。
            // 起点取实时值，接得上，看起来只是"出来一半又回去了"。
            startFadeOut();
        } else if (dormantSinceMs > 0L) {
            // 已经在休眠：收起的意图必须落到稳定结论上。否则下一轮巡检会拿着
            // 还没翻过去的 wantShow 认为"又该显示了"，刚收下就把它唤醒。
            settleHidden();
        }
        stepFade();
        scheduleWatch();
    }

    /**
     * 「等首帧」的兜底：到点还没等到信号，也照样开始淡入。
     *
     * 没有这一层，信号链上任意一环掉了（页面没回调 onPageFinished、首帧标志没置位、
     * 切歌那一刻标题还是空）窗口就会永远透明 —— 而且因为 added 一直是 true，
     * 巡检也不会重新挂载它，看上去就是"切下一首再也不出来了"。
     */
    private void enforceFadeInDeadline() {
        if (!fadeInPending || !added || webView == null) {
            return;
        }
        long now = SystemClock.elapsedRealtime();
        if (fadeInDeadlineMs <= 0L) {
            // 兜底计时器没设上（理论上只有历史路径会走到）：现补一个。
            fadeInDeadlineMs = now + FADE_IN_TIMEOUT_MS;
            return;
        }
        if (now < fadeInDeadlineMs) {
            return;
        }
        startFadeIn();
    }

    /**
     * 反复问页面"画出来了吗"，好了就开始淡入；到 deadline 还没好也照样开始（兜底）。
     *
     * 用轮询而不是让页面回调：页面那边没有到原生的通道（不走 bridge），
     * 而我们本来就有个巡检在跑，顺手问一句的代价可以忽略。
     *
     * 任何时刻只允许存在**一条**轮询链：loadPage（转屏 / 自救重载 / 改设置）之后
     * 会带着新的 fadeInPending 再起一条，旧的那条若不取消，两条链各自触发一次
     * startFadeIn —— 第二次会把正在爬升的 alpha 拉回起点重爬，正是
     * 「先掉到最低、再慢慢拉大」的形状。链本身也带守卫：发现已有过渡在跑
     * （淡入或淡出都算）就直接退场，alpha 的所有权已经不归它了。
     */
    private Runnable activePaintPoll = null;

    private void cancelPaintPoll() {
        if (activePaintPoll != null) {
            handler.removeCallbacks(activePaintPoll);
            activePaintPoll = null;
        }
    }

    private void awaitPaintedThenFade(long deadline) {
        cancelPaintPoll();
        final Runnable check = new Runnable() {
            @Override
            public void run() {
                if (activePaintPoll == this) {
                    activePaintPoll = null;
                }
                if (!added || webView == null || fadingIn || fadingOut) {
                    return;
                }
                if (SystemClock.elapsedRealtime() >= deadline) {
                    startFadeIn();
                    return;
                }
                try {
                    webView.evaluateJavascript(
                            "(window.__foliaWallpaperPainted===true)?'y':'n'",
                            value -> {
                                if (value != null && value.contains("y")) {
                                    startFadeIn();
                                } else {
                                    if (activePaintPoll == null) {
                                        activePaintPoll = this;
                                        handler.postDelayed(this, PAINT_POLL_INTERVAL_MS);
                                    }
                                }
                            });
                } catch (Throwable ignored) {
                    if (activePaintPoll == null) {
                        activePaintPoll = this;
                        handler.postDelayed(this, PAINT_POLL_INTERVAL_MS);
                    }
                }
            }
        };
        activePaintPoll = check;
        handler.postDelayed(check, PAINT_POLL_INTERVAL_MS);
    }

    /** 推进一步当前正在进行的过渡（淡入或淡出）。每轮巡检都会调用一次。 */
    private void stepFade() {
        if (!added || params == null || webView == null) {
            return;
        }
        if (fadingIn) {
            float progress = (float) (SystemClock.elapsedRealtime() - fadeStartMs) / FADE_IN_MS;
            if (progress >= 1f) {
                fadingIn = false;
                params.alpha = fadeToAlpha;
                appliedOpacity = fadeToAlpha;
                relayout();
                return;
            }
            params.alpha = fadeFromAlpha + (fadeToAlpha - fadeFromAlpha) * ease(progress);
            appliedOpacity = params.alpha;
            relayout();
            return;
        }
        if (!fadingOut) {
            return;
        }
        float progress = (float) (SystemClock.elapsedRealtime() - fadeStartMs) / FADE_OUT_MS;
        if (progress >= 1f) {
            fadingOut = false;
            params.alpha = 0f;
            appliedOpacity = 0f;
            relayout();
            // 淡到底先休眠，不立刻销毁（见 DORMANT_MAX_MS）。
            dormantSinceMs = SystemClock.elapsedRealtime();
            // 已经收起来了：稳定结论跟着归 false，回来要重新挣（见 settleHidden）。
            settleHidden();
            return;
        }
        params.alpha = Math.max(0f, fadeFromAlpha * (1f - ease(progress)));
        appliedOpacity = params.alpha;
        relayout();
    }

    private void relayout() {
        if (params == null || webView == null) {
            return;
        }
        WindowManager windowManager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        try {
            windowManager.updateViewLayout(webView, params);
        } catch (Throwable ignored) {
            // 窗口已经没了：下一轮会走 detach。
        }
    }

    WallpaperOverlay(Context context) {
        this.context = context;
        installScreenStateReceiver();
    }

    /** 有没有叠加窗口的权限。没有就别折腾了 —— 加了也只会抛异常。 */
    public static boolean canOverlay(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return Settings.canDrawOverlays(context);
        }
        return true;
    }

    @SuppressLint("SetJavaScriptEnabled")
    void attach() {
        if (added) return;
        // 挂在锁屏页面上时不需要 SYSTEM_ALERT_WINDOW：那是子窗口，权限跟着宿主 Activity 走。
        if (lockScreenHost == null && !canOverlay(context)) return;
        webView = new WebView(context);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        // 视口按设备宽度排版，并且禁止缩放 / 概览模式：
        // 这几个开关任意一个被打开，WebView 都可能按一个比屏幕小的布局视口排版，
        // 表现出来就是「内容只占了屏幕一部分」。
        settings.setUseWideViewPort(false);
        settings.setLoadWithOverviewMode(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        // 页面背景必须透明，否则会把壁纸整个盖住。
        webView.setBackgroundColor(0x00000000);
        // 光在窗口参数上标 NOT_TOUCHABLE 还不够稳：WebView 默认是可聚焦、可点击的控件，
        // 部分 ROM 会给它单开输入通道，结果叠层下面的桌面/应用点不动。
        // 叠层是纯展示的，视图这一层也一并关掉。
        webView.setFocusable(false);
        webView.setFocusableInTouchMode(false);
        webView.setClickable(false);
        webView.setLongClickable(false);
        webView.setEnabled(false);
        webView.setHapticFeedbackEnabled(false);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setWebViewClient(new AssetClient());

        // 尺寸必须按**真实屏幕分辨率**给，不能用 MATCH_PARENT：
        // 只给 MATCH_PARENT 时窗口会被系统栏（状态栏 / 手势条 / 刘海）内缩，
        // FLAG_LAYOUT_IN_SCREEN 只是让它"画到状态栏下面"，并不消除内缩，
        // 结果就是叠层连安全区外都铺不到。
        //
        // 这里取的是 display 的真实尺寸（含系统栏），配合 FLAG_LAYOUT_NO_LIMITS
        // 就能真正铺满整块屏幕，而不是"可用区域"。
        WindowManager windowManager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        int[] screen = screenSize();
        int screenWidth = screen[0];
        int screenHeight = screen[1];
        // 记下来，之后靠它判断有没有转屏。
        lastScreenWidth = screenWidth;
        lastScreenHeight = screenHeight;

        /*
         * 窗口类型：没有宿主时是系统悬浮窗（TYPE_APPLICATION_OVERLAY，需要悬浮窗权限）；
         * 有锁屏页时是 TYPE_APPLICATION_PANEL —— 挂在那个 Activity 的窗口之上。
         *
         * PANEL 这条路是「把同一层 WebView 画到锁屏上」的关键：它不需要悬浮窗权限，
         * 而且会继承宿主的 showWhenLocked，于是锁屏上看到的就是桌面叠层那一层本身，
         * 而不是另起一份浏览器（另起一份意味着两套状态、两份 rAF 开销，还必然对不上）。
         */
        final boolean hosted = lockScreenHost != null;
        params = new WindowManager.LayoutParams(
                screenWidth,
                screenHeight,
                hosted
                        ? WindowManager.LayoutParams.TYPE_APPLICATION_PANEL
                        : WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                // 不吃触摸（桌面照常点）、不抢焦点（不影响输入法/按键）、不受系统栏限制铺满全屏。
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        // NOT_TOUCHABLE 已经让事件穿到下层了，NOT_TOUCH_MODAL 是再兜一层：
                        // 窗口外的事件一律交给后面的窗口，不参与"是否模态"的判定。
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        if (hosted) {
            params.token = lockScreenHost.getWindow().getDecorView().getWindowToken();
        }
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = 0;
        params.y = 0;
        // 「音乐锁屏」这一位必须在 addView 之前就带上：窗口挂上去的那一刻若不带它，
        // 锁屏上就看不见，而后面再补要等下一次巡检。
        appliedShowWhenLocked = false;
        syncWindowFlags();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            params.setFitInsetsTypes(0);
        }
        // 不透明度必须在这一刻就落上：窗口参数是新建的，alpha 默认 1，
        // 等到第一次推送才 applyOpacity 的话，中间那段就是满不透明的闪一下 ——
        // 而且每次重新挂载（切走再切回桌面）都会重来一遍。
        /*
         * 先以全透明加进窗口，等**页面真的拿到数据**之后再开始淡入。
         *
         * 不能一挂上就淡入：那时候页面还是空的（可视化的默认画面 / 一层底色），
         * 用户看到的就是"先闪一下灰罩，然后才出现歌词"。等第一份带歌名的数据推过去、
         * 再留一帧给它画，淡入的就是真正的内容。
         */
        params.alpha = 0f;
        appliedOpacity = 0f;
        fadingIn = false;
        fadingOut = false;
        fadeInPending = true;
        // 兜底计时器必须在这里就上弦：淡入的触发依赖页面回信号，
        // 信号链断掉时只有它能把窗口从"永远透明"里救出来。
        fadeInDeadlineMs = SystemClock.elapsedRealtime() + FADE_IN_TIMEOUT_MS;
        fadeFromAlpha = 0f;
        fadeToAlpha = overlayOpacity();

        loadPage(screenWidth, screenHeight);
        try {
            windowManager.addView(webView, params);
            added = true;
            attachAtMs = SystemClock.elapsedRealtime();
            // 见 windowAttachedListener：让锁屏面板有机会重新排到这一层之上。
            Runnable listener = windowAttachedListener;
            if (listener != null) {
                try {
                    listener.run();
                } catch (Throwable error) {
                    Log.w(TAG, "Window attached listener failed", error);
                }
            }
            schedulePush();
        } catch (Throwable error) {
            // 部分 ROM 即使给了权限也会拒绝 TYPE_APPLICATION_OVERLAY，静默退回原生渲染。
            webView = null;
        }
    }

    /** 桌面切走/息屏时整层摘掉：留着的话 WebView 还在后台跑 rAF，很费电。 */
    void detach() {
        handler.removeCallbacks(pushTask);
        cancelPaintPoll();
        pushScheduled = false;
        // 页面都没了，稳定结论当然是「不显示」（见 settleHidden）。
        settleHidden();
        // 页面会被销毁，重新 attach 时是全新的一份 —— 推送签名必须一起清掉，
        // 否则「状态没变」会被判成不用推，页面就永远等不到第一份数据。
        lastSignature = null;
        // 新页面本来就是在"当前设置"下加载的（它自己读存储），没有欠账要补：
        // 签名清掉，下一份页面挂载后第一次巡检只记录、不多重载一次。
        lastTuningHash = null;
        appliedOpacity = -1f;
        // 渐变状态跟着窗口一起清掉：下一次 attach 会重新开始淡入。
        fadingOut = false;
        fadingIn = false;
        fadeInPending = false;
        fadeInDeadlineMs = 0L;
        dormantSinceMs = 0L;
        detachedStreak = 0;
        pageReady = false;
        pushConfirmed = false;
        /*
         * 注意：这里**不能**清 lyricsEndSinceMs。
         *
         * 收起如果是「歌词唱完了」触发的，此刻播放位置仍然在最后一句之外；
         * 锁存一清，下一轮巡检就重新开始计 5 秒宽限 —— 宽限期内 lyricsFinished()
         * 返回 false，shouldShow() 变回 true，于是重新挂载淡入，5 秒后再次收起……
         * 用户看到的就是永远循环的淡入淡出。锁存自带清零条件：位置真的退回
         * 最后一句之内（拖回去 / 重播），或者换歌（新时间轴 + 位置归零）。
         */
        if (!added || webView == null) {
            return;
        }
        WindowManager manager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        try {
            manager.removeView(webView);
        } catch (Throwable ignored) {
            // 已经被系统摘掉了。
        }
        webView.destroy();
        webView = null;
        added = false;
    }

    /**
     * 壁纸样式 = 跟随（非精简）时才挂叠层。
     *
     * Web 侧在「精简」模式下直接把 visualizer 发成 `minimal` 字面量，
     * 所以这里按模式名判定即可，不需要再多一个字段。
     */
    private boolean shouldShow() {
        // 叠层总开关：关掉就一层都不挂（锁屏页也算，见 overlayMasterEnabled）。
        if (!overlayMasterEnabled()) {
            return false;
        }
        // 息屏：这时候挂着纯属白耗电（页面还在跑 rAF），而且屏幕本来就看不见。
        if (!screenOn) {
            return false;
        }
        WallpaperLyricsState.Snapshot snapshot = WallpaperLyricsState.get();
        // 精简模式不挂叠层。
        if ("minimal".equals(snapshot.visualizerMode)) {
            return false;
        }
        /*
         * 纯音乐（没有歌词）：可视化画不出歌词，只剩余背景动效。
         * 有人要的就是这时候干净点，做成开关（默认开）。
         * 判定用 placeholderOnly 而不是行数 —— 纯音乐时原生会补一行占位文案，
         * 按行数判会被那行占位骗过去，开关就失效了。
         *
         * 位置必须已经走出开头才算数：换歌是两步走（先推新歌名，歌词解析完再推一次），
         * 中间那一两秒 snapshot 同样是 placeholderOnly。不卡这一道的话，每换一首歌
         * 叠层都要收起再重建一次 —— 用户报的「叠层突然消失，然后又淡入出现」
         * 大半就是这么来的。真纯音乐的话，走到 4 秒仍没有歌词，判它是纯音乐。
         */
        if (snapshot.placeholderOnly && tuningFlag("wp.skipInstrumental", true)
                && snapshot.positionMs() > INSTRUMENTAL_CONFIRM_MS) {
            return false;
        }
        // 暂停时收起：静止画面没必要挂着一层窗口（还在持续跑 rAF）。
        // 恢复播放时下一轮巡检就会重新挂上，歌词也在那一下补推。
        if (!snapshot.playing && tuningFlag("wp.hideWhenPaused", true)) {
            return false;
        }
        // 歌词唱完了、后面还有很长的尾奏（有些曲子后半段就是纯音乐）：
        // 最后一句结束几秒后收起，别让叠层挂着一片空白。
        // 拖回去或重播到有歌词的位置，下一轮巡检就自动回来了。
        if (lyricsFinished(snapshot)) {
            return false;
        }
        // 音乐锁屏：已经挂在锁屏页面上了就照常画（那层窗口本来就在 keyguard 之上）。
        if (lockScreenHost != null) {
            return true;
        }
        // 锁屏页还没起来 / 起不来时，退回到悬浮窗那条路（带 FLAG_SHOW_WHEN_LOCKED）：
        // 部分 ROM 允许悬浮窗画在锁屏上，那就不用 Activity 也能看到。
        // 用户主动关掉过的话这条就不走了 —— 见 lockScreenDismissed。
        if (lockScreenWanted() && keyguardLocked
                && !lockScreenDismissed && !lockScreenContentDone) {
            return true;
        }
        /*
         * 锁屏页还挂着（keyguard 还在），而用户刚刚亲手把它关掉了 —— **任何**形式都不许
         * 再回来，包括「在所有应用上叠加」和「壁纸可见」那两条路。
         *
         * 少了这一句，上滑退出的观感就是「抽搐一下又回来了」：
         * Activity finish → 宿主置空 → 锁屏那支被 dismissed 挡住 → 但壁纸此刻仍是可见的
         * （锁屏上壁纸照样在画），于是最后那句 `wallpaperVisible` 给出 true，
         * 叠层立刻以悬浮窗的形式重新挂上淡入 —— 用户刚退掉的又自己出现。
         * 开着「在所有应用上叠加」时更是必然复发（那一支根本不看 keyguard）。
         */
        if (keyguardLocked && lockScreenDismissed) {
            return false;
        }
        /*
         * 「仅在锁屏上显示」：走到这里说明**不是**锁屏场景（桌面 / 所有应用 /
         * App 内），那就一律不挂 —— 这个开关要的就是"只在锁屏出现"。
         */
        if (overlayLockScreenOnly()) {
            return false;
        }
        // 「在所有应用上叠加」：放宽"必须停在桌面"这个前提。
        if (overlayOnAllApps()) {
            return true;
        }
        /*
         * 都不开：就只在"用户看得见桌面"的时候显示。
         *
         * 三种信号按可信度排：
         *  · 我们的界面在前台 —— 这是在**用 App**，不是桌面，收起（除非开了全应用叠加）。
         *  · 系统壁纸是我们 —— 用壁纸服务的可见性回调，它连锁屏/切桌面都判断得准。
         *  · 系统壁纸不是我们 —— 没有可见性信号可用，回到"App 不在前台"就挂上。
         *    这正是「叠层不再要求设为壁纸」的那一半：没有这一支，用户没设我们的壁纸时
         *    开了开关完全没有反应（只有去壁纸选择界面激活一次才生效）。
         */
        if (appForeground) {
            return false;
        }
        return isOurWallpaperSet() ? wallpaperVisible : true;
    }

    /** 见 shouldShow 里「纯音乐」那一条：走到这个位置仍没有歌词，才认它是纯音乐。 */
    private static final long INSTRUMENTAL_CONFIRM_MS = 4000L;

    /**
     * 「不该显示」这个信号要**连续**保持这么久才真的收起。
     *
     * 为什么必须迟滞：收起的代价不是"淡出"，而是 `detach()` 里的 `webView.destroy()`
     * —— 重新显示时是一份**全新页面**（加载 → 等首帧 → 淡入近一秒）。
     * 而 shouldShow() 里任何一项抖一下都会给出 false：
     *   · 切歌那一瞬播放状态常会经过一次非 PLAYING；
     *   · 应用推回来的位置在换行校正时会短暂越界；
     *   · 壁纸可见性回调在切应用时会来回翻。
     * 抖一次就销毁重建一次，用户看到的就是「叠层突然消失，然后又出现」。
     * 这些都是毫秒级的假信号，让它们撑不过这道闸门即可；
     * 真要收起的那几种（暂停、唱完）都是持续状态，多等这点时间看不出来。
     *
     * 注意这道闸门必须挂在**真正拍板收起的那条路**上（以前只挂在 pushTask 上，
     * 而收起是 watchTask 拍板的，于是迟滞等于没写）。见 wantShowStable。
     */
    private static final long HIDE_DEBOUNCE_MS = 1200L;
    /**
     * 「暂停」这一项单独的迟滞（见 hideDebounceMs）。
     *
     * 缓冲、切歌、切音源都会让播放状态短暂经过非 PLAYING，而且常常不止 1.2 秒 ——
     * 按统一迟滞判就会被当成用户按下了暂停，叠层收起、缓冲结束再重建淡入。
     * 暂停是**持续**状态，晚两秒收起没人看得出来；误收一次却是一次完整的消失动画。
     */
    private static final long PAUSE_HIDE_DEBOUNCE_MS = 3500L;

    /**
     * 「该显示了」同样要**连续**保持这么久才真的动作 —— 迟滞是对称的。
     *
     * 只给收起加迟滞是不够的：抖动是双向的，一个只持续几百毫秒的假 true
     * 同样会把正在淡出（或已经休眠）的窗口拉回来淡入，而淡入之后信号恢复成 true
     * 的稳定态，它就再也不收了 —— 表现正是「淡出后马上淡入，而且不消失」。
     */
    private static final long SHOW_DEBOUNCE_MS = 400L;

    /**
     * 已经收起（正在淡出 / 处于休眠）之后要重新显示，要求更久。
     *
     * 比淡出时长（FADE_OUT_MS）更长是故意的：收起这个决定是迟滞之后才做出的，
     * 说明那一刻信号稳定地为 false；刚收下又立刻要回来，多半还是同一个抖动源
     * （切歌那两秒、缓冲、换行越界）。给足一秒，让它自己先稳定下来。
     * 反悔的代价并不大：休眠期窗口还在，淡入走的是原页面，不需要重新加载。
     */
    private static final long RESHOW_DEBOUNCE_MS = 1000L;

    /** 迟滞之后的稳定结论：现在到底该不该显示。 */
    private boolean wantShow = false;
    /** 与稳定结论相反的那个值第一次出现的时刻；0 = 当前没有待定的翻转。 */
    private long flipSinceMs = 0L;
    /** 待定翻转要翻向哪边。 */
    private boolean flipValue = false;

    /** 取这一轮「不该显示」该等多久才真的收起。 */
    private long hideDebounceMs() {
        return WallpaperLyricsState.get().playing ? HIDE_DEBOUNCE_MS : PAUSE_HIDE_DEBOUNCE_MS;
    }

    /** 取这一轮「该显示了」该等多久才真的动作（见 SHOW_DEBOUNCE_MS / RESHOW_DEBOUNCE_MS）。 */
    private long showDebounceMs() {
        return (fadingOut || dormantSinceMs > 0L) ? RESHOW_DEBOUNCE_MS : SHOW_DEBOUNCE_MS;
    }

    /**
     * 唯一的「该不该显示」入口：所有拍板的地方（watchTask 的挂载 / 收起 / 休眠恢复、
     * pushTask 的收起）都必须问它，而不是直接问 shouldShow()。
     *
     * shouldShow() 是**瞬时**读数，这一个才是迟滞后的结论：原始值必须连续保持
     * 足够久才允许翻转。两道闸门各自的意义见 HIDE_DEBOUNCE_MS 与 SHOW_DEBOUNCE_MS。
     */
    private boolean wantShowStable() {
        boolean raw = shouldShow();
        if (raw == wantShow) {
            flipSinceMs = 0L;
            return wantShow;
        }
        long now = SystemClock.elapsedRealtime();
        if (flipSinceMs == 0L || flipValue != raw) {
            // 第一次（或方向变了）：重新开始计，这一轮保持原结论。
            flipSinceMs = now;
            flipValue = raw;
            return wantShow;
        }
        if (now - flipSinceMs >= (raw ? showDebounceMs() : hideDebounceMs())) {
            wantShow = raw;
            flipSinceMs = 0L;
        }
        return wantShow;
    }

    /**
     * 用户显式动作（改总开关、壁纸可见性翻转、锁屏页交接）之后立刻对齐稳定结论，
     * 不等迟滞：这些不是抖动，等上一秒才生效会显得"点了没反应"。
     */
    private void alignWantShowNow() {
        wantShow = shouldShow();
        flipSinceMs = 0L;
    }

    /** 见 wantShowStable。返回 true 才允许走收起流程。 */
    private boolean shouldHideNow() {
        return !wantShowStable();
    }

    /**
     * 淡出走完之后**不立刻销毁**，先休眠这么久。
     *
     * 收起真正的代价是 detach() 里的 webView.destroy() —— 再显示时是一份全新页面
     * （加载 → 等首帧 → 淡入近一秒）。而触发收起的那些信号里有相当一部分是抖动的：
     * 切歌空窗、缓冲、壁纸可见性翻一下。抖一次就重建一次页面，用户看到的就是
     * 「叠层突然消失，然后又淡入出现」；休眠让这些抖动原地折返（窗口还在，内容还在，
     * 只是透明），既不销毁也不重建。
     *
     * 休眠期间 WebView 是活着的（还在跑 rAF），所以不能无限期挂着：
     * 到点仍不该显示（真的暂停了、真的唱完了）就真销毁，回到省电状态。
     */
    private static final long DORMANT_MAX_MS = 12000L;
    /** 进入休眠的墙钟；0 = 不在休眠。见 DORMANT_MAX_MS。 */
    private long dormantSinceMs = 0L;

    private static boolean overlayOnAllApps() {
        return tuningFlag("wp.overlayAllApps", false);
    }

    /** 最后一句唱完后再宽限这么久才收起（长尾奏的曲子不必一直挂着）。 */
    private static final long LYRICS_END_GRACE_MS = 5000L;

    /** 最后一句歌词的结束时间；没有歌词 / 时间轴不可用返回 0。 */
    private static long lastLineEndMs(WallpaperLyricsState.Snapshot snapshot) {
        long lastEnd = 0L;
        for (WallpaperLyricsState.TimedLine line : snapshot.lines) {
            if (line == null) {
                continue;
            }
            /*
             * 结束时间缺失（end <= 0，某些来源只给了起始时间）时拿起始时间兜底。
             *
             * 不兜底的话，只要**最后一句**没有 end，整首歌的结束时间就会算成 0，
             * 于是"唱完收起"这个开关从头到尾一次都不会触发 —— 用户看到的就是
             * 「歌词放完了它还在那儿」。
             */
            long candidate = line.endMs > 0L ? line.endMs : line.startMs;
            if (candidate > lastEnd) {
                lastEnd = candidate;
            }
        }
        // 时间轴的结束时间跑到了整首歌时长之外（坏数据）：按整首歌结束算，
        // 否则要等到一个永远到不了的位置。留 1 秒余量，避免正常的取整误差被当成坏数据。
        if (snapshot.durationMs > 0L && lastEnd > snapshot.durationMs + 1000L) {
            lastEnd = snapshot.durationMs;
        }
        return lastEnd;
    }

    /**
     * 歌词是不是已经唱完了（并且已经唱完好一会儿）。
     *
     * **判定必须锁存。** 这边的播放位置是「锚点 + 墙钟外推」算出来的，
     * 而应用会不定期把锚点推过来（换行校正、拖动判定），两边并不同步：
     * 越界的那一刻只要被应用推回来的锚点拉回去一次，收起流程就整个撤销，
     * 再往后又要重新等 —— 表现出来就是「有概率不会消失」。
     * 所以这里一旦越过就记下墙钟，只有位置真的退回到最后一句之内才清零。
     */
    private boolean lyricsFinished(WallpaperLyricsState.Snapshot snapshot) {
        if (snapshot.placeholderOnly || !tuningFlag("wp.hideAfterLyricsEnd", true)) {
            lyricsEndSinceMs = 0L;
            return false;
        }
        long end = lastLineEndMs(snapshot);
        if (end <= 0L || snapshot.positionMs() <= end) {
            lyricsEndSinceMs = 0L;
            return false;
        }
        long now = SystemClock.elapsedRealtime();
        if (lyricsEndSinceMs == 0L) {
            lyricsEndSinceMs = now;
            return false;
        }
        return now - lyricsEndSinceMs >= LYRICS_END_GRACE_MS;
    }

    /** 读一个 wp. 开头的布尔开关，缺省用 fallback。 */
    private static boolean tuningFlag(String key, boolean fallback) {
        Float value = WallpaperLyricsState.tuning().get(key);
        if (value == null) {
            return fallback;
        }
        return value >= 0.5f;
    }

    /**
     * 叠层总开关。关掉它一层都不挂 —— **包括锁屏页**。
     *
     * 以前这几条起锁屏页的路只问了 showOnLockScreen，总开关根本没进判定：
     * 关掉总开关之后巡检照样把锁屏页起来 → 起完发现 shouldShow() 是 false
     * （总开关那一支在最前面就返回了）→ 立刻 finish → 下一轮再起。
     * 用户看到的就是「关了总开关，锁屏界面还在一下一下地闪」，
     * 而且每闪一次消耗一次后台启动配额，三次之后彻底不再来。
     */
    private static boolean overlayMasterEnabled() {
        return tuningFlag("wp.overlayEnabled", true);
    }

    /**
     * 叠层是不是「只在锁屏上出现」。
     *
     * 这个开关的语义是"别的地方都别挂"，所以它**隐含要求**锁屏页起来 ——
     * 用户不应该为了"只在锁屏显示"再去开第二个开关。
     */
    private static boolean overlayLockScreenOnly() {
        return tuningFlag("wp.overlayLockScreenOnly", false);
    }

    /** 锁屏这条路上到底要不要干活：任一开关打开都要。 */
    private static boolean lockScreenWanted() {
        return tuningFlag("wp.showOnLockScreen", false) || overlayLockScreenOnly();
    }

    /** 整体窗口的不透明度。缺省 1（完全不透明）。 */
    private static float overlayOpacity() {
        Float value = WallpaperLyricsState.tuning().get("wp.overlayOpacity");
        if (value == null) {
            return 1f;
        }
        return Math.min(1f, Math.max(0.1f, value));
    }

    /**
     * 窗口参数里「允许显示在锁屏之上」这一位当前是什么。
     *
     * FLAG_SHOW_WHEN_LOCKED 在 API 27 就 deprecated 了，官方让改用
     * Activity.setShowWhenLocked(boolean) —— 但叠层不是 Activity，是 WindowManager
     * 直接加的悬浮窗，那条路走不通。对悬浮窗来说这一位仍然是唯一有效的做法。
     */
    private boolean appliedShowWhenLocked = false;

    @SuppressWarnings("deprecation")
    private void applyShowWhenLockedFlag() {
        if (params == null) {
            return;
        }
        if (appliedShowWhenLocked) {
            params.flags |= WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED;
        } else {
            params.flags &= ~WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED;
        }
    }

    /** 「音乐锁屏」开关变了就把这一位跟上。值没变不动窗口，免得每 250ms 触发一次重排。 */
    private void syncWindowFlags() {
        // 「仅在锁屏显示」同样需要这一位：锁屏页起不来时它靠的就是悬浮窗那一支。
        boolean wanted = lockScreenWanted();
        if (wanted == appliedShowWhenLocked) {
            return;
        }
        appliedShowWhenLocked = wanted;
        applyShowWhenLockedFlag();
        if (added) {
            relayout();
        }
    }

    /** 把设置里的不透明度落到窗口上。值没变就不动，免得每 250ms 触发一次重绘。 */
    private float appliedOpacity = -1f;

    private void applyOpacity() {
        if (webView == null) {
            return;
        }
        /*
         * 过渡期间 —— **以及等待首帧的那段时间** —— 不透明度由 stepFade 接管。
         *
         * fadeInPending 也必须算进去：窗口是按 alpha=0 挂上去的，但等首帧的这几秒里
         * 巡检会不停跑，如果这里没拦住，就会先把透明度拉到满值，等页面回报首帧、
         * 淡入再开始时又从头拉一遍 —— 用户看到的是
         * 「突然出现 → 透明度降低 → 再恢复」，三次变化全是不该有的。
         */
        if (fadingOut || fadingIn || fadeInPending) {
            return;
        }
        float target = overlayOpacity();
        if (Math.abs(target - appliedOpacity) < 0.01f) {
            return;
        }
        appliedOpacity = target;
        // Alpha 设在窗口参数上（而不是 WebView 的 setAlpha）：
        // 走 WindowManager 的 alpha 由系统合成，桌面和叠层各画各的，不会互相透过。
        if (params != null) {
            params.alpha = target;
            WindowManager windowManager =
                    (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
            try {
                windowManager.updateViewLayout(webView, params);
            } catch (Throwable ignored) {
                // 窗口已经没了。
            }
        }
    }

    /** 壁纸可见性变化。系统只在可见时才让叠层工作。 */
    void setWallpaperVisible(boolean value) {
        runOnUi(() -> applyWallpaperVisible(value));
    }

    private void applyWallpaperVisible(boolean value) {
        wallpaperVisible = value;
        if (value) {
            // 回到桌面是用户看得见的动作：直接对齐，不等迟滞（否则每次切回桌面
            // 都要等一秒才淡入，看起来像"慢半拍"）。
            alignWantShowNow();
            ensureShown();
        } else if (!appDriven) {
            /*
             * 开了「在所有应用上叠加」就别收 —— 壁纸不可见不等于用户不想看它。
             *
             * 注意这里要走 requestHide()（渐隐后再移除），不能直接 detach()：
             * 切应用正是用户最常看到的那次"消失"，直接抽窗口就没有过渡了。
             */
            requestHide();
        }
        // 常驻盯着：用户可能在任意时刻改设置，那时壁纸往往正不可见。
        scheduleWatch();
    }

    /**
     * 设置变了就重载页面。
     *
     * 为什么必须重载：叠层是一个**独立的 WebView 上下文**，里面的 store 只在页面加载时
     * 从 localStorage 读一次。用户在应用里改「只显示文字」这类设置时写的是主 WebView 的
     * localStorage —— 两个上下文之间没有同步机制，已打开的叠层页面永远看不到这次改动。
     * 重载是最省事也最可靠的对齐方式（设置改动很少，重载一次的成本可以忽略）。
     */
    private String lastTuningHash = null;

    private void reloadOnTuningChange() {
        if (webView == null) {
            return;
        }
        String hash = WallpaperLyricsState.tuning().toString();
        if (hash.equals(lastTuningHash)) {
            return;
        }
        boolean first = lastTuningHash == null;
        if (first) {
            lastTuningHash = hash;
            return;
        }
        /*
         * 节流没通过时**绝不能**把 hash 先记下来。
         *
         * 记了就等于承认"这版设置已经生效了"，而这一次的重载其实被跳过了 ——
         * 之后 hash 一直对得上，再也不会有人来补这一刀，改动就**永久丢失**。
         * 用户看到的就是「在实验台里改了参数，叠层那层没反应」，而且是随机发生：
         * 取决于这次改动是不是刚好落在上一次重载之后的 30 秒里。
         * 让 hash 一直"欠着"，下一个窗口就补上。
         */
        if (SystemClock.elapsedRealtime() - lastLoadAtMs < TUNING_RELOAD_INTERVAL_MS) {
            return;
        }
        lastTuningHash = hash;
        /*
         * 设置变化不用自愈那条 30 秒的节流：那是给"页面可能自己坏了"准备的
         * （抖起来会连着重载），而这一条是用户刚刚亲手改的，几秒内就应该看到。
         * 重载必须走 loadPage 的完整复位，不能只调 webView.reload()：
         *
         * reload() 只换页面，pageReady / pushConfirmed / 推送签名 / 不透明度全都留在
         * 旧页面的状态上 —— 重载后页面是空的，窗口却还保持着满不透明，
         * 而且新页面没有收到过任何数据（pushConfirmed 还是 true，ensureDelivered
         * 不会再补推），一直空到下一次状态变化才更新。alpha 也没被压回 0，
         * 空窗期原样露给用户，就是一次凭空的"闪"。
         * loadPage 会把 alpha 压回 0、等新页面真的画出第一帧再淡入 ——
         * 和首次出现是同一条路径，观感一致。
         */
        loadPage(lastScreenWidth, lastScreenHeight);
        // 页面重载会丢推送状态，签名清掉，下一轮把当前歌词重新推一遍。
        lastSignature = null;
    }

    /** 见 reloadOnTuningChange：设置变化引起的重载走这个（短）节流。 */
    private static final long TUNING_RELOAD_INTERVAL_MS = 3000L;

    /**
     * 两份页面之间至少隔这么久（毫秒）才允许换一份新的。
     *
     * 换页面是**看得见的动作**：alpha 压回 0 → 等新页面画出第一帧 → 再淡入。
     * 自愈类的触发（设置变了 / 页面没确认收到 / 内容核对不上）一旦有抖动，
     * 隔几秒就来一次，用户看到的就是「叠层突然消失，然后又出现」。
     * 给一道节流：抖得再凶，最多也就是这个间隔一次，而且真需要重载的那种故障
     * （页面彻底没起来）本来也不是靠频率解决的。
     */
    private static final long MIN_RELOAD_INTERVAL_MS = 30000L;

    /**
     * 自愈用的重载。和 `loadPage` 的区别只有节流 —— 转屏、首次挂载走 loadPage，不受它限制。
     */
    private void reloadForRecovery(String reason) {
        long elapsed = SystemClock.elapsedRealtime() - lastLoadAtMs;
        if (lastLoadAtMs > 0L && elapsed < MIN_RELOAD_INTERVAL_MS) {
            Log.w(TAG, "Skipping overlay reload (" + reason + "): last load was "
                    + elapsed + "ms ago");
            return;
        }
        Log.w(TAG, "Reloading overlay page (" + reason + ")");
        loadPage(lastScreenWidth, lastScreenHeight);
    }

    /**
     * 加载页面，并把屏幕尺寸换算成 CSS 像素一并传给它，让页面把自己的根节点钉死在这个尺寸上。
     *
     * 为什么不让页面用 100vw/100vh：WebView 的布局视口和窗口实际大小不一定一致，
     * 页面按自己的视口排版时，可视化就会画在一个比屏幕小的画布里。
     * 尺寸从原生给，才是确定的。
     */
    private void loadPage(int screenWidth, int screenHeight) {
        if (webView == null) {
            return;
        }
        // 每次（重新）加载都从"未就绪"算起，等 onPageFinished 再置回 true。
        pageReady = false;
        lastLoadAtMs = SystemClock.elapsedRealtime();
        // 同理，新页面还没收到过任何东西。
        pushConfirmed = false;
        // 旧页面留下的「等首帧」轮询对新页面没有意义（它问的是同一个 webView，
        // 但语义已经换了一轮），取消掉，等新的 pushState 再起一条。
        cancelPaintPoll();
        /*
         * 已经挂着的窗口要重新加载页面（改了设置 / 转屏）时，先把不透明度压回 0。
         *
         * 不压的话，页面从"有内容"变成"空白（透明底）"再变成"新内容"的那一两秒
         * 会原样显示出来 —— 用户看到的就是「闪一下」。压到 0 之后这段时间看不见，
         * 等新页面真的画出第一帧再淡入，和首次出现是同一条路径。
         */
        if (added && params != null) {
            params.alpha = 0f;
            appliedOpacity = 0f;
            fadingIn = false;
            fadingOut = false;
            // 重载之后的这份页面要重新走「等首帧 → 淡入」，不再是休眠窗口。
            dormantSinceMs = 0L;
            fadeInPending = true;
            fadeInDeadlineMs = SystemClock.elapsedRealtime() + FADE_IN_TIMEOUT_MS;
            relayout();
        }
        float density = context.getResources().getDisplayMetrics().density;
        int cssWidth = density > 0f ? Math.round(screenWidth / density) : screenWidth;
        int cssHeight = density > 0f ? Math.round(screenHeight / density) : screenHeight;
        try {
            webView.loadUrl(PAGE_URL + "?w=" + cssWidth + "&h=" + cssHeight);
        } catch (Throwable ignored) {
            // 页面还没准备好，下一次同步会补上。
        }
    }

    /** 当前真实屏幕尺寸（像素）。 */
    private int[] screenSize() {
        WindowManager windowManager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            android.graphics.Rect bounds = windowManager.getCurrentWindowMetrics().getBounds();
            return new int[]{bounds.width(), bounds.height()};
        }
        android.util.DisplayMetrics metrics = new android.util.DisplayMetrics();
        //noinspection deprecation
        windowManager.getDefaultDisplay().getRealMetrics(metrics);
        return new int[]{metrics.widthPixels, metrics.heightPixels};
    }

    private int lastScreenWidth;
    private int lastScreenHeight;

    /**
     * 转屏后重新对齐。
     *
     * 窗口尺寸和页面里的舞台尺寸都是「创建那一刻」算出来的：屏幕一转，
     * 两者都还是旧值 —— 竖屏尺寸的画布摆在横屏屏幕上，看上去就是
     * 「只占半张屏、而且还是竖的」。窗口要重设，页面也要按新尺寸重新加载
     * （舞台尺寸走的是 URL 参数，不重载拿不到新值）。
     */
    private void syncScreenSize() {
        if (webView == null || params == null) {
            return;
        }
        int[] size = screenSize();
        if (size[0] == lastScreenWidth && size[1] == lastScreenHeight) {
            return;
        }
        boolean first = lastScreenWidth == 0;
        lastScreenWidth = size[0];
        lastScreenHeight = size[1];
        if (first) {
            return;
        }
        params.width = size[0];
        params.height = size[1];
        WindowManager windowManager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        try {
            windowManager.updateViewLayout(webView, params);
        } catch (Throwable ignored) {
            // 窗口已经没了。
        }
        loadPage(size[0], size[1]);
        // 页面重载会丢推送状态，签名清掉，下一轮把当前歌词重新推一遍。
        lastSignature = null;
    }

    private void schedulePush() {
        if (pushScheduled) {
            return;
        }
        pushScheduled = true;
        handler.postDelayed(pushTask, PUSH_INTERVAL_MS);
    }

    private void scheduleWatch() {
        if (watchScheduled) {
            return;
        }
        watchScheduled = true;
        // 过渡期间要跑得勤一点，否则一帧一帧往下掉，看着是台阶不是渐变。
        handler.postDelayed(watchTask, (fadingOut || fadingIn) ? FADE_TICK_MS : PUSH_INTERVAL_MS);
    }

    /**
     * 只在「状态真的变了」的时候注入。
     *
     * 签名里放的是**锚点位置**（anchorPositionMs），不是外推出来的当前位置 ——
     * 锚点只在切歌 / 拖动进度条 / 播放暂停这些离散事件上变，
     * 正常播放期间它是不动的，于是签名不变、一次都不推，页面自己按 rAF 往前走。
     *
     * 末尾的 stamp：每次 `WallpaperLyricsState.publish` 都会刷新（setAnchor / setAppearance 不会）。
     * 没有它的话签名对「时间轴内容变化」几乎是瞎的 —— lines 只进了 length：
     * 换歌是两步走（App 先推新歌名 + 旧歌词，歌词解析完再推一次），若两首歌行数恰好
     * 相同、两次的锚点数值又接近，第二次 publish 的签名会和上次推给页面的撞车，
     * 「状态没变」把真正带新时间轴的这次更新整个吞掉 —— 页面就永远停在
     * 「新歌名 + 旧歌词」上，直到暂停再播放触发整页重建。stamp 让任何一次
     * publish 都必然改变签名，这个中间态窗口被彻底关死。
     */
    private String lastSignature = null;

    /**
     * 页面已经就绪但还没确认收到过数据时，清掉签名重推 —— 直到它真的收到为止。
     *
     * 见 `pushConfirmed` 的说明：签名去重一旦建在"我以为推过去了"之上，
     * 后面就再也不会推，页面永远空着。这个循环是那件事的自愈出口。
     */
    private void ensureDelivered() {
        if (!added || webView == null || !pageReady || pushConfirmed) {
            return;
        }
        // 页面就绪 10 秒还没确认收到，就别再空转了（页面本身多半有问题）。
        if (SystemClock.elapsedRealtime() - pageReadyAtMs > 10000L) {
            return;
        }
        lastSignature = null;
        pushState();
    }

    /**
     * 页面一直没确认收到数据 → 重载一份新页面重试。
     *
     * 「等页面就绪」和「等送达确认」这两道闸门任一卡住，叠层就会**永远**停在空状态：
     * 窗口是挂着的、也淡入过了，但歌词一次都不更新 —— 用户看到的正是
     * 「有概率不更新歌词」。所以必须有一个到点重来的出口，而不能只靠等。
     *
     * 节奏用 `lastLoadAtMs` 卡住：重载之后要再等一个完整周期才允许下一次，
     * 否则页面还没起来就又被重载一次，变成每轮都在重启。
     */
    private void recoverStalledPage() {
        if (!added || webView == null || params == null || pushConfirmed) {
            return;
        }
        if (lastLoadAtMs <= 0L
                || SystemClock.elapsedRealtime() - lastLoadAtMs < PAGE_STALL_RECOVER_MS) {
            return;
        }
        reloadForRecovery("page-stalled");
        lastSignature = null;
    }

    /**
     * 跟页面核对「你手里现在是什么」，对不上就补推。
     *
     * 核对三样：歌名、时间轴（行数 + 首行文本）、位置漂移。只核对歌名是不够的 ——
     * 换歌是两步走（先推新歌名 + 旧歌词），推送被签名吞掉时页面停在
     * 「新歌名 + 旧歌词」上，歌名核对看着一切正常。位置核对治的是另一半：
     * 页面拿着一份过期的锚点外推，跟原生自己算的位置差出好几秒 ——
     * 用户看到的就是「歌词不同步」，以前只有暂停再播放（整页重建）能救回来。
     *
     * 补推只针对「真的丢了 / 真的偏了」，正常播放期间两边位置差不到一秒，
     * 一次都不会推 —— 所以不会引入那种每段都被拽回去的抽搐。
     */
    private void verifyPageContent() {
        if (!added || webView == null || !pageReady || !pushConfirmed) {
            return;
        }
        long now = SystemClock.elapsedRealtime();
        if (now - lastVerifyAtMs < VERIFY_INTERVAL_MS) {
            return;
        }
        lastVerifyAtMs = now;
        final WallpaperLyricsState.Snapshot snapshot = WallpaperLyricsState.get();
        if (snapshot.title.isEmpty() && snapshot.lines.length == 0) {
            return;
        }
        final String expectedTitle = snapshot.title;
        final int expectedLineCount = snapshot.lines.length;
        final String expectedFirstLine = expectedLineCount > 0 ? snapshot.lines[0].text : "";
        final long expectedPositionMs = snapshot.positionMs();
        try {
            webView.evaluateJavascript(PAGE_STATE_EXPR, value -> {
                if (value == null) return;
                String raw = value.trim();
                // evaluateJavascript 返回的是 JSON 字符串：外层引号要剥掉。
                if (raw.length() >= 2 && raw.startsWith("\"") && raw.endsWith("\"")) {
                    raw = raw.substring(1, raw.length() - 1);
                }
                boolean mismatch = false;
                try {
                    org.json.JSONObject page = new org.json.JSONObject(raw);
                    String pageTitle = page.optString("t", "");                    int pageLineCount = page.optInt("n", -1);
                    String pageFirstLine = page.optString("f", "");
                    long pagePositionMs = page.optLong("p", -1L);
                    if (!pageTitle.equals(expectedTitle)) {
                        mismatch = true;
                    } else if (expectedLineCount > 0
                            && (pageLineCount != expectedLineCount
                            || !pageFirstLine.equals(expectedFirstLine))) {
                        /*
                         * 歌名对但时间轴还是旧的（换歌中间态被吞）：必须补推。
                         *
                         * 只在原生这边真的有歌词时才比：换歌的空档里 App 推的是
                         * 「新歌名 + 还没解析好的歌词」，而页面会**有意沿用上一份**
                         * （见 wallpaperSurface 的 STALE_FALLBACK_MS，为的是不闪）。
                         * 这时候页面比原生多几行是设计如此，不是故障 ——
                         * 拿它当 mismatch 的话，每换一次歌就要重载一份页面。
                         */
                        mismatch = true;
                    } else if (pagePositionMs >= 0L
                            && Math.abs(pagePositionMs - expectedPositionMs) > POSITION_DRIFT_TOLERANCE_MS) {
                        // 歌词和时间轴都对，但两边各推各的、差出好几秒（页面锚点过期）。
                        mismatch = true;
                    }
                } catch (Throwable parseError) {
                    // 页面表达式返回了意料外的东西：当作对不上，补推一次最安全。
                    mismatch = true;
                }
                if (!mismatch) {
                    contentMismatchStreak = 0;
                    return;
                }
                /*
                 * 连续几次都对不上，就别再只补推了 —— 换一页重来。
                 *
                 * 「补推的内容页面根本没吃到」可能是 JS 那边已经卡住了
                 * （某个状态在中途被覆盖、rAF 停了）。这时候补推多少次都没用，
                 * 用户看到的就是「歌词永远停在那一刻，只有暂停再播放（整页重建）才好」。
                 * 连续 4 次（约 12 秒）都对不上，判定这一份页面已经没救，重载一份。
                 */
                contentMismatchStreak += 1;
                if (contentMismatchStreak >= 4) {
                    contentMismatchStreak = 0;
                    reloadForRecovery("content-mismatch");
                    lastSignature = null;
                    return;
                }
                // 页面手里的状态已经过期：清掉签名，下一句 pushState 全量补推。
                lastSignature = null;
                pushState();
            });
        } catch (Throwable ignored) {
            // 页面正忙，下一轮再核对。
        }
    }

    /**
     * 问页面「你现在拿着什么」：歌名、行数、首行文本、按它自己的锚点外推出的当前位置。
     * 页面在 `__foliaWallpaperPush` 里维护 `__foliaWallpaperLatest` / `__foliaWallpaperReceivedAt`。
     */
    private static final String PAGE_STATE_EXPR =
            "(function(){var l=window.__foliaWallpaperLatest;if(!l)"
                    + "return JSON.stringify({t:'',n:-1,p:-1});"
                    + "var ls=l.lines||[];"
                    + "var pos=l.playing?(l.positionMs+(performance.now()"
                    + "-window.__foliaWallpaperReceivedAt)):l.positionMs;"
                    + "return JSON.stringify({t:(l.title||''),n:ls.length,"
                    + "f:(ls.length?(ls[0].text||''):''),p:Math.round(pos)});})()";

    /**
     * 位置核对的容差。两边都是「锚点 + 各自的墙钟」外推，正常漂移不到一秒；
     * 差出这个量级只可能是页面拿的锚点已经过期（推送被吞 / 时序交错）。
     * 给得足够宽，保证正常播放一次都不会触发补推（防抽搐）。
     */
    private static final long POSITION_DRIFT_TOLERANCE_MS = 5000L;

    private void pushState() {
        if (webView == null || !pageReady) {
            /*
             * 页面还没就绪就别推、也**别记签名**。
             *
             * 之前这里不判断就绪，于是"推过"这件事被记在了一份还没加载完的页面上；
             * 等页面真的好了，状态没变 → 一次都不推。转屏 / 重载之后不刷新、
             * 只有拖动进度条才同步，都是这个坑。
             */
            return;
        }
        WallpaperLyricsState.Snapshot snapshot = WallpaperLyricsState.get();
        String signature = snapshot.playing
                + "@" + snapshot.anchorPositionMs
                + "@" + snapshot.title
                + "@" + snapshot.artist
                + "@" + snapshot.lines.length
                + "@" + snapshot.visualizerMode
                + "@" + snapshot.backgroundMode
                + "@" + snapshot.showTranslation
                + "@" + snapshot.stamp;
        // 注意 lastSignature 在 detach 时会被清空：页面是重新加载出来的，
        // 「上次推过什么」对它没有意义。不清的话切回桌面后签名没变、一次都不推，
        // 就会出现「回到桌面没歌词，非得暂停一下触发事件才更新」。
        if (signature.equals(lastSignature)) {
            return;
        }
        String payload = buildPayload();
        if (payload == null) {
            return;
        }
        lastSignature = signature;
        try {
            /*
             * 让页面回报一个递增计数：只有拿到非空计数才算**真的送达**。
             *
             * evaluateJavascript 在页面还在导航时会静默丢掉调用而不报错，
             * 光看"没抛异常"根本分不清送没送到 —— 这正是之前那几个
             * "状态没变就再也不推" 类 bug 的根源。
             */
            webView.evaluateJavascript(
                    "(function(){if(window.__foliaWallpaperPush){window.__foliaWallpaperPush("
                            + payload + ");}return window.__foliaWallpaperPushCount||0;})()",
                    value -> {
                        try {
                            if (value != null && Integer.parseInt(value.trim()) > 0) {
                                pushConfirmed = true;
                            }
                        } catch (Throwable ignored) {
                            // 解析不了就当作没确认，下一轮会再推一次。
                        }
                    });
        } catch (Throwable ignored) {
            // 页面还没加载完时调用会失败，下一次推送会补上。
            return;
        }
        /*
         * 第一份**真正送到**页面里的数据已经交出去了。
         *
         * 但不能就此开始淡入：可视化是懒加载的（chunk 下载 + Pixi/WebGL 初始化），
         * 从"收到数据"到"真的画出东西"中间还有一段空窗。按固定延时淡入就会淡入到
         * 一个还没画完的页面 —— 用户看到"闪一下黑、然后突然出现"。
         *
         * 所以这里反过来问页面：`__foliaWallpaperPainted` 由页面在首帧画出来之后置位。
         * 一直没等到就等到超时（FADE_IN_TIMEOUT_MS），不能因为一个信号把歌词永远藏着。
         */
        /*
         * 判据必须和页面那边 `hasData` 完全一致（有歌名 **或** 有歌词行都算有内容）。
         *
         * 只认歌名的话，切歌那一刻应用先把时间轴推过来、标题还空着（常见于流媒体），
         * 淡入就被一直挂着，只能等兜底超时才显示 —— 用户看到的是"隔了好几秒才冒出来"。
         */
        boolean hasContent = !snapshot.title.isEmpty() || snapshot.lines.length > 0;
        if (fadeInPending && pageReady && hasContent) {
            fadeInPending = false;
            awaitPaintedThenFade(SystemClock.elapsedRealtime() + FADE_IN_TIMEOUT_MS);
        }
    }

    /**
     * 只发可见的那几行，而不是整条时间轴：
     * 桥上一次传几十行 JSON 每 200ms 走一遍没有意义，页面只画当前行与翻译。
     */
    private String buildPayload() {
        WallpaperLyricsState.Snapshot snapshot = WallpaperLyricsState.get();
        long position = snapshot.positionMs();
        try {
            JSONObject out = new JSONObject();
            out.put("positionMs", position);
            out.put("playing", snapshot.playing);
            out.put("durationMs", snapshot.durationMs);
            out.put("title", snapshot.title);
            out.put("artist", snapshot.artist);
            out.put("visualizer", snapshot.visualizerMode);
            out.put("accent", colorToHex(snapshot.accent));
            out.put("backgroundColor", colorToHex(snapshot.baseColor));

            // 必须发**整条时间轴**，不能只发当前行附近那几行。
            // 可视化的「唱完了」是按它拿到的 lines 判定的 ——
            // 只给几行的话，画到那几行末尾它就当成整首结束，直接显示播放完毕。
            // 推送已经改成只在离散事件触发，整条轴一次几百毫秒才走一回，不值得为省这点流量埋这种雷。
            JSONArray lines = new JSONArray();
            for (int i = 0; i < snapshot.lines.length; i++) {
                WallpaperLyricsState.TimedLine line = snapshot.lines[i];
                JSONObject entry = new JSONObject();
                entry.put("text", line.text);
                entry.put("start", line.startMs);
                entry.put("end", line.endMs);
                if (line.translation != null) {
                    entry.put("translation", line.translation);
                }
                lines.put(entry);
            }
            out.put("lines", lines);
            return out.toString();
        } catch (Throwable error) {
            return null;
        }
    }

    private static String colorToHex(int color) {
        return String.format(Locale.US, "#%06X", color & 0xFFFFFF);
    }

    /**
     * 把 https://localhost/... 的请求拦回 APK 里的 assets/public/...。
     * 用 https 而不是 file:// 是因为页面是 ES module，file:// 下会被当跨源资源拒绝加载。
     */
    /** 页面加载完到真正能收数据之间留一点空档。 */
    private static final long PAGE_PUSH_DELAY_MS = 140L;
    /** 问页面"画出来了吗"的间隔。 */
    private static final long PAINT_POLL_INTERVAL_MS = 120L;
    /**
     * 等页面首帧的上限：懒加载的 chunk 没下完、或者信号丢了，最多等这么久就开始淡入。
     * 不能为了一个信号把歌词一直藏着 —— 宁可淡入得早一点。
     */
    private static final long FADE_IN_TIMEOUT_MS = 5000L;

    /**
     * 注意这里是**非静态**内部类：`onPageFinished` 要清实例上的 `lastSignature`
     * （见那边的说明）。
     */
    private final class AssetClient extends WebViewClient {

        @Override
        public void onPageFinished(WebView view, String url) {
            // 页面真的就绪了 —— 只有从这一刻起，推送才算"送到了"，
            // 淡入也才有意义（否则淡入会播给一个空页面，等于没有渐变）。
            pageReady = true;
            pageReadyAtMs = SystemClock.elapsedRealtime();
            /*
             * 页面是新的，之前记的「推过什么」对它毫无意义 —— 关键是不清的话，
             * 紧接着那次推送经常会掉在「JS 还没就绪」的空档里：
             * 签名已经记下了，但页面其实什么都没收到，之后所有推送都被
             * 「状态没变」挡掉，页面永远停在空状态。
             * 表现就是：转屏 / 重载之后不刷新，只有拖动进度条（改了锚点、签名跟着变）
             * 才会同步一次。
             */
            lastSignature = null;
            handler.postDelayed(WallpaperOverlay.this::pushState, PAGE_PUSH_DELAY_MS);
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (uri == null || !LOCAL_HOST.equals(uri.getHost())) {
                return null;
            }
            String path = uri.getPath();
            if (path == null || path.isEmpty() || "/".equals(path)) {
                path = "/wallpaper.html";
            }
            String asset = "public" + path;
            try {
                InputStream stream = view.getContext().getAssets().open(asset);
                return new WebResourceResponse(guessMime(path), "utf-8", stream);
            } catch (IOException error) {
                return null;
            }
        }
    }

    private static String guessMime(String path) {
        String lower = path.toLowerCase(Locale.US);
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }
}
