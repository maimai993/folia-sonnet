package top.izuna.foliamajor.wallpaper;

import android.annotation.SuppressLint;
import android.content.Context;
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
    /** 应用侧托管：开了「在所有应用上叠加」时由应用进程直接挂着，不要求壁纸是我们。 */
    private boolean appDriven = false;

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
     * 应用侧托管开关。开了「在所有应用上叠加」时由应用进程直接挂着 ——
     * 这样即使系统壁纸根本不是我们（甚至没设动态壁纸），也能在桌面上看到叠层。
     */
    public void setAppDriven(boolean enabled) {
        if (appDriven == enabled) {
            return;
        }
        appDriven = enabled;
        if (enabled) {
            if (shouldShow()) {
                attach();
            }
            scheduleWatch();
        } else if (!wallpaperVisible) {
            // 同样走渐隐；巡检循环保持常驻（requestHide 里会续上），
            // 否则关了开关就再也没人盯着它该不该重新挂上。
            requestHide();
        }
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
            // 「在所有应用上叠加」打开后，即使回到桌面之外也要继续挂着，
            // 所以这里不能只用「壁纸可见」作为前提。
            if (shouldShow()) {
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
                // 该收了：先渐隐，隐完 stepFade 里再真正移除。
                startFadeOut();
            }
            // 窗口被系统悄悄摘掉了：把状态复位，下一轮会重新挂上。
            if (added && webView != null
                    && SystemClock.elapsedRealtime() - attachAtMs > 3000L
                    && !webView.isAttachedToWindow()) {
                detach();
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
        if (added && !fadingOut) {
            // 正在淡入的话直接就地反向：从**当前**不透明度往回收。
            // 等淡入走完再回头的话，中间会先亮到满值再暗下去 —— 那一下就是"闪"。
            // 起点取实时值，接得上，看起来只是"出来一半又回去了"。
            startFadeOut();
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
            detach();
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
        if (added || !canOverlay(context)) {
            return;
        }
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

        params = new WindowManager.LayoutParams(
                screenWidth,
                screenHeight,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                // 不吃触摸（桌面照常点）、不抢焦点（不影响输入法/按键）、不受系统栏限制铺满全屏。
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        // NOT_TOUCHABLE 已经让事件穿到下层了，NOT_TOUCH_MODAL 是再兜一层：
                        // 窗口外的事件一律交给后面的窗口，不参与"是否模态"的判定。
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = 0;
        params.y = 0;
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
        // 页面会被销毁，重新 attach 时是全新的一份 —— 推送签名必须一起清掉，
        // 否则「状态没变」会被判成不用推，页面就永远等不到第一份数据。
        lastSignature = null;
        appliedOpacity = -1f;
        // 渐变状态跟着窗口一起清掉：下一次 attach 会重新开始淡入。
        fadingOut = false;
        fadingIn = false;
        fadeInPending = false;
        fadeInDeadlineMs = 0L;
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
        WallpaperLyricsState.Snapshot snapshot = WallpaperLyricsState.get();
        // 精简模式不挂叠层。
        if ("minimal".equals(snapshot.visualizerMode)) {
            return false;
        }
        // 纯音乐（没有歌词）：可视化画不出歌词，只剩余背景动效。
        // 有人要的就是这时候干净点，做成开关（默认开）。
        // 判定用 placeholderOnly 而不是行数 —— 纯音乐时原生会补一行占位文案，
        // 按行数判会被那行占位骗过去，开关就失效了。
        if (snapshot.placeholderOnly && tuningFlag("wp.skipInstrumental", true)) {
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
        // 「在所有应用上叠加」打开时不再要求壁纸可见 ——
        // 叠层本来就在壁纸之上，这一项只是放宽"必须停在桌面"这个前提。
        return wallpaperVisible || appDriven;
    }

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
     */
    private static final long HIDE_DEBOUNCE_MS = 1200L;
    private long hideSignalSinceMs = 0L;

    /** 见 HIDE_DEBOUNCE_MS。返回 true 才允许走收起流程。 */
    private boolean shouldHideNow() {
        if (shouldShow()) {
            hideSignalSinceMs = 0L;
            return false;
        }
        long now = SystemClock.elapsedRealtime();
        if (hideSignalSinceMs == 0L) {
            hideSignalSinceMs = now;
            return false;
        }
        return now - hideSignalSinceMs >= HIDE_DEBOUNCE_MS;
    }

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

    /** 整体窗口的不透明度。缺省 1（完全不透明）。 */
    private static float overlayOpacity() {
        Float value = WallpaperLyricsState.tuning().get("wp.overlayOpacity");
        if (value == null) {
            return 1f;
        }
        return Math.min(1f, Math.max(0.1f, value));
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
        wallpaperVisible = value;
        if (value && shouldShow()) {
            attach();
        } else if (!value && !appDriven) {
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
        lastTuningHash = hash;
        if (first) {
            return;
        }
        /*
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
        reloadForRecovery("tuning-changed");
        // 页面重载会丢推送状态，签名清掉，下一轮把当前歌词重新推一遍。
        lastSignature = null;
    }

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
