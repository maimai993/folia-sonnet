package top.izuna.foliamajor.wallpaper

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.text.TextPaint
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager


/**
 * 壁纸样式 = 「精简」时挂的那颗**简易桌面歌词悬浮窗**。
 *
 * 为什么要单独一层：精简模式下 `WallpaperOverlay` 那层 WebView 根本不挂（见 shouldShow），
 * 桌面上看到的是原生壁纸那层 GLES 歌词。可用户要的是「像音乐平台那样的悬浮窗」——
 * 能拖、能改大小、能锁、点一下进应用 —— 那是壁纸做不到的：壁纸不收触摸，也没有窗口边界。
 *
 * 所以这一层是**系统悬浮窗**（SYSTEM_ALERT_WINDOW + WindowManager），内容用原生 Canvas 画，
 * 不拉 WebView，也不起 GLES：两行字而已，为一个小窗口背一份 WebView / GL 上下文不划算。
 *
 * 显示逻辑照抄原生壁纸那份「简易」的歌词画法（LyricsRenderer 的常量与曲线搬过来）：
 * 焦点行 + 下一行、换行走入的淡入上滑（easeOutCubic，420ms）、焦点行极缓的呼吸、
 * 逐字（逐词）扫光。区别只有一处：这里**只画两行**（壁纸那层是上下各展开到三行）。
 *
 * 数据复用了现成的 WallpaperLyricsState —— 它就是壁纸 / 叠层 / 锁屏页共用的那一份，
 * 应用推一次，这一层就有；不用另开一条通路。
 */
class FloatingLyricsOverlay private constructor(context: Context) {

    companion object {
        private const val TAG = "FloatingLyrics"
        private const val PREFS = "folia_floating_lyrics"
        private const val KEY_X = "x"
        private const val KEY_Y = "y"
        private const val KEY_W = "w"
        private const val KEY_H = "h"
        private const val KEY_LOCKED = "locked"

        /** 巡检间隔：歌词状态是应用推过来的，没有回调可用，只能自己问。 */
        private const val POLL_INTERVAL_MS = 600L
        /** 没有存过位置时的默认尺寸（dp）。两行字，够宽就行。 */
        private const val DEFAULT_WIDTH_DP = 268
        private const val DEFAULT_HEIGHT_DP = 96
        private const val MIN_WIDTH_DP = 132
        private const val MIN_HEIGHT_DP = 58
        private const val MAX_WIDTH_DP = 460
        private const val MAX_HEIGHT_DP = 260
        /**
         * 锁定后那颗解锁按钮的边长（dp）。
         *
         * 必须正好是 26：主窗把锁画在 `(宽 - 13dp, 13dp)`，只有以那一点为心的 26dp 方框
         * 才能严丝合缝盖住它 —— 大了会多吃掉一块触摸区，小了点不准。
         */
        private const val LOCK_CHIP_DP = 26
        /** 纯音乐要唱过这么久才认定「确实没歌词」，与叠层同一个数。 */
        private const val INSTRUMENTAL_CONFIRM_MS = 4000L
        /** 最后一句唱完再留这么久才收窗：片尾那段没有歌词，立刻收会显得突兀。 */
        private const val LYRICS_END_GRACE_MS = 4000L
        /** 小窗底色的默认浓度。滑条没推过来时用它（与 store 里那个缺省值同一个数）。 */
        private const val DEFAULT_BACKGROUND_OPACITY = 0.62f

        /** 开关：小窗直接叠在安全区（状态栏那一条）上面，而不是摆在屏幕里。 */
        private const val KEY_OVER_SAFE_AREA = "wp.floatingOverSafeArea"
        /** 叠加模式下窗口占屏幕宽度的比例（0 = 没设）。 */
        private const val KEY_WIDTH = "wp.floatingWidth"
        /** 字号模式：0 = 动态（跟着窗口高度算），1 = 自定义。 */
        private const val KEY_FONT_SIZE_MODE = "wp.floatingFontSizeMode"
        /** 自定义模式的字号（dp）。只在上面那个开关打开时用。 */
        private const val KEY_FONT_SIZE = "wp.floatingFontSize"
        /**
         * 叠加模式下窗口高度的下限（dp）。
         *
         * 正常是拿系统的 status_bar_height（一般 24~40dp）。少数 ROM 不提供那个 dimen，
         * 读出来是 0 —— 那时窗口高度会变成 0，整层直接看不见，所以兜一个能画下
         * 一行字的高度。
         */
        private const val MIN_SAFE_AREA_HEIGHT_DP = 26f
        /** 左右位置：0 = 贴左，1 = 贴右。只有「叠加安全区」开着时才用得上。 */
        private const val KEY_OFFSET_X = "wp.floatingOffsetX"
        /**
         * 开关：叠加模式下直接**占满整条安全区**（左右不再留空，宽度滑条让位）。
         *
         * 非竖屏时这一条不生效（见 `fillSafeArea()`）：横屏下状态栏那一条的意义完全不同，
         * 占满只会糊住一整条。
         */
        private const val KEY_FILL_SAFE_AREA = "wp.floatingFillSafeArea"
        /**
         * 占满时留出来的「避开区域」宽度（占整条宽的比例）。0 = 不避让。
         *
         * 挖孔屏 / 刘海屏上，状态栏正中或某一侧有个洞，字压上去就成了「字被切了一块」。
         * 由于各家 ROM 都不往外报挖孔位置，只能让用户自己指：多宽、在哪边。
         */
        private const val KEY_AVOID_WIDTH = "wp.floatingAvoidWidth"
        /** 避开区域的左右位置：0 = 贴左，1 = 贴右。 */
        private const val KEY_AVOID_OFFSET_X = "wp.floatingAvoidOffsetX"
        /**
         * 开关：在 App 里也把这一层挂出来，好让设置页当场看到改动（预览）。
         *
         * 没有它的话「实时预览」是个空话 —— 正常逻辑里 `_appForeground` 一命中就不挂，
         * 而调设置恰恰是在 App 里做的，滑条拖到头也看不见任何东西。
         * 由设置页挂载期间置 1、离开置 0。
         */
        /*
         * 预览**不再是 tuning 表里的一个 key**。
         *
         * 原来它叫 wp.floatingPreview，和「叠加安全区」「宽度」这些真设置挤在同一张表里。
         * 而那张表是**落盘的**（WallpaperLyricsState.setAppearance → SharedPreferences）：
         * 应用一旦被杀 / 崩在设置页里，「关掉预览」那一次就永远发不出来，
         * 盘上的 1 留到下辈子 —— 于是两个症状同时出现：
         *   ① buildParams() 里 `previewMode()` 为真 → 强制 FLAG_NOT_TOUCHABLE → 小窗拖不动；
         *   ② shouldShow() 里 `if (preview) return true` → 暂停 / 没歌词 / 唱完都照样挂，
         *      isShowing() 恒真 → 壁纸那层以为「小窗在显示」，原生歌词就再也不画了
         *      （用户原话：我没有打开隐藏原生歌词，原生歌词在所有情况下都不显示了）。
         *
         * 预览从来不是设置，它是**一次会话内的瞬时状态**（设置页还开着）。
         * 所以它现在走独立通道，只活在进程内存里，并且带租约：
         * 没人续就自动过期。进程被杀、页面没卸载、事件丢了 —— 哪一条出问题都能自愈。
         */
        /** 预览的租约时长。前端在设置页期间会定期续约。 */
        private const val PREVIEW_LEASE_MS = 45_000L
        /**
         * 「应用在前台」这份状态的心跳租约。
         *
         * 问「App 现在在前台吗」的不止一个进程：壁纸服务（LyricsWallpaperService）
         * 跑着**同一份** FloatingLyricsOverlay，而它永远收不到 Activity 的 onResume / onPause。
         * 于是它的 _appForeground 恒为 false —— App 开在前台、播放页自己正画着
         * 可视化歌词，壁纸那边还挂了一颗悬浮窗，屏幕上就是两份一模一样的（用户原话）。
         *
         * 租约而不是一个布尔开关：应用被杀时不会有机会把开关写成 false，
         * 留给壁纸进程的就是一个永远的 true，桌面歌词从此再也不出来。
         * 心跳过期 = 「没人来续了」= 应用不在前台了 —— 这条推论不需要任何人来收尾。
         */
        private const val FOREGROUND_LEASE_MS = 5000L
        /** 心跳落在盘上的键。只有应用进程会写，壁纸进程读。 */
        private const val KEY_FOREGROUND_PING = "fg_ping"
        /**
         * 预览又没有歌词可显示时画的占位。
         *
         * 挑一行「什么语言都认识」的：它只是让人看清位置 / 大小 / 避开区域，
         * 长度也要够 —— 太短的话绕不过避开区域，看不到那条缝在哪。
         */
        private const val PREVIEW_SAMPLE_TEXT = "♪ ♪ ♪ ♪ ♪ ♪ ♪ ♪"
        /** 用户在叠加模式下拖出来的左右位置（0~1）。拖过就以它为准，设置里改了再覆盖。 */
        private const val KEY_DRAG_RATIO = "drag_ratio"

        /** 淡出时长：快得跟手、慢得不突兀。 */
        private const val FADE_OUT_MS = 320L

        /** 换行走入的时长（毫秒）与曲线：和原生壁纸那份同一个数，两边观感才一致。 */
        private const val LINE_ENTER_MS = 420L
        /** 走入时从下方多远滑上来（单位 = 行距）。 */
        private const val LINE_ENTER_RISE = 0.16f
        /** 焦点行极缓的呼吸幅度。 */
        private const val LINE_BREATH = 0.05f
        /** 整层淡入（挂上窗口那一刻）。 */
        private const val APPEAR_MS = 220L
        /**
         * 小窗上那两颗控件（右上角的锁、右下角的拉伸把手）在「没人碰它」多久之后收起来。
         *
         * 这是一层叠在所有应用之上的桌面歌词：锁和把手一直亮着，就等于在别人家的界面上
         * 常驻两个半透明圆点。所以只有手指落在窗上（或刚拖过、刚要上锁）的时候才画，
         * 过了这段时间就隐掉，窗干净的只剩歌词。
         *
         * **锁着的时候例外**：那颗锁是整层穿透之后唯一还能点的地方（见 syncLockChip），
         * 收起来就再也解不开了。见 `controlsAwake()`。
         */
        private const val CONTROLS_IDLE_MS = 2200L
        /** 次行的字号比例（下一行）与翻译行的字号比例。 */
        private const val NEXT_FONT_RATIO = 0.86f
        private const val TRANSLATION_FONT_RATIO = 0.62f
        /**
         * 自绘动画的帧间隔（≈30fps）。
         *
         * 这一层叠在所有窗口之上，每画一帧系统就要重新合成一次；两行字的扫光
         * 在 30fps 下看不出差别，但 CPU 与功耗是一半。壁纸那层跑满帧是因为它
         * 是 GLES 且本来就在全屏刷。
         */
        private const val FRAME_INTERVAL_MS = 33L
        /**
         * 长句缩字号的**下限**（原字号的比例）。
         *
         * 缩到 0.5 的老做法对长句等于把字压成一团，还不如让它横向滚 —— 所以缩到
         * 0.72 就收手，剩下的宽度交给滚动跟随。
         */
        private const val MIN_TEXT_SHRINK = 0.72f
        /**
         * 滚动的提前量：把正在唱的那个字顶到可视区宽度的这个比例处。
         *
         * 0.35 = 唱的位置大致停在靠前三分之一，右边留着一大截还没唱到的 ——
         * 既不会等到字撞边才动，也不会把后面整句都推出去。
         */
        private const val SCROLL_LEAD = 0.35f
        /** 每帧朝滚动目标靠近的比例：直接落位会是一跳，慢慢跟才像滚。 */
        private const val SCROLL_EASE = 0.16f

        // ---- 触摸 ----
        private const val MODE_NONE = 0
        private const val MODE_MOVE = 1
        private const val MODE_RESIZE = 2
        private const val MODE_LOCK = 3

        /**
         * 预览租约的到期时刻（elapsedRealtime）。过了就算没开，见 previewMode()。
         *
         * 必须是 volatile：写它的是主线程（桥那一路），读它的是 GLES 渲染线程
         * （壁纸那边通过 isShowing() 间接读）。
         */
        @Volatile
        private var previewUntilMs: Long = 0L

        @Volatile
        private var instance: FloatingLyricsOverlay? = null

        @JvmStatic
        @Synchronized
        fun shared(context: Context): FloatingLyricsOverlay {
            var inst = instance
            if (inst == null) {
                inst = FloatingLyricsOverlay(context.applicationContext)
                instance = inst
            }
            return inst
        }

        private fun tuningFlag(key: String, fallback: Boolean): Boolean {
            val tuning = WallpaperLyricsState.tuning()
            val value: Float? = if (tuning == null) null else tuning[key]
            return if (value == null) fallback else value >= 0.5f
        }

        /** 读一个 wp. 开头的数值开关，缺了就用 fallback。 */
        /**
         * 读一个 tuning 浮点值。
         *
         * 区间要**逐个 key 传** —— 早先这里写死 `clamp(value, 0.05f, 1f)`，
         * 于是自定义字号（10~32dp）被夹成 1dp，画出来只有一两个像素高；
         * 而背景不透明度想调到 0（完全透明）时又被顶回 0.05。
         * 这些 key 的量纲根本不一样，不能共用一个区间。
         */
        private fun tuningFloat(key: String, fallback: Float, min: Float, max: Float): Float {
            val tuning = WallpaperLyricsState.tuning()
            val value: Float? = if (tuning == null) null else tuning[key]
            if (value == null || !value.isFinite()) return fallback
            return clamp(value, min, max)
        }

        /** 小窗是否直接叠在安全区上面。 */
        private fun overSafeArea(): Boolean {
            return tuningFlag(KEY_OVER_SAFE_AREA, false)
        }

        /**
         * 设置页正开着：即使在 App 里也要挂出来给人看。
         *
         * 判据是**租约有没有过期**，不是「有没有人来关过」——
         * 后者要指望一次卸载事件，而那次事件是这世界上最靠不住的东西
         * （应用被杀、崩了、WebView 被回收，它都不会来）。租约过期自动失效，
         * 谁都不用为「关掉预览」这件事负责。
         */
        private fun previewMode(): Boolean {
            return SystemClock.elapsedRealtime() < previewUntilMs
        }

        /** 读一个 wp. 开头的原始数值（不夹到 0.05：左右位置需要允许取 0）。 */
        private fun rawTuningFloat(key: String, fallback: Float): Float {
            val tuning = WallpaperLyricsState.tuning()
            val value: Float? = if (tuning == null) null else tuning[key]
            if (value == null || !value.isFinite()) return fallback
            return value
        }

        private fun clamp(value: Float, min: Float, max: Float): Float {
            return Math.max(min, Math.min(max, value))
        }

        private fun clampInt(value: Int, min: Int, max: Int): Int {
            return Math.max(min, Math.min(max, value))
        }

        private fun clamp01(value: Float): Float {
            return if (value < 0f) 0f else if (value > 1f) 1f else value
        }

        /** 与原生壁纸那份同一个缓动：先快后慢，短一点才叫「一点点动画」。 */
        private fun easeOutCubic(value: Float): Float {
            val t = clamp01(value)
            val inverse = 1f - t
            return 1f - inverse * inverse * inverse
        }
    }

    private val context: Context
    private val windowManager: WindowManager
    private val handler = Handler(Looper.getMainLooper())
    private val prefs: SharedPreferences

    private var view: LyricsFloatView? = null
    private var params: WindowManager.LayoutParams? = null
    @Volatile
    private var added = false
    /** 锁定后单独挂的那颗解锁按钮（另一个窗口，见 syncLockChip）。 */
    private var chipView: LockChipView? = null
    private var chipParams: WindowManager.LayoutParams? = null
    private var chipAdded = false
    private var _appForeground = false
    /**
     * 本进程是不是**有 Activity 的那个**（= 应用进程）。
     *
     * 只有应用进程会被 MainActivity 调 setAppForeground，所以它那份 _appForeground
     * 才是真话；壁纸进程没人调，那个字段恒为 false，不能拿来用（见 FOREGROUND_LEASE_MS）。
     */
    private var appForegroundKnown = false
    /** 上一次量到的屏幕尺寸（0 = 还没量过）。转屏时用来把位置按比例搬过去。 */
    private var lastScreenW = 0
    private var lastScreenH = 0
    /** 上一次生效的模式。变了就整套重摆，见 applyModeChangeIfNeeded。 */
    private var lastOverSafeArea: Boolean? = null
    private var lastFillSafeArea = false
    /** 上一次窗口是不是「不吃触摸」的状态。避免 600ms 一次的巡检重复调 updateViewLayout。 */
    private var lastTouchable: Boolean? = null
    @Volatile
    private var screenOn = true
    private var receiverRegistered = false
    private var polling = false

    init {
        this.context = context
        this.windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        this.prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    /** 应用在前台时收起来：桌面歌词是给「不在应用里」的时候看的。 */
    fun setAppForeground(foreground: Boolean) {
        appForegroundKnown = true
        if (_appForeground == foreground) {
            // 状态没变也要续一次：这是心跳，壁纸进程全靠它（见 _appForeground()）。
            if (foreground) pingForeground()
            return
        }
        _appForeground = foreground
        /*
         * 退到后台就把预览掐掉。
         *
         * 预览的全部意义是「人在 App 里调参数时也能看见那一层」，人已经走了它就没有
         * 存在的理由。而「应用退到后台」是系统给的一个**必然会发生**的信号
         * （比「设置页卸载了」可靠得多）—— 拿它当第二道保险，即使前端那边的
         * 关预览调用一次都没送达，用户切走再回来也是干净的：
         * 小窗重新按正常规则挂，壁纸那层的原生歌词也跟着回来。
         */
        if (foreground) {
            pingForeground()
        } else {
            // 退后台要**立刻作废**，不能让壁纸那边再等一个租约期 ——
            // 那几秒里桌面歌词会晚出来，看着像反应迟钝。
            prefs.edit().remove(KEY_FOREGROUND_PING).apply()
            previewUntilMs = 0L
        }
        evaluate()
    }

    /**
     * 应用是不是在前台。
     *
     * 本进程就是应用进程时，直接说自己那份（它是 Activity 回调喂出来的真话）；
     * 壁纸进程则看盘上那个心跳过没过期（见 FOREGROUND_LEASE_MS 上那段）。
     */
    private fun _appForeground(): Boolean {
        if (appForegroundKnown) return _appForeground
        return SystemClock.elapsedRealtime() -
                prefs.getLong(KEY_FOREGROUND_PING, 0L) < FOREGROUND_LEASE_MS
    }

    /**
     * 续一次前台心跳。
     *
     * 过半才真的写盘：巡检是 600ms 一趟，每趟都去动 SharedPreferences 是白烧
     * （apply 虽然异步，但每次都是整份重写）。租约 5 秒、2.5 秒续一次，够稳。
     */
    private fun pingForeground() {
        val now = SystemClock.elapsedRealtime()
        if (now - prefs.getLong(KEY_FOREGROUND_PING, 0L) < FOREGROUND_LEASE_MS / 2) return
        prefs.edit().putLong(KEY_FOREGROUND_PING, now).apply()
    }

    /**
     * 开 / 关预览。开的那一侧带租约，前端要定期续（见 PREVIEW_LEASE_MS）。
     *
     * 走独立通道而不是混在 tuning 表里：tuning 表会落盘，而预览是瞬时状态，
     * 落盘就等于「这次没关掉就再也不关了」。详见 PREVIEW_LEASE_MS 上面那段。
     */
    fun setPreview(on: Boolean) {
        previewUntilMs = if (on)
            SystemClock.elapsedRealtime() + PREVIEW_LEASE_MS
        else
            0L
        runOnUi { evaluate() }
    }

    /**
     * 这一层此刻是不是挂在屏幕上（壁纸那边要拿它决定自己还画不画歌词）。
     *
     * 必须是 volatile：读它的是 GLES 渲染线程，写它的是主线程。
     */
    fun isShowing(): Boolean {
        return added
    }

    /** 起巡检与屏幕监听。可以重复调用。 */
    fun start() {
        registerScreenReceiver()
        if (!polling) {
            polling = true
            handler.post(pollTask)
        }
        evaluate()
    }

    fun stop() {
        polling = false
        handler.removeCallbacks(pollTask)
        detach()
    }

    /**
     * 把拖出去 / 改坏的小窗恢复默认（位置、大小、锁一起清掉）。
     *
     * 必须有这个出口：小窗是靠角上的把手改的，用户把它拖到屏幕角落、或者缩到最小
     * 又上了锁之后，光靠手是很难弄回来的 —— 尤其「锁」这个状态只画一个很小的图标，
     * 看不出来是能点的。设置里给一颗「重置」按钮最省事。
     */
    fun resetLayout() {
        runOnUi {
            prefs.edit()
                    .remove(KEY_X)
                    .remove(KEY_Y)
                    .remove(KEY_W)
                    .remove(KEY_H)
                    .remove(KEY_LOCKED)
                    // 叠加模式拖出来的左右位置也一起清：不然「重置」完小窗还在老的那一侧。
                    .remove(KEY_DRAG_RATIO)
                    .apply()
            if (added && view != null) {
                val fresh = buildParams()
                applyLayout(fresh.x, fresh.y, fresh.width, fresh.height)
            }
            // 锁也一起解了：模式 / 锁 / 预览 三者决定这一层是否吃触摸，
            // 同步一次确保 flags 跟上当前状态，否则重置完小窗还是点不动。
            syncTouchable()
            syncLockChip()
            view?.invalidate()
        }
    }

    private val pollTask: Runnable = object : Runnable {
        override fun run() {
            if (!polling) return
            evaluate()
            handler.postDelayed(this, POLL_INTERVAL_MS)
        }
    }

    private val screenReceiver: BroadcastReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
            if (intent == null) return
            val action = intent.action
            if (Intent.ACTION_SCREEN_OFF.equals(action)) {
                screenOn = false
            } else if (Intent.ACTION_SCREEN_ON.equals(action) || Intent.ACTION_USER_PRESENT.equals(action)) {
                screenOn = true
            }
            evaluate()
        }
    }

    private fun registerScreenReceiver() {
        if (receiverRegistered) return
        receiverRegistered = true
        val filter = IntentFilter()
        filter.addAction(Intent.ACTION_SCREEN_ON)
        filter.addAction(Intent.ACTION_SCREEN_OFF)
        filter.addAction(Intent.ACTION_USER_PRESENT)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.registerReceiver(screenReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                context.registerReceiver(screenReceiver, filter)
            }
        } catch (error: Throwable) {
            Log.w(TAG, "register screen receiver failed", error)
        }
    }

    /** 该不该挂着这一层。每一条都对应一种「挂了反而添乱」的情况。 */
    private fun shouldShow(): Boolean {
        // 叠层总开关：关掉就一层都不挂（和锁屏页、WebView 叠层同一个开关）。
        if (!tuningFlag("wp.overlayEnabled", true)) return false
        if (!Settings.canDrawOverlays(context)) return false
        if (!screenOn) return false

        /*
         * 预览时**唯独**放行「在应用里」这一条。
         *
         * 正常逻辑在 App 里不挂是怕盖着自己的界面（播放页本身就有歌词），
         * 但调设置恰恰是在 App 里做的 —— 不放行的话，设置页那几根「实时预览」的滑条
         * 拖到头也看不到任何东西（这正是「看不到预览」）。
         * 预览窗口同时被强制成不吃触摸（见 buildParams），不会挡住底下的滑条。
         */
        val preview = previewMode()
        if (_appForeground() && !preview) return false

        val snapshot = WallpaperLyricsState.get()
        // 只有「精简」样式挂这一层：跟随样式走的是 WebView 叠层（那一层不挂是另一套逻辑）。
        if (!"minimal".equals(snapshot.visualizerMode)) return false

        /*
         * 预览只看**摆成什么样**，不看该不该出现 —— 暂停中、唱完了、甚至压根没放歌
         * 都得照样画出来，否则用户拨了半天开关面对的是一片空白，
         * 只会以为功能坏了（没歌词时走 onDraw 里那行占位）。
         */
        if (preview) return true

        /*
         * 心跳断了：播放管线已经没了（应用被划掉后台 / WebView 死透），
         * 快照里的歌词是死数据，收起来（预览例外：那是用户正在设置页里调的东西）。
         */
        if (!WallpaperLyricsState.heartbeatAlive()) return false

        /*
         * 「在所有应用上叠加」：关掉时只在能**确认**「用户在桌面」的时候挂。
         *
         * 这一层原先压根不读这个开关 —— 精简样式于是在任何应用上都压着，
         * 用户报的「关掉不生效」有一半是它。判据与 WebView 叠层共用一份
         * （WallpaperOverlay.desktopConfirmed：只有我们自己的壁纸正在画才叫"确认"），
         * 免得两层各判一套、一个关得掉一个关不掉。
         */
        if (!tuningFlag("wp.overlayAllApps", false)
                && !WallpaperOverlay.shared(context).desktopConfirmed()) return false

        // 这两条跟随叠层那两个开关：用户在设置里关了「暂停时隐藏 / 唱完隐藏」，
        // 那小窗就该跟着留着 —— 它是同一套桌面歌词，不该自己另立一套规则。
        if (!snapshot.playing && tuningFlag("wp.hideWhenPaused", true)) return false
        if (snapshot.lines == null || snapshot.lines.size == 0) return false
        // 纯音乐（原生补的那行占位）：没有真歌词可显示。
        if (snapshot.placeholderOnly && tuningFlag("wp.skipInstrumental", true)
                && snapshot.positionMs() > INSTRUMENTAL_CONFIRM_MS) {
            return false
        }
        if (!snapshot.placeholderOnly && tuningFlag("wp.hideAfterLyricsEnd", true)) {
            val end = snapshot.lines[snapshot.lines.size - 1].endMs
            if (end > 0L && snapshot.positionMs() > end + LYRICS_END_GRACE_MS) return false
        }
        return true
    }

    private fun evaluate() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            runOnUi {
                evaluate()
            }
            return
        }
        // 前台心跳：壁纸进程（同一个类、另一个进程）全靠它知道 App 在不在前台。
        if (appForegroundKnown && _appForeground) pingForeground()
        val want = shouldShow()
        if (want && !added) {
            // 淡出半路又该显示了：先把 alpha 拉回 1 再挂（不撤的话挂上来是半透明）。
            cancelFadeOut()
            attach()
        } else if (!want && added) {
            // 摘窗之前先淡出：暂停隐藏 / 心跳隐藏都不许突然消失（用户原话）。
            startFadeOut()
        } else if (want && added) {
            cancelFadeOut()
            // 转屏 / 换分辨率之后原来那个坐标可能已经出屏了，拉回来（不然小窗"消失"了）。
            reclampIfNeeded()
            // 模式 / 锁 / 预览租约 三者都可能在两次巡检之间变，它们自己不带布局动作，
            // 在这里把「是否吃触摸」同步一次；syncTouchable 内部有去重，不会重复调 update。
            syncTouchable()
        }
    }

    private fun runOnUi(action: Runnable) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            action.run()
        } else {
            handler.post(action)
        }
    }

    /**
     * 「叠加安全区」/「占满整条」翻了面就**整套重摆一次**。
     *
     * 只改开关不重摆的话，窗口会**留在上一个模式的几何里**：从安全区拨回普通模式，
     * 它还是「状态栏那么高、占屏 80% 宽」的一条 —— 右下角那个拉伸把手和右上角那颗锁
     * 全被压在这一条里（看着就是「不打开开关反而没有把手和锁」）；
     * 反过来从普通拨到安全区，它又是两行高的大方块，压住整条状态栏还不贴顶。
     *
     * 位置 / 尺寸是按 `buildParams()` 算的，而它只在挂窗口时走一次 ——
     * 开关本身不带任何布局动作，所以这里必须自己盯一次。
     */
    private fun applyModeChangeIfNeeded() {
        val overSafe = overSafeArea()
        val fill = fillSafeArea()
        if (lastOverSafeArea != null && lastOverSafeArea == overSafe && lastFillSafeArea == fill) {
            return
        }
        lastOverSafeArea = overSafe
        lastFillSafeArea = fill
        if (params == null || view == null || !added) return
        val fresh = buildParams()
        applyLayout(fresh.x, fresh.y, fresh.width, fresh.height)
        // 模式切换会改「该不该吃触摸」，applyLayout 只搬了 x/y/w/h，flags 要单独同步。
        syncTouchable()
        // 尺寸刚换过，可能又被系统夹下来（安全区那一路），再顶一次。
        nudgeIntoCutout()
        view?.invalidate()
    }

    /**
     * 叠加安全区模式下把那份**持久化**下来的锁清掉。
     *
     * 光改 `isLocked()` 的返回值不够：那份锁是写进 prefs 的。已经误锁的用户切到这个模式，
     * isLocked() 虽然返回 false，可只要他拨回普通模式，那份 true 又活过来、整层继续穿透；
     * 而 syncTouchable 每次都是按当前模式重设 flags —— 不清掉盘上那份，
     * 窗口一重建就再吃一次。这里在巡检里清一次，清完就不再进这个分支。
     */
    private fun clearLockWhenOverSafeArea() {
        if (!overSafeArea() || !prefs.contains(KEY_LOCKED)) return
        prefs.edit().remove(KEY_LOCKED).apply()
        syncTouchable()
    }

    private fun reclampIfNeeded() {
        applyModeChangeIfNeeded()
        clearLockWhenOverSafeArea()
        val p = params ?: return
        val screenW = context.resources.displayMetrics.widthPixels
        val screenH = context.resources.displayMetrics.heightPixels

        /*
         * 转屏（或换了分辨率）：位置按**比例**搬过去，不能沿用上一屏的像素坐标。
         *
         * 原来只是把旧坐标夹回新屏幕内 —— 竖屏算出来的 x 是「竖屏宽」的中点，
         * 横过来屏幕一下子宽了一倍多，那个 x 就变成了明显偏左（用户原话：
         * 「横屏状态下没有在最中间」）。安全区那套早就是按比例的（左右位置存 0~1），
         * 所以横屏下它仍然居中 —— 普通模式现在跟它一致：竖屏居中，横屏照样居中；
         * 拖到左边的，横屏也还在左边那个相对位置。
         */
        if (lastScreenW > 0 && lastScreenH > 0
                && (lastScreenW != screenW || lastScreenH != screenH)) {
            val ratioX = clamp01(p.x / Math.max(1, lastScreenW - p.width).toFloat())
            val ratioY = clamp01(p.y / Math.max(1, lastScreenH - p.height).toFloat())
            val spanW = Math.max(0, screenW - p.width)
            val spanH = Math.max(0, screenH - p.height)
            val x = clampInt(Math.round(ratioX * spanW), 0, spanW)
            val y = clampInt(Math.round(ratioY * spanH), 0, spanH)
            applyLayout(x, y, p.width, p.height)
            /*
             * 安全区模式下**不能落盘**。
             *
             * KEY_X/Y/W/H 是普通模式「用户自己拖出来的窗口」那一份：
             * 宽度是拖的、高度是两行字、位置是手指放的。而安全区模式下这四个数是
             * **按模式算出来的**（高度锁死成状态栏那一条，宽度是滑条给的屏幕比例，
             * 位置由左右滑条 / 拖动比例推得）—— 两套量纲根本不是一回事。
             *
             * 混着写，等用户把开关拨回普通模式，`buildParams()` 读到的就是安全区那份：
             * 一条贴着屏幕顶、又宽又扁的窗口，右下角把手和右上角那颗锁上下压在一起
             * （状态栏只有二十几 dp，把手的 16dp 和锁的 18dp 根本放不下）——
             * 看着就是「不打开开关反而没有把手和锁」。普通模式自己的尺寸也得留着，
             * 所以这里只摆不存。
             */
            if (!overSafeArea()) persistLayout()
        }
        lastScreenW = screenW
        lastScreenH = screenH

        if (overSafeArea()) {
            // 转屏之后宽度变了，左右比例要按新的屏幕重算一次，不然小窗会跑出去；
            // 高度跟着新的状态栏高度走（横屏时它可能不一样）。
            val density = context.resources.displayMetrics.density
            val width = overlayWidthPx(screenW, density, p.width)
            val x = overlayLeftPx(width, screenW)
            val height = statusBarHeightPx()
            /*
             * 「占满」在转屏这一刻可能刚失效（横过来）或刚恢复（竖回来），
             * 所以宽度也要一起比 —— 只比 x 的话横屏下会一直停在整条宽。
             */
            if (x != p.x || width != p.width || p.height != height) {
                applyLayout(x, p.y, width, height)
            }
            // 重新挂过一次之后可能又被系统夹下来了，再顶一遍。
            nudgeIntoCutout()
            return
        }
        val x = clampInt(p.x, 0, Math.max(0, screenW - p.width))
        val y = clampInt(p.y, 0, Math.max(0, screenH - p.height))
        if (x != p.x || y != p.y) {
            applyLayout(x, y, p.width, p.height)
            persistLayout()
        }
    }

    private fun attach() {
        if (added || view != null) return
        try {
            val newView = LyricsFloatView(context)
            val newParams = buildParams()
            view = newView
            params = newParams
            windowManager.addView(newView, newParams)
            added = true
            // 上过锁的话还得把那颗解锁按钮单独挂起来（主窗已经整体不吃触摸了）。
            syncLockChip()
            // 模式 / 锁 / 预览 三者决定这一层是否吃触摸；attach 后同步一次。
            syncTouchable()
            // 叠加模式下按实际量到的位置再往上顶一次（有些 ROM 会把这一层夹到状态栏之下）。
            nudgeIntoCutout()
        } catch (error: Throwable) {
            Log.w(TAG, "attach floating lyrics failed", error)
            view = null
            added = false
        }
    }

    private fun detach() {
        // 淡出 / 淡入链路收尾：窗口都没了，两条步进回调都不许再跑。
        // 这里不能用 cancelFadeOut() —— 它现在会「起淡入」，而这一刻正要摘窗，方向反了。
        fadingOut = false
        fadingIn = false
        handler.removeCallbacks(fadeStep)
        handler.removeCallbacks(fadeInStep)
        detachLockChip()
        val v = view
        if (!added || v == null) return
        // 视图自己排的下一帧不能留着：窗口已经摘了，那条 Runnable 还会把 view 拽着不让它回收。
        handler.removeCallbacks(v.frameTask)
        try {
            windowManager.removeView(v)
        } catch (error: Throwable) {
            Log.w(TAG, "detach floating lyrics failed", error)
        }
        view = null
        added = false
        lastTouchable = null
    }

    // ------------------------------------------------------------------
    // 淡出 / 淡入：摘窗之前把窗口 alpha 走到 0，别突然消失；
    // 淡出半路又该显示了，也从当前 alpha 平滑走回 1，别突然出现。
    // ------------------------------------------------------------------

    private var fadingOut = false
    private var fadingIn = false
    private var fadeFromAlpha = 1f
    private var fadeStartMs = 0L

    private val fadeStep: Runnable = object : Runnable {
        override fun run() {
            val p = params
            val v = view
            if (!fadingOut || !added || p == null || v == null) return
            val t = (SystemClock.elapsedRealtime() - fadeStartMs) / FADE_OUT_MS.toFloat()
            if (t >= 1f) {
                fadingOut = false
                detach()
                return
            }
            p.alpha = fadeFromAlpha * (1f - t)
            try {
                windowManager.updateViewLayout(v, p)
            } catch (ignored: Throwable) {
                // 窗口已经被系统摘了：下一拍的 detach 自己会兜住。
            }
            handler.postDelayed(this, 16L)
        }
    }

    /**
     * 淡出半路回来的那一趟。
     *
     * 方向与 fadeStep 相反：从 fadeFromAlpha 走回 1。时长按「还剩多少没走完」折算，
     * 所以在 0.3 处回来只用 320×(1-0.3)≈224ms，不会因为中途回来反而拖得更久。
     */
    private val fadeInStep: Runnable = object : Runnable {
        override fun run() {
            val p = params
            val v = view
            if (!fadingIn || !added || p == null || v == null) return
            val span = FADE_OUT_MS * (1f - fadeFromAlpha).coerceAtLeast(0.01f)
            val t = (SystemClock.elapsedRealtime() - fadeStartMs) / span
            if (t >= 1f) {
                fadingIn = false
                p.alpha = 1f
                try {
                    windowManager.updateViewLayout(v, p)
                } catch (ignored: Throwable) {
                }
                return
            }
            p.alpha = fadeFromAlpha + (1f - fadeFromAlpha) * t
            try {
                windowManager.updateViewLayout(v, p)
            } catch (ignored: Throwable) {
            }
            handler.postDelayed(this, 16L)
        }
    }

    /** 该收了：从当前 alpha 起步，320ms 淡到 0 再真正摘窗。 */
    private fun startFadeOut() {
        val p = params
        val v = view
        if (!added || p == null || v == null) {
            detach()
            return
        }
        if (fadingOut) return
        // 正在淡入时被叫回来收：从它走到的那一半继续淡出，不要跳回 1 再走。
        if (fadingIn) {
            fadingIn = false
            handler.removeCallbacks(fadeInStep)
        }
        fadingOut = true
        fadeFromAlpha = p.alpha
        fadeStartMs = SystemClock.elapsedRealtime()
        handler.post(fadeStep)
    }

    /**
     * 淡出半路又该显示了（恢复播放 / 心跳回来了）：摘窗取消，alpha 平滑走回 1。
     *
     * 以前这里直接把 alpha 写成 1f —— 用户在 320ms 之内按了恢复播放，窗口会从任意
     * 中间值（比如 0.3）**一跳**回到 1。本文件上面那条注释自己点名要避免「突然消失」，
     * 这是同一个毛病的反方向。壁纸那一层（WallpaperOverlay.stepFade）做对了，这条跟上。
     *
     * 没在淡出就直接回 1：没有起点可插值，也没人看得见这一跳。
     */
    private fun cancelFadeOut() {
        if (!fadingOut) return
        fadingOut = false
        handler.removeCallbacks(fadeStep)
        val p = params
        val v = view
        if (!added || p == null || v == null) return
        if (p.alpha >= 1f) return
        fadingIn = true
        fadeFromAlpha = p.alpha
        fadeStartMs = SystemClock.elapsedRealtime()
        handler.post(fadeInStep)
    }

    // ------------------------------------------------------------------
    // 锁定后的触摸：整层穿透，只有右上角那颗锁还能点
    // ------------------------------------------------------------------

    /**
     * 判断此刻该不该让整层「不吃触摸、直接穿透到下面那一层」。
     *
     * 锁定当然穿透；叠加安全区且非预览时也穿透 —— 预览要保留拖拽调位置的能力。
     *
     * 「占满整条安全区」是这条规则的唯一例外，**连预览也穿透**：占满之后左右没有
     * 余地、宽度拉伸把手也不画（见 `overlayWidthPx` / `overlayLeftPx`），窗口已经
     * 没有任何可拖的东西了，留着吃触摸只剩下坏处 —— 预览时它整条盖在屏幕最顶上，
     * 恰好压住设置页顶栏那颗返回键，而预览恰恰是在设置页里开的。
     */
    private fun passThroughTouch(): Boolean {
        if (isLocked()) return true
        if (fillSafeArea()) return true
        return overSafeArea() && !previewMode()
    }

    /**
     * 按当前模式重设 `FLAG_NOT_TOUCHABLE`。
     *
     * 这是唯一能让触摸**真的穿过去**的办法 —— `onTouchEvent` 返回 false 不管用：
     * 输入分发是**先按窗口挑一层**的，挑中了我们这一层，事件就落在这一层里，
     * 我们不处理它就只是丢掉，不会退给底下那一层（NOT_TOUCH_MODAL 只管窗口**外面**）。
     * 而 FLAG_NOT_TOUCHABLE 是整窗生效，所以那颗解锁按钮必须另开一个小窗口来接。
     *
     * 巡检每一趟都问一次：模式 / 锁 / 预览租约都可能在中途变，而它们三个都不带
     * 自己的布局动作。用 `lastTouchable` 避免没变化时重复调 updateViewLayout。
     */
    private fun syncTouchable() {
        val p = params
        if (p == null || !added) return
        val passThrough = passThroughTouch()
        if (lastTouchable != null && lastTouchable == passThrough) return
        lastTouchable = passThrough
        if (passThrough) {
            p.flags = p.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        } else {
            p.flags = p.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
        }
        applyLayout(p.x, p.y, p.width, p.height)
    }

    /**
     * 锁定后挂的那颗解锁按钮：**单独一个窗口**，只有右上角 26dp 见方那么大。
     *
     * 它**什么都不画** —— 锁那个图标是主窗画的（位置严丝合缝：主窗画在
     * `宽 - 13dp, 13dp`，这一块正好是以那一点为心的 26dp 方框），
     * 自己再画一遍就是两个半透明圆叠一起，颜色会变深。它的全部作用就是接触摸。
     */
    private fun syncLockChip() {
        if (!added || view == null || !isLocked()) {
            detachLockChip()
            return
        }
        if (chipAdded && chipView != null) {
            positionLockChip()
            return
        }
        try {
            val chip = LockChipView(context)
            val chipLp = buildChipParams()
            chipView = chip
            chipParams = chipLp
            windowManager.addView(chip, chipLp)
            chipAdded = true
        } catch (error: Throwable) {
            Log.w(TAG, "attach lock chip failed", error)
            chipView = null
            chipAdded = false
        }
    }

    private fun buildChipParams(): WindowManager.LayoutParams {
        val density = context.resources.displayMetrics.density
        val size = Math.round(LOCK_CHIP_DP * density)
        val p = params
        val x = if (p == null) 0 else p.x + p.width - size
        val y = if (p == null) 0 else p.y
        val lp = WindowManager.LayoutParams(
                size, size, x, y, windowType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                android.graphics.PixelFormat.TRANSPARENT)
        lp.gravity = Gravity.TOP or Gravity.LEFT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        return lp
    }

    /** 主窗挪过之后要跟着走：这一块是照着主窗右上角算出来的绝对坐标。 */
    private fun positionLockChip() {
        val chip = chipView
        val chipLp = chipParams
        val p = params
        if (!chipAdded || chip == null || chipLp == null || p == null) return
        val x = p.x + p.width - chipLp.width
        val y = p.y
        if (x == chipLp.x && y == chipLp.y) return
        chipLp.x = x
        chipLp.y = y
        try {
            windowManager.updateViewLayout(chip, chipLp)
        } catch (error: Throwable) {
            Log.w(TAG, "move lock chip failed", error)
        }
    }

    private fun detachLockChip() {
        val chip = chipView
        if (!chipAdded || chip == null) return
        try {
            windowManager.removeView(chip)
        } catch (error: Throwable) {
            Log.w(TAG, "detach lock chip failed", error)
        }
        chipView = null
        chipParams = null
        chipAdded = false
    }

    private fun windowType(): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else
            WindowManager.LayoutParams.TYPE_PHONE
    }

    private fun buildParams(): WindowManager.LayoutParams {
        val density = context.resources.displayMetrics.density
        val screenW = context.resources.displayMetrics.widthPixels
        val screenH = context.resources.displayMetrics.heightPixels

        var width = prefs.getInt(KEY_W, 0)
        var height = prefs.getInt(KEY_H, 0)
        if (width <= 0) width = Math.round(DEFAULT_WIDTH_DP * density)
        if (height <= 0) height = Math.round(DEFAULT_HEIGHT_DP * density)
        width = clampInt(width, Math.round(MIN_WIDTH_DP * density), Math.round(MAX_WIDTH_DP * density))
        height = clampInt(height, Math.round(MIN_HEIGHT_DP * density), Math.round(MAX_HEIGHT_DP * density))

        var x: Int
        var y: Int
        if (overSafeArea()) {
            /*
             * 叠加在安全区上面：贴着屏幕最顶上那条放（y = 0，盖住状态栏那一带），
             * 左右由比例决定 —— 这个模式下高度方向没有意义，只给左右。
             *
             * 高度**锁死**成状态栏那一条：这个模式要的就是占住那一带，
             * 让用户把它拖成三行高就等于把状态栏整条糊住了。宽度仍然可调（左右大小）。
             */
            height = statusBarHeightPx()
            /*
             * 宽度优先听设置里那根「宽度」滑条（屏幕宽的比例）。
             *
             * 用比例而不是 dp：这个模式要的就是「占住状态栏这一条的多宽」，
             * 说 30% 比说 120dp 直观，换设备也不会变样。
             *
             * 开了「占满」就是整条屏宽 —— 那时这两根滑条都不参与。
             */
            width = overlayWidthPx(screenW, density, width)
            x = overlayLeftPx(width, screenW)
            y = 0
        } else {
            x = prefs.getInt(KEY_X, Int.MIN_VALUE)
            y = prefs.getInt(KEY_Y, Int.MIN_VALUE)
            val hasPosition = x != Int.MIN_VALUE && y != Int.MIN_VALUE
            if (!hasPosition) {
                // 默认落在屏幕上方三分之一处居中：桌面歌词放中间会挡住图标，放最上面又压状态栏。
                x = Math.max(0, (screenW - width) / 2)
                y = Math.round(screenH * 0.22f)
            }
            // 换了屏幕（转屏 / 换设备）之后原来那个位置可能已经在屏幕外了，拉回来。
            x = clampInt(x, 0, Math.max(0, screenW - width))
            y = clampInt(y, 0, Math.max(0, screenH - height))
        }

        var flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
        /*
         * 这一层此刻该不该「整层不吃触摸」。
         *
         * 三种情形需要穿透：
         *  · 上着锁 —— 锁的含义就是「别再动它」，手指直接落到下面的桌面 / 应用上；
         *  · 叠加在安全区上、又不是在预览 —— 那一条压在别的应用顶上（状态栏那一条），
         *    它只是层装饰，不该替底下那一层把触摸吃掉；
         *  · 占满整条安全区 —— 连预览也算，详见 `passThroughTouch()`。
         *
         * 预览是例外中的例外：预览的全部意义就是「当场看见、当场调」，调的手段恰恰是拖 ——
         * 整层穿透就等于把唯一能调它的入口也一块儿关了（占满时没有可拖的东西，不受这条约束）。
         */
        if (passThroughTouch()) {
            flags = flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        }
        val lp = WindowManager.LayoutParams(
                width, height, x, y, windowType(), flags,
                android.graphics.PixelFormat.TRANSLUCENT)
        lp.gravity = Gravity.TOP or Gravity.LEFT
        /*
         * ALWAYS 而不是 SHORT_EDGES：SHORT_EDGES 只在「短边」允许延伸到挖孔区，
         * 横屏 / 某些 ROM 上会被判成不该延伸 —— 这一层要的就是能压到屏幕最顶上，
         * 含挖孔区在内。
         */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
        }
        return lp
    }

    private fun applyLayout(x: Int, y: Int, width: Int, height: Int) {
        val p = params
        val v = view
        if (p == null || v == null || !added) return
        p.x = x
        p.y = y
        p.width = width
        p.height = height
        try {
            windowManager.updateViewLayout(v, p)
        } catch (error: Throwable) {
            Log.w(TAG, "update floating lyrics layout failed", error)
        }
        positionLockChip()
    }

    private fun persistLayout() {
        val p = params ?: return
        prefs.edit()
                .putInt(KEY_X, p.x)
                .putInt(KEY_Y, p.y)
                .putInt(KEY_W, p.width)
                .putInt(KEY_H, p.height)
                .apply()
    }

    private fun isLocked(): Boolean {
        /*
         * 叠加安全区模式下**一律当没锁**。
         *
         * 这个模式下 `showControls` 为 false —— 那颗锁压根不画（窗口只有状态栏那么高，
         * 画上去就是压在歌词上的一坨），可命中区里 MODE_LOCK 却还在。
         * 于是「看不见、却点得到」：用户在右上角随手一碰就把整层设成
         * FLAG_NOT_TOUCHABLE，从此彻底穿透、什么也点不到、也拖不动，
         * 而那条锁还是**持久化**的，切回普通模式照样锁着（用户原话：点不了，触摸穿过去了）。
         *
         * 更根本的是这个模式压根不需要锁：位置、宽度、避开区域全由设置里的滑条管，
         * 锁唯一的作用就是「锁上之后连滑条也动不了它」—— 纯害无利。
         * 那份持久化的锁在 applyModeChangeIfNeeded 里顺手清掉。
         */
        if (overSafeArea()) return false
        return prefs.getBoolean(KEY_LOCKED, false)
    }

    /** 壁纸那边要拿它决定自己还画不画歌词，见 LyricsRenderer。 */
    fun isOverSafeArea(): Boolean {
        return overSafeArea()
    }

    private fun setLocked(locked: Boolean) {
        prefs.edit().putBoolean(KEY_LOCKED, locked).apply()
        view?.invalidate()
        // 顺序有讲究：先把主窗的触摸开关翻过来，再决定那颗解锁按钮挂不挂。
        syncTouchable()
        syncLockChip()
    }

    /*
     * 原来这里有个 openApp()：「点一下悬浮窗回到应用」。
     * 撤掉了 —— 这一层压在别的应用上面，点一下就把我们的应用拽到前台，
     * 既打断别人，也让「想拖一下小窗」变成不可能（手指一碰整屏就切走）。
     * 要回应用走通知栏 / 最近任务，不该让一层装饰性的歌词抢这个动作。
     */

    /**
     * 现在是不是竖屏。
     *
     * 用 `Configuration.orientation` 而不是量宽高：后者在分屏 / 折叠机上会把一个
     * 明明是竖着的应用窗口判成横屏，而这里要的只是「手机有没有被横过来」。
     */
    private fun portrait(): Boolean {
        return context.resources.configuration.orientation ==
                Configuration.ORIENTATION_PORTRAIT
    }

    /**
     * 是否「占满整条安全区」。
     *
     * 三个条件缺一不可：得先开着叠加安全区、得拨了这个开关、还得是竖屏。
     * 横屏下退回宽度滑条给的宽 —— 直接按「不占满」处理，用户转回来就又占满了，
     * 不需要额外记住任何状态。
     */
    private fun fillSafeArea(): Boolean {
        return overSafeArea() && tuningFlag(KEY_FILL_SAFE_AREA, false) && portrait()
    }

    /**
     * 叠加模式下窗口占屏幕宽度的比例（设置里那根「宽度」滑条）。0 = 没设，沿用拖出来的宽度。
     *
     * 50%~100% 才是有意义的范围：比一半还窄的话，一行歌词基本每句都要靠横向滚动才看得完。
     */
    private fun widthRatio(): Float {
        val value = tuningFloat(KEY_WIDTH, 0f, 0f, 1f)
        return if (value <= 0f) 0f else clamp(value, 0.2f, 1f)
    }

    /**
     * 叠加模式下窗口该多宽。
     *
     * 占满时就是整条屏幕宽 —— 那时左右滑条没有意义，宽度滑条也让位。
     */
    private fun overlayWidthPx(screenW: Int, density: Float, fallbackWidth: Int): Int {
        if (fillSafeArea()) return screenW
        val ratio = widthRatio()
        if (ratio <= 0f) return fallbackWidth
        return clampInt(Math.round(screenW * ratio),
                Math.round(MIN_WIDTH_DP * density), screenW)
    }

    /**
     * 占满整条时把「拖出来的左右位置」一起清掉。
     *
     * 那个比例是在**没占满**的时候拖出来的（那时左右还有余地），
     * 一旦整条占满就没意义了 —— 留着它，等占满失效（转横屏）的那一刻会被当成
     * 「用户拖到过那儿」，歌词就不在中间了。清掉之后退回设置里那根「左右位置」。
     */
    private fun dropDragRatioWhenFilled() {
        if (fillSafeArea() && prefs.contains(KEY_DRAG_RATIO)) {
            prefs.edit().remove(KEY_DRAG_RATIO).apply()
        }
    }

    /** 叠加模式下窗口的左边缘。占满时贴死 0。 */
    private fun overlayLeftPx(width: Int, screenW: Int): Int {
        if (fillSafeArea()) return 0
        return clampInt(Math.round((screenW - width) * offsetRatio()),
                0, Math.max(0, screenW - width))
    }

    /**
     * 让小窗立刻重画一帧。
     *
     * 自绘那套只在「还在播 / 动画没走完」时才排下一帧（省电），所以**暂停时**改了
     * 状态（比如从通知栏拖了进度条）不会自己重画 —— 得有人敲一下。
     */
    fun invalidateOverlay() {
        runOnUi {
            val v = view
            if (v != null && added) v.invalidate()
        }
    }

    /**
     * 设置里的「左右 / 宽度」改了之后立刻重新摆一次。
     *
     * 为什么必须显式调：tuning 表更新本身不会触发任何布局动作 —— 位置是在
     * `buildParams()` 里算的，而它只在挂窗口和转屏时走。少了这一下，
     * 滑条拖得再欢小窗也一动不动（正是「左右选项没用」）。
     */
    fun applyOverlayTuning() {
        runOnUi {
            val v = view
            if (v != null && added) v.invalidate()
            // 开关刚拨过：先把整套几何按新模式重摆，再谈位置（不然上面那一帧白敲）。
            applyModeChangeIfNeeded()
            val p = params
            if (!overSafeArea() || p == null || !added) return@runOnUi
            dropDragRatioWhenFilled()
            val screenW = context.resources.displayMetrics.widthPixels
            val height = statusBarHeightPx()
            val width = overlayWidthPx(
                    screenW, context.resources.displayMetrics.density, p.width)
            val x = overlayLeftPx(width, screenW)
            if (x != p.x || width != p.width || height != p.height) {
                applyLayout(x, p.y, width, height)
            }
            nudgeIntoCutout()
            // 重摆之后再敲一次：避开区域那两根滑条改的是绘制，不重画就看不出挪了。
            view?.invalidate()
        }
    }

    /**
     * 自定义模式的字号（像素）。0 = 没设 / 走动态。
     *
     * 动态字号是**跟着窗口高度算**的（拖大窗口字就跟着大），对多数人够用；
     * 但有人就是想要「字小一点、窗口还是那么大」，或者叠加模式下窗口只有状态栏
     * 那么高、算出来的字号小到看不清 —— 那种情况必须能自己指定。
     */
    private fun customFontSizePx(): Float {
        if (!tuningFlag(KEY_FONT_SIZE_MODE, false)) return 0f
        val dp = tuningFloat(KEY_FONT_SIZE, 0f, 0f, 64f)
        return if (dp <= 0f)
            0f
        else
            dp * context.resources.displayMetrics.density
    }

    /**
     * 状态栏（安全区）的高度。
     *
     * 不能靠网页那边的 `env(safe-area-inset-*)` —— 安卓上它只报挖孔、不报系统栏，
     * 无刘海机型一律返回 0。这里读系统自己的 `status_bar_height`。
     * 读到 0（极少数 ROM 不提供这个 dimen）时给一个能画下一行字的下限，
     * 否则窗口高度会变成 0、整层直接消失。
     */
    private fun statusBarHeightPx(): Int {
        val resId = context.resources.getIdentifier("status_bar_height", "dimen", "android")
        val value = if (resId > 0) context.resources.getDimensionPixelSize(resId) else 0
        val fallback = Math.round(MIN_SAFE_AREA_HEIGHT_DP *
                context.resources.displayMetrics.density)
        return Math.max(value, fallback)
    }

    /**
     * 把窗口**按实际量到的位置**再往上顶一次。
     *
     * `TYPE_APPLICATION_OVERLAY` 那层在不少 ROM 上会被系统夹到状态栏之下：
     * params.y 写 0，真画出来却掉在状态栏底边。写死一个负偏移在不同 ROM 上会过头
     * （另一批 ROM 本来就不夹，负 y 会把窗口上半截推出屏幕），所以这里反过来量：
     * 拿到窗口在屏幕上的真实顶边，差多少就补多少。
     */
    private fun nudgeIntoCutout() {
        if (!overSafeArea() || view == null || params == null || !added) return
        view?.post {
            val v = view
            val p = params
            if (v == null || p == null) return@post
            val location = IntArray(2)
            v.getLocationOnScreen(location)
            val delta = -location[1]
            if (delta != 0) {
                applyLayout(p.x, p.y + delta, p.width, p.height)
            }
        }
    }

    /**
     * 叠加模式下的左右位置（0~1）。
     *
     * 拖过就以拖出来的为准：设置里那根滑条只是给个初值，用户上手一拖就该听他的，
     * 否则每次巡检都用设置值把小窗拽回去，看起来就是「拖不动」。
     */
    private fun offsetRatio(): Float {
        val dragged = prefs.getFloat(KEY_DRAG_RATIO, Float.NaN)
        return if (dragged.isFinite()) clamp01(dragged)
        else clamp01(rawTuningFloat(KEY_OFFSET_X, 0.5f))
    }

    // =========================================================================
    // 悬浮窗本体
    // =========================================================================

    /**
     * 两行歌词的内容视图。
     *
     * 触摸这一块自己做：整层只有这一个 View，拖动 / 改大小 / 锁 / 点开应用全靠
     * 在 onTouchEvent 里按落点分派 —— 不用再往窗口里塞按钮（那会把触摸区吃掉，
     * 歌词本身反而点不到）。
     */
    private inner class LyricsFloatView(ctx: Context) : View(ctx) {

        private val backgroundPaint = Paint(Paint.ANTI_ALIAS_FLAG)
        private val controlPaint = Paint(Paint.ANTI_ALIAS_FLAG)
        /** 逐词下划线专用：绝不能拿 textPaint 去画矩形，它会把颜色和 alpha 留在字上。 */
        private val underlinePaint = Paint(Paint.ANTI_ALIAS_FLAG)
        /** 整行文本 → 词区间的缓存：ICU 分词逐帧跑一次太贵，同一行留着。 */
        private var cachedUnderlineText: String? = null
        private var cachedUnderlineBounds: List<FloatingVocab.Segment>? = null
        private val textPaint = TextPaint(Paint.ANTI_ALIAS_FLAG)
        private val frame = RectF()

        private var scrollOffsetPx = 0f

        /**
         * 「避开区域」在视图坐标里的左右边界。只有「占满安全区」开着才有值。
         *
         * 每帧在 `onDraw` 开头算一次存这里，而不是每行重算：两根滑条一帧内不会变，
         * 而 `drawRow` 一帧要跑两趟（焦点行 + 第二行），另外存成字段才能在
         * `dodgeAvoidZone` 里直接读，不用一路往下传。
         */
        private var avoidActive = false
        private var avoidLeftPx = 0f
        private var avoidRightPx = 0f

        private var lastIndex = -1
        private var transitionStartMs = 0L
        private var appearStartMs = 0L
        private var primaryColor = 0xFFFFFFFF.toInt()
        private var secondaryColor = 0xB3FFFFFF.toInt()
        private var accentColor = 0xFF7C5CFF.toInt()
        private var baseColor = 0xFF09090B.toInt()
        private var paletteStamp: Long = -1L
        /**
         * AI 主题里被标了色的那些词（主题的 `wordColors`）。
         *
         * 从叠层那一份主题 JSON 里解析出来（见 WallpaperThemePalette.readThemeJson），
         * 缓存住 —— 那是几百上千字符的 JSON，逐帧解析不划算。
         */
        private var wordRules: Array<FloatingWordColors.Rule> = FloatingWordColors.EMPTY
        /** 解析 wordRules 时用的那份 JSON，用来判断主题换没换。 */
        private var wordThemeJson: String? = null
        // 下面三个是「当前这一行的片段表」的小缓存：换行的 420ms 里同一行会被画几十帧，
        // 每帧都重新匹配一遍纯属浪费（一次匹配要扫几条短语 × 几十个词）。
        private var cachedSegmentLine: WallpaperLyricsState.TimedLine? = null
        private var cachedSegmentRules: Array<FloatingWordColors.Rule>? = null
        private var cachedSegments: Array<FloatingWordColors.Segment>? = null

        // ---- 触摸 ----
        private var touchMode = MODE_NONE
        private var startRawX = 0f
        private var startRawY = 0f
        private var startWinX = 0
        private var startWinY = 0
        private var startWidth = 0
        private var startHeight = 0
        private var downAtMs = 0L
        private var moved = false
        private var lastFrameAtMs = 0L
        private var framePending = false
        /**
         * 最后一次「碰这个窗」的时刻（按下 / 拖动都算）。
         *
         * 只看它决定锁和拉伸把手画不画 —— 触摸焦点不在小窗上时，那两颗就不该常驻
         * （这块是叠在别人界面之上的一层，见 CONTROLS_IDLE_MS）。
         */
        private var controlsTouchedAtMs = 0L
        /** 当前生效的字体 key（null = 系统默认）。变了就重新 load，见 syncFont。 */
        private var loadedFontKey: String? = null

        /**
         * 字体变了就重新加载 Typeface。
         *
         * 原来只在构造函数里 load 一次 —— 于是「设置里换了字体」在**已经挂着**的这一层上
         * 永远看不到，得等窗口重新挂一次（换歌 / 息屏再亮）才生效，
         * 表现就是「选了字体没反应」（用户原话：字体不会自动重载）。
         *
         * 判据用状态里那个 key（文件长度 + 修改时间），和壁纸渲染器同一套。
         * `setTypeface(null)` 就是回落系统默认，所以「清除字体」走同一条路。
         */
        private fun syncFont(fontKey: String?) {
            if (if (fontKey == null) loadedFontKey == null else fontKey.equals(loadedFontKey)) return
            loadedFontKey = fontKey
            textPaint.typeface = WallpaperLyricsFont.load(context)
        }

        private fun refreshPalette() {
            val snapshot = WallpaperLyricsState.get()
            accentColor = snapshot.accent
            baseColor = snapshot.baseColor
            val palette = WallpaperThemePalette.read(context)
            primaryColor = parseColor(palette[0], 0xFFFFFFFF.toInt())
            secondaryColor = parseColor(palette[1], 0xB3FFFFFF.toInt())
            paletteStamp = snapshot.stamp
            syncWordRules()
        }

        /**
         * 主题换过就重解析一次 `wordColors`。
         *
         * 不能只挂在 `paletteStamp` 上：换主题走的是 `setAppearance` 那条路，
         * 它不动 stamp（stamp 只在换歌时变）—— 只认 stamp 的话「暂停时换个 AI 主题」
         * 小窗这边就永远看不到新配色。所以每帧自己比一次 JSON 串：
         * SharedPreferences 读出来的是同一份缓存对象，绝大多数帧只是比个引用。
         */
        private fun syncWordRules() {
            val themeJson = WallpaperThemePalette.readThemeJson(context)
            if (if (themeJson == null) wordThemeJson == null else themeJson.equals(wordThemeJson)) {
                return
            }
            wordThemeJson = themeJson
            wordRules = FloatingWordColors.parse(themeJson)
        }

        private fun parseColor(value: String?, fallback: Int): Int {
            if (value == null || value.isEmpty()) return fallback
            try {
                return Color.parseColor(value)
            } catch (error: Throwable) {
                return fallback
            }
        }

        private fun dp(value: Float): Float {
            return TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value,
                    resources.displayMetrics)
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val width = getWidth()
            val height = getHeight()
            if (width <= 0 || height <= 0) return

            val snapshot = WallpaperLyricsState.get()
            if (snapshot.stamp != paletteStamp) {
                refreshPalette()
            } else {
                syncWordRules()
            }
            // 换过字体就重新 load（只比一个字符串，没换就直接返回）。
            syncFont(snapshot.font)

            val now = android.os.SystemClock.elapsedRealtime()
            var appear = clamp01((now - appearStartMs) / APPEAR_MS.toFloat())
            appear = easeOutCubic(appear)

            drawBackground(canvas, width, height, appear)

            /*
             * 叠加模式下不画那两颗控件。
             *
             * 窗口只有状态栏那么高，锁那一颗（圆心 13dp、半径 9dp）会占掉整条的一大半
             * 并压在歌词上。而这个模式本来也不需要拖 / 改大小 / 上锁 ——
             * 左右位置和宽度都在设置里调，手势在这里反而是负担。
             */
            val showControls = !overSafeArea() && controlsAwake(now)

            // 避开区域每帧算一次（两根滑条一帧内不会变，而 drawRow 一帧要跑两趟）。
            updateAvoidZone(width)

            val position = snapshot.positionMs()
            val index = if (snapshot.lines == null || snapshot.lines.size == 0)
                -1 else snapshot.indexAt(position)

            /*
             * 下面这一串布局提前算：预览时可能一句歌词都没有，
             * 那行占位也得按同一套位置 / 字号画，不然预览跟真身对不上。
             */
            /*
             * 叠加模式下只有**一行**：窗口高度就是状态栏那一条（二十几到四十 dp），
             * 硬塞两行的话每行只剩几个 dp，字根本画不出来。
             */
            val singleRow = overSafeArea()
            val padY = if (singleRow) Math.min(dp(6f), height * 0.1f) else dp(10f)
            val rowHeight = if (singleRow) (height - padY * 2f) else (height - padY * 2f) / 2f
            val focusY = if (singleRow) height * 0.5f else padY + rowHeight * 0.5f
            val secondY = padY + rowHeight * 1.5f
            var focusSize = if (singleRow) rowHeight * 0.82f else rowHeight * 0.62f
            /*
             * 自定义字号覆盖上面那个「按窗口高度算」的动态值。
             *
             * 仍然夹一行高之内：给个 40dp 而窗口只有 20dp 的话，字会上下被裁掉，
             * 看着像坏了 —— 这时候应该去把窗口拖大，而不是让字溢出。
             */
            val customSize = customFontSizePx()
            if (customSize > 0f) {
                focusSize = Math.min(customSize, if (singleRow) rowHeight else rowHeight * 0.95f)
            }

            if (index < 0) {
                if (showControls) {
                    drawControls(canvas, width, height, appear)
                }
                /*
                 * 预览且一句歌词都没有（没放歌 / 纯音乐 / 还没解析出来）：
                 * 画一行占位。这时候什么都不画的话，用户面对一片空白只会以为开关坏了 ——
                 * 他要调的本来就是位置、大小、避开区域，这些靠占位一样看得出来。
                 */
                if (previewMode()) {
                    drawRow(canvas, PREVIEW_SAMPLE_TEXT, width, focusY, focusSize,
                            primaryColor, appear * 0.85f, -1f, null, 0L, false, true)
                }
                return
            }
            val previous = lastIndex
            if (index != lastIndex) {
                lastIndex = index
                transitionStartMs = now
            }

            val transition = clamp01((now - transitionStartMs) / LINE_ENTER_MS.toFloat())
            val enter = easeOutCubic(transition)
            // 换行走入的位移：整块内容从下方 0.16 行距处滑到位（和原生壁纸同一个数）。
            val rise = rowHeight * LINE_ENTER_RISE

            val progress = snapshot.progressAt(position)
            val breath = 1f - LINE_BREATH * 0.5f +
                    LINE_BREATH * 0.5f * ((1f + Math.sin((now / 900f).toDouble())).toFloat()) / 2f

            /*
             * 只有**两行**：上格是当前句，下格是它的翻译（没有翻译就放下一句）。
             *
             * 那「上一句往哪儿去了」：它和当前句共用上格 —— 换行那 420ms 里旧句往上滑出去
             * 并淡掉，新句从下方滑进来补上，**同一格里做交叉**。
             * 这样既保住了「唱过去的那句滚出去」这个动作，又不会多出第三行 ——
             * 用户要的是两行，多一行就成了壁纸那层（上下各展开到三行）。
             * 跳转（拖动进度）造成的跨行不走这个交叉：那不是「唱过去」，做了反而是乱跳。
             */
            val rolled = transition < 1f && previous >= 0 && index == previous + 1
            if (rolled) {
                val outAlpha = appear * (1f - enter)
                val outShift = -rise * enter
                drawBlock(canvas, snapshot, previous, width, focusY + outShift,
                        secondY + outShift, focusSize, outAlpha, -1f, 1f, 0L, singleRow)
            }
            val inAlpha = if (rolled) enter else 1f
            val inShift = if (rolled) rise * (1f - enter) else 0f
            drawBlock(canvas, snapshot, index, width, focusY + inShift,
                    secondY + inShift, focusSize, appear * inAlpha, progress,
                    breath, position, singleRow)

            if (showControls) {
                drawControls(canvas, width, height, appear)
            }

            // 还在播、或者动画还没走完，就再要一帧。停了就别空转烧 CPU。
            // 限到 ~30fps：这是叠在所有窗口之上的一层，每帧都要系统重新合成一次，
            // 两行字的扫光在 30fps 下看不出差别，但功耗是一半。
            if (snapshot.playing || transition < 1f || appear < 1f) {
                val since = now - lastFrameAtMs
                if (since >= FRAME_INTERVAL_MS) {
                    lastFrameAtMs = now
                    postInvalidateOnAnimation()
                } else if (!framePending) {
                    framePending = true
                    handler.postDelayed(frameTask, FRAME_INTERVAL_MS - since)
                }
            }
        }

        internal val frameTask: Runnable = object : Runnable {
            override fun run() {
                framePending = false
                val v = view
                if (v != null) v.invalidate()
            }
        }

        /**
         * 画「一格两行」：上格是焦点句，下格是它的翻译或下一句。
         *
         * @param progress 小于 0 表示不扫光（退场中的那一格）。
         * @param breath   焦点行的呼吸系数，1 = 不呼吸。
         */
        private fun drawBlock(canvas: Canvas, snapshot: WallpaperLyricsState.Snapshot, index: Int,
                              width: Int, focusY: Float, secondY: Float, focusSize: Float,
                              alpha: Float, progress: Float, breath: Float, position: Long,
                              singleRow: Boolean) {
            if (index < 0 || index >= snapshot.lines.size || alpha <= 0.004f) return

            // 焦点行：逐字（逐词）扫光 + 呼吸。
            // 只有焦点行推进滚动状态：退场那格（progress < 0）跟着动的话，
            // 两格会各自去更新同一个 scrollOffsetPx，滚出来就是互相打架。
            drawRow(canvas, snapshot.lines[index].text, width, focusY, focusSize,
                    primaryColor, alpha * breath,
                    progress, snapshot.lines[index], position, progress >= 0f, true)

            // 叠加模式下没有第二格：那一条只有状态栏那么高，见 onDraw 里的说明。
            if (singleRow) return

            // 第二行：有翻译且开了就显示翻译，否则显示下一句。
            val translation = if (snapshot.showTranslation) snapshot.lines[index].translation else null
            if (translation != null && !translation.trim().isEmpty()) {
                drawRow(canvas, translation, width, secondY,
                        focusSize * TRANSLATION_FONT_RATIO, secondaryColor,
                        alpha * 0.86f, -1f, null, 0L, false, false)
            } else if (index + 1 < snapshot.lines.size) {
                drawRow(canvas, snapshot.lines[index + 1].text, width, secondY,
                        focusSize * NEXT_FONT_RATIO, secondaryColor,
                        alpha * 0.62f, -1f, null, 0L, false, false)
            }
        }

        private fun drawBackground(canvas: Canvas, width: Int, height: Int, appear: Float) {
            /*
             * 贴在安全区上时不画圆角。
             *
             * 圆角的意义是「一块离屏漂浮的卡片」；而这一格的上下边缘本来就是贴着屏幕顶边
             * （挖孔那一条）的，四角各挖掉一块之后，左上角 / 右上角就变成「背景缺了一角」
             * —— 字还在、底色没了，看着就像显示不全。贴边和圆角是互相冲突的两件事，
             * 所以这个模式一律走直角。
             */
            val overSafeArea = overSafeArea()
            val radius = if (overSafeArea) 0f else dp(14f)
            frame.set(0f, 0f, width.toFloat(), height.toFloat())
            /*
             * 底色浓度是设置里那根「简易 · 背景不透明度」滑条（wp.floatingBackgroundOpacity）。
             *
             * 每帧现读而不是缓存：tuning 是应用随时推下来的，而这一层的 Snapshot.stamp
             * 只在换了歌 / 换了外观时才变 —— 缓存住的话，用户拖动滑条要等下一首歌才看到效果。
             * 一次 HashMap.get 而已，30fps 下可以忽略。
             */
            val opacity = tuningFloat("wp.floatingBackgroundOpacity", DEFAULT_BACKGROUND_OPACITY, 0f, 1f)

            /*
             * 叠在安全区上时不画描边。
             *
             * 那条边的本意是「底色调淡之后还能看见窗口在哪」，但贴到状态栏那一条上时
             * 它变成了一根横贯屏幕的细线，跟系统状态栏本身抢视觉 —— 用户要的就是
             * **只有字浮在那儿**。非安全区模式下照旧画（那里还要靠它兜住窗口轮廓）。
             */
            /*
             * 底之外的**边框一律不画**。
             *
             * 原先那条描边的本意是「底色调淡之后还能看见窗口在哪」，但用户要的是小窗
             * 只剩字和底下那条横杠 —— 一圈边正好是最抢眼的那一笔，留着就不像「浮在
             * 别人家界面上的一行字」了。
             */
            if (opacity > 0f) {
                backgroundPaint.style = Paint.Style.FILL
                backgroundPaint.color = withAlpha(baseColor, opacity * appear)
                canvas.drawRoundRect(frame, radius, radius, backgroundPaint)
            }
        }

        /**
         * 按当前 tuning 重算避开区域。
         *
         * 宽度是**整条宽的比例**、位置是「区域在剩下空间里的左右比例」——
         * 位置乘的是 `width - zoneW` 而不是 `width`，这样拖到最右时区域右边缘正好贴边，
         * 不会有一半被推出屏幕外。
         */
        private fun updateAvoidZone(width: Int) {
            if (!fillSafeArea()) {
                avoidActive = false
                return
            }
            val ratio = tuningFloat(KEY_AVOID_WIDTH, 0f, 0f, 1f)
            if (ratio <= 0f) {
                avoidActive = false
                return
            }
            // 留一成：整个屏宽都划成避开区的话就一行字都画不出来了。
            val zoneW = Math.min(ratio * width, width * 0.9f)
            val pos = tuningFloat(KEY_AVOID_OFFSET_X, 0.5f, 0f, 1f)
            avoidLeftPx = clamp(pos * (width - zoneW), 0f, Math.max(0f, width - zoneW))
            avoidRightPx = avoidLeftPx + zoneW
            avoidActive = zoneW > 0f
        }

        /**
         * 画一行。
         *
         * 扫光是**先画整行的主色、再把唱过的那一段用高亮色重画一遍并裁掉剩下的** ——
         * 原生壁纸那份也是这个做法（drawPerChar 是逐字的变体），两个图层错位就会出重影。
         *
         * @param progress 小于 0 表示这一行不扫光（下一句 / 翻译 / 上一句）。
         */
        private fun drawRow(canvas: Canvas, text: String?, width: Int, centerY: Float, fontSize: Float,
                            color: Int, alpha: Float, progress: Float,
                            line: WallpaperLyricsState.TimedLine?, positionMs: Long,
                            allowScroll: Boolean, withCaret: Boolean) {
            if (text == null || text.isEmpty() || alpha <= 0.004f) return
            var fontSize = fontSize

            textPaint.color = color
            textPaint.textSize = fontSize
            textPaint.textAlign = Paint.Align.LEFT

            val padX = dp(14f)
            /*
             * 避开区域那一段是**从布局里抽掉**的（字绕过去，不是被裁掉），
             * 所以它占的宽度要从可用宽度里减掉 —— 不然「能不能装下 / 要不要滚」
             * 都是按没洞的宽度算的，右半截会推出屏幕外。
             */
            val holeW = if (avoidActive) (avoidRightPx - avoidLeftPx) else 0f
            val maxWidth = width - padX * 2f - holeW
            var measured = textPaint.measureText(text)
            if (measured > maxWidth && measured > 0f) {
                /*
                 * 太长的句子先缩字号，但**不缩到看不清**（下限 MIN_TEXT_SHRINK）。
                 * 一直缩到能塞下为止的话，长句会被压成一团蚂蚁，远不如让它横向滚。
                 * 缩到底还是超出，就交给下面的滚动跟随。
                 */
                fontSize = Math.max(fontSize * MIN_TEXT_SHRINK, fontSize * (maxWidth / measured))
                textPaint.textSize = fontSize
                measured = textPaint.measureText(text)
            }

            val words: Array<WallpaperLyricsState.TimedWord>? = if (line == null) null else line.words
            val segments: Array<FloatingWordColors.Segment>? =
                    if (words != null && words.isNotEmpty() && line != null) segmentsFor(line) else null

            /*
             * 横向滚动跟随：句子比可视区宽时，跟着唱到的位置往左推。
             *
             * 「提前一点」是关键（SCROLL_LEAD）：目标是把**正在唱的那个字**顶到可视区
             * 靠前 35% 的位置，而不是等它撞到右边界才动 —— 后者看起来就是字先跑出去
             * 半截、然后整行猛地一跳。
             */
            /*
             * ⭐只有**焦点行**（allowScroll）读写 `scrollOffsetPx`。
             *
             * `scrollOffsetPx` 是整层共享的一份状态，而 drawRow 一帧要跑好几趟（焦点行、
             * 翻译行、下一句）。翻译行比可视区窄，它要是也去「重置」这个状态，焦点行这一帧
             * 刚推进的一小步当场被抹回 0 —— 长句于是永远滚不到底，看着就是
             * 「跟到键帽那儿就不动了，后面的字还在屏幕外面」（横屏时窗口窄、句子长，最明显）。
             */
            var scroll = 0f
            if (allowScroll) {
                val limit = Math.max(0f, measured - maxWidth)
                var target = 0f
                if (limit > 0f && segments != null && words != null) {
                    var sungX = measured
                    for (i in words.indices) {
                        val word = words[i]
                        if (word == null) continue
                        val segment = segments[i]
                        if (segment == null || segment.endOffset <= segment.startOffset) continue
                        val ratio = sungRatio(word, positionMs)
                        if (ratio >= 1f) continue
                        val head = textPaint.measureText(text, 0, segment.startOffset)
                        val span = textPaint.measureText(text, segment.startOffset, segment.endOffset)
                        sungX = head + span * ratio
                        break
                    }
                    target = clamp(sungX - maxWidth * SCROLL_LEAD, 0f, limit)
                } else if (limit > 0f) {
                    /*
                     * 整行只给一个时间窗的 lrc 没有逐词轴可跟 —— 以前这一档**根本不滚**，
                     * 于是长句后面那一半永远在屏幕外。按整句进度线性推就行。
                     */
                    target = clamp(measured * clamp01(progress) - maxWidth * SCROLL_LEAD, 0f, limit)
                }
                // 每帧朝目标靠近一点，别瞬移；差得太远（换句 / 拖进度跳走）就直接落位。
                scroll = if (Math.abs(target - scrollOffsetPx) > maxWidth) target
                else scrollOffsetPx + (target - scrollOffsetPx) * SCROLL_EASE
                scrollOffsetPx = scroll
            }

            /*
             * 居中要按**看得见的那一整段**算：洞只是把布局撑宽了 holeW，
             * 屏上占的地方是 measured + holeW。
             */
            val visible = measured + holeW
            var x = if (measured <= maxWidth)
                Math.max(padX, (width - visible) / 2f)
            else
                padX - scroll
            /*
             * 洞的左边缘要落在**字符边界**上。
             *
             * 不挪的话跨在边界上的那个字会被劈成两半（左半在洞左边、右半在洞右边）。
             * 要的是「洞夹在字与字之间」，不是一个字被切开。
             * 挪的是整行、最多半个字宽，洞本身的宽度一点不变（右段照旧整体右移 holeW）。
             */
            if (avoidActive) {
                x = snapToCharBoundary(text, x, measured)
            }
            val metrics = textPaint.fontMetrics
            val baseline = centerY - (metrics.ascent + metrics.descent) / 2f

            val textAlpha = Math.round(clamp01(alpha) * 255f)
            val clipTop = centerY - fontSize * 1.2f
            val clipBottom = centerY + fontSize * 1.2f

            if (!avoidActive) {
                paintRow(canvas, text, x, baseline, fontSize, color, alpha, progress, line,
                        positionMs, measured, textAlpha, words, segments, clipTop, clipBottom)
                /*
                 * › 与光标**只画一次**，而且要放在裁剪分支之外：跟着 paintRow 走的话，
                 * 有避开区域时那两遍会用两个不同的起点各画一次 —— 一个 › 被劈成两半、光标重影。
                 */
                if (withCaret) {
                    drawPromptCaret(canvas, text, x, baseline, fontSize, alpha, progress,
                            words, segments, positionMs, measured)
                }
                return
            }

            /*
             * 有避开区域：**同一行画两遍，各自裁一半**。
             *
             * 左段原地；右段整体右移一个区域宽（x + holeW），于是「本来该落进洞里的那些字」
             * 正好从洞的右边缘接着出现 —— 接缝处那一个字左半在洞左边、右半在洞右边，
             * 看着就是字从洞两边绕过去（歌词…歌词 ▌洞▌ 歌词…歌词），一个字都没少。
             *
             * 直接在洞的位置挖一刀不画是错的：那样跨在边界上的字会被削掉半边，
             * 而且每边各削一个，比洞本身还宽。
             */
            canvas.save()
            canvas.clipRect(0f, clipTop, avoidLeftPx, clipBottom)
            paintRow(canvas, text, x, baseline, fontSize, color, alpha, progress, line,
                    positionMs, measured, textAlpha, words, segments, clipTop, clipBottom)
            canvas.restore()

            canvas.save()
            canvas.clipRect(avoidRightPx, clipTop, width.toFloat(), clipBottom)
            paintRow(canvas, text, x + holeW, baseline, fontSize, color, alpha, progress, line,
                    positionMs, measured, textAlpha, words, segments, clipTop, clipBottom)
            canvas.restore()
        }

        /**
         * 字后那根光标。
         *
         * 悬浮窗上要的就是它一个 —— ⏎ 键帽、`›` 提示符、四角刻线、token id 都撤掉了
         * （用户原话：只要有字和底下那个横杠，光标留着）。
         */
        private fun drawPromptCaret(canvas: Canvas, text: String, x: Float, baseline: Float,
                                    fontSize: Float, alpha: Float, progress: Float,
                                    words: Array<WallpaperLyricsState.TimedWord>?,
                                    segments: Array<FloatingWordColors.Segment>?, positionMs: Long,
                                    measured: Float) {
            // 字的竖中线（baseline 在字的下沿附近，往上提约三分之一字号）。
            val mid = baseline - fontSize * 0.35f
            val alpha255 = Math.round(clamp01(alpha) * 255f)
            if (alpha255 <= 0) return

            /*
             * 光标：跟在唱到的位置后面。
             *
             * 只在**正在唱**的这一行画（progress < 0 是下一句 / 翻译 / 退场中的那一格）——
             * 那几行没有「唱到哪儿」这回事，画上去就是一个卡在行首不动的竖线。
             */
            if (progress < 0f) return
            val sungX = clamp(sungOffsetX(text, measured, progress, words, segments, positionMs),
                    0f, measured)
            val caretH = fontSize * 0.78f
            val caretW = Math.max(1.5f, fontSize * 0.045f)
            val caretX = x + sungX + fontSize * 0.06f
            // 光标只是一道实心竖线，和逐词下划线共用那支笔就够了（每次都重设颜色）。
            underlinePaint.style = Paint.Style.FILL
            underlinePaint.color = withAlpha(accentColor, alpha255 / 255f * 0.9f)
            canvas.drawRect(caretX, mid - caretH * 0.5f, caretX + caretW, mid + caretH * 0.5f, underlinePaint)
        }

        /**
         * 把整行的起点挪一挪，让避开区域的左边缘正好压在某个字符的边界上。
         *
         * 挨个试每个字符边界、挑离当前位置最近的那个：位移因此最多半个字宽，
         * 看不出来是「挪过」，但字绝不会被切开。
         *
         * 洞没压在这行字上（在字的左边或右边）时不用挪 —— 那本来就没有字会被切。
         */
        private fun snapToCharBoundary(text: String, x: Float, measured: Float): Float {
            if (avoidLeftPx <= x || avoidLeftPx >= x + measured) return x
            var best = x
            var bestDelta = Float.MAX_VALUE
            for (i in 0..text.length) {
                val candidate = avoidLeftPx - textPaint.measureText(text, 0, i)
                val delta = Math.abs(candidate - x)
                if (delta < bestDelta) {
                    bestDelta = delta
                    best = candidate
                }
            }
            return best
        }

        /**
         * 把一行真正画上去（主色一遍 + 唱过的那一段再来一遍）。
         *
         * 抽成一个方法是因为有避开区域时要**画两遍**（见调用处），
         * 两遍之间只差起点 x。
         */
        private fun paintRow(canvas: Canvas, text: String, x: Float, baseline: Float, fontSize: Float,
                             color: Int, alpha: Float, progress: Float,
                             line: WallpaperLyricsState.TimedLine?, positionMs: Long,
                             measured: Float, textAlpha: Int,
                             words: Array<WallpaperLyricsState.TimedWord>?,
                             segments: Array<FloatingWordColors.Segment>?,
                             clipTop: Float, clipBottom: Float) {
            /*
             * 没有推进量的那几行（下一句 / 翻译 / 退场中的那一格）：整行照原样画一遍主色。
             *
             * 它们没有「唱到哪儿」这回事，走下面那条逐词路径会一个字都画不出来。
             */
            if (progress < 0f || line == null) {
                textPaint.color = color
                textPaint.alpha = textAlpha
                canvas.drawText(text, x, baseline, textPaint)
                return
            }

            /*
             * 这一句**一个时间戳都没有**（整句 LRC，或这一行根本没解析出逐词轴）：
             * 没有逐词轴就没有「唱到哪个词」这回事 —— 走下面的逐词路径时 sungX 恒等于
             * 第一个词的词头，`appear` 恒为 0，于是**整行从头到尾一个字都不画**。
             *
             * 这正是「安全区模式下没有出现动画、连字都没有」的根因：那一档只有一行、
             * 又是贴在最顶上的一条，用户第一眼看到的就是一片空白。
             *
             * 这一档退回「按整句进度铺开」：字先以最低透明度出现（至少看得见这一句
             * 是什么），再随着 progress 由暗到亮 —— 仍然有「出现」这个动作，
             * 只是粒度从词变成整句。真·逐词的机器照旧走下面那条路。
             */
            val hasWordAxis = words != null && words.isNotEmpty()
            if (!hasWordAxis) {
                textPaint.color = color
                textPaint.alpha = Math.round(textAlpha * 0.32f)
                canvas.drawText(text, x, baseline, textPaint)
                // 已经唱过的那一段用高亮色压上去：整句一行也就有了一道从左往右的扫光。
                val sung = measured * clamp01(progress)
                if (sung > 0f) {
                    canvas.save()
                    canvas.clipRect(x, clipTop, x + sung, clipBottom)
                    textPaint.color = accentColor
                    textPaint.alpha = textAlpha
                    canvas.drawText(text, x, baseline, textPaint)
                    canvas.restore()
                }
                drawUnderlines(canvas, text, x, baseline, fontSize, wordBounds(text),
                        measured * clamp01(progress), alpha)
                return
            }

            /*
             * ⭐**不再先画整行主色**：要的是「和播放页一样逐个出现」—— 唱到哪个词，
             * 哪个词才淡入；没唱到的部分不画（它的位置由底下那条下划线底与方括号标着）。
             * 先铺一遍整行的话，字从头到尾都在那儿，看着就没有「出现」这个动作。
             */
            /*
             * 逐词下划线：**每一句都在字底下画一排小线，一个词一条**。
             *
             * 「分词」在小窗上唯一看得出痕迹的地方就是这条线，所以这条线的**词从哪里来**
             * 必须和下面「字怎么亮」用同一套 —— 以前线按词典切、字按 line.words 切，
             * 中文的 words 又常常是逐字的，于是整排线看着就是「一个字一条、还叠在一起」。
             */
            val bounds = wordBounds(text)
            val sungX = sungOffsetX(text, measured, progress, words, segments, positionMs)
            drawUnderlines(canvas, text, x, baseline, fontSize, bounds, sungX, alpha)

            /*
             * **逐个词画**：唱到一个词，它才淡入并从下方顶上来一点（和播放页同一套动作）。
             *
             * 词取自词典 / ICU（见 FloatingVocab），**不看 line.words**：中文的 words 多数
             * 是逐字的，照它切就是用户说的「一个字一个字出现」。现在一个词是一整块，
             * 到下个词才换 —— 下划线与字的推进量都是上面那个 sungX，两边因而永远对齐。
             *
             * 每个词画的都是**整行**再裁到它在整行里的那一小段 —— 两者必须对齐到同一个
             * 坐标系（起点都是 x）。写成 drawText(text, wordX, …) 的话整行被整体平移了，
             * 裁出来的就永远是「整行的开头」，也就是第一个字 —— 表现是每个词都把第一个
             * 字重画一遍、往后推。
             */
            for (i in bounds.indices) {
                val segment = bounds[i]
                val start = Math.min(segment.start, text.length)
                val end = Math.min(segment.end, text.length)
                if (end <= start) continue
                if (isBlank(text[start])) continue
                val head = textPaint.measureText(text, 0, start)
                val width = textPaint.measureText(text, start, end)
                if (width <= 0f) continue
                /*
                 * 「出现」这一下用**走过的距离**而不是时间：这层只有整行的推进量，
                 * 没有每个字的时刻（有逐词时间戳时 sungX 也是按词算出来的）。
                 * 唱到词头之后再走半个词的宽度，这个词才完全落定。
                 */
                val appear = clamp01((sungX - head) / Math.max(1f, width * 0.5f))
                if (appear <= 0f) continue
                val rise = (1f - appear) * fontSize * 0.14f
                val wordColor = colorAtChar((start + end) / 2, segments)
                canvas.save()
                canvas.clipRect(x + head, clipTop, x + head + width, clipBottom)
                textPaint.color = if (wordColor == FloatingWordColors.NO_COLOR) accentColor else wordColor
                textPaint.alpha = Math.round(textAlpha * appear)
                canvas.drawText(text, x, baseline + rise, textPaint)
                canvas.restore()
            }
        }

        /**
         * 唱到哪儿了（沿 x 轴，单位与 measured 相同）。
         *
         * 有逐词时间戳就按词算（唱到一半的那个词按比例），没有就按整句进度线性推进。
         * 下划线与字的高亮都拿它当唯一的推进量，两边才不会一个跑在前面一个落在后面。
         */
        private fun sungOffsetX(text: String, measured: Float, progress: Float,
                                words: Array<WallpaperLyricsState.TimedWord>?,
                                segments: Array<FloatingWordColors.Segment>?, positionMs: Long): Float {
            if (segments != null && words != null) {
                for (i in words.indices) {
                    val word = words[i]
                    if (word == null) continue
                    val segment = segments[i]
                    if (segment == null || segment.endOffset <= segment.startOffset) continue
                    val start = Math.min(segment.startOffset, text.length)
                    val end = Math.min(segment.endOffset, text.length)
                    if (end <= start) continue
                    val ratio = sungRatio(word, positionMs)
                    if (ratio >= 1f) continue
                    val head = textPaint.measureText(text, 0, start)
                    val span = textPaint.measureText(text, start, end)
                    return head + span * clamp01(ratio)
                }
                return measured
            }
            return measured * clamp01(progress)
        }

        /** AI 给这个字符位置标了什么颜色（没标就是 NO_COLOR，调用方退默认高亮色）。 */
        private fun colorAtChar(offset: Int, segments: Array<FloatingWordColors.Segment>?): Int {
            if (segments == null) return FloatingWordColors.NO_COLOR
            for (i in segments.indices) {
                val segment = segments[i]
                if (segment == null || segment.color == FloatingWordColors.NO_COLOR) continue
                if (offset >= segment.startOffset && offset < segment.endOffset) return segment.color
            }
            return FloatingWordColors.NO_COLOR
        }

        /**
         * 逐词下划线：一条底线 + 唱到的那一段填色。
         *
         * 线的位置与宽度和上面「逐词上色」用的是**同一套区间**，所以字和线是对齐的；
         * 空格 / 标点那种段不画线（它们只是切分出来的边界，画了就成一排碎线）。
         */
        private fun drawUnderlines(canvas: Canvas, text: String, x: Float, baseline: Float,
                                   fontSize: Float, bounds: List<FloatingVocab.Segment>,
                                   sungX: Float, alpha: Float) {
            val lineY = baseline + fontSize * 0.30f
            // 参考画面里这条线是**有点厚度的小横杠**，不是一根发丝：太细了在小窗上根本看不见。
            val hair = Math.max(2f, fontSize * 0.07f)
            /*
             * 词与词之间要留一道缝。
             *
             * 不留的话相邻两条线的端点就接上了，整排线连成一根通长的横杠 —— 看上去
             * 「全部叠在一起」，分词白切了。参考画面里也是一个词一小段、彼此断开的。
             */
            val gap = Math.max(dp(1f), fontSize * 0.08f)
            val alpha255 = Math.round(clamp01(alpha) * 255f)
            if (alpha255 <= 0) return

            for (i in bounds.indices) {
                val segment = bounds[i]
                val start = Math.min(segment.start, text.length)
                val end = Math.min(segment.end, text.length)
                if (end <= start) continue
                // 空白 / 标点段不画线：它们只是切出来的边界，画了就是一排碎线。
                if (isBlank(text[start])) continue
                val head = textPaint.measureText(text, 0, start)
                val span = textPaint.measureText(text, start, end)
                if (span <= 0f) continue
                val inset = Math.min(gap, span * 0.2f)
                val left = x + head + inset
                val width = span - inset * 2f
                if (width <= 0f) continue
                // 一律夹在 [0, width] 内 —— 越界的负数宽度会让 drawRect 画出一根反向的线。
                drawUnderline(canvas, left, lineY, width, clamp(sungX - head - inset, 0f, width),
                        hair, alpha255)
            }
        }

        private fun drawUnderline(canvas: Canvas, left: Float, y: Float, width: Float,
                                  filled: Float, hair: Float, alpha255: Int) {
            underlinePaint.style = Paint.Style.FILL
            underlinePaint.color = withAlpha(primaryColor, alpha255 / 255f * 0.22f)
            canvas.drawRect(left, y, left + width, y + hair, underlinePaint)
            if (filled <= 0.5f) return
            underlinePaint.color = withAlpha(accentColor, alpha255 / 255f * 0.95f)
            canvas.drawRect(left, y, left + filled, y + hair, underlinePaint)
        }

        private fun isBlank(c: Char): Boolean {
            return c == ' ' || c == '\t' || c == '　'
        }

        /** 整行的词区间（缓存：换行的 420ms 里同一行会被画几十帧）。 */
        private fun wordBounds(text: String): List<FloatingVocab.Segment> {
            val cached = cachedUnderlineBounds
            if (cachedUnderlineText === text && cached != null) {
                return cached
            }
            cachedUnderlineText = text
            val result = FloatingVocab.split(text)
            cachedUnderlineBounds = result
            return result
        }

        /**
         * 这一行的片段表（每个词落在整行哪儿、被标了什么颜色）。
         *
         * 只认「同一行 + 同一套规则」：两者都是引用比较，`TimedLine` 没有重写 equals，
         * 而 `wordRules` 只在换主题时才换对象 —— 于是换行的 420ms 里几十帧只算一次。
         */
        private fun segmentsFor(line: WallpaperLyricsState.TimedLine): Array<FloatingWordColors.Segment> {
            if (cachedSegmentLine === line && cachedSegmentRules === wordRules
                    && cachedSegments != null) {
                return cachedSegments!!
            }
            cachedSegmentLine = line
            cachedSegmentRules = wordRules
            val result = FloatingWordColors.segments(line.text, line.words, wordRules)
            cachedSegments = result
            return result
        }

        /** 一个词唱过了多少（0..1）。整行没有逐词轴时不走这里。 */
        private fun sungRatio(word: WallpaperLyricsState.TimedWord, positionMs: Long): Float {
            if (positionMs >= word.endMs) return 1f
            if (positionMs <= word.startMs) return 0f
            val span = word.endMs - word.startMs
            if (span <= 0L) return 1f
            return clamp01((positionMs - word.startMs) / span.toFloat())
        }

        /** 右上角那颗锁（常驻，锁了也能解锁）与右下角的拉伸把手（锁了就不画）。 */
        /**
         * 右边那颗 ⏎ 键帽：**这一层的「输入框」身份**全在它身上。
         *
         * 参考画面里歌词条右侧就是一个方框 + 一个回车箭头（和播放器里那块提示词窗同一套语言）。
         * 它不属于控件（不需要触摸、也不跟锁/把手一起收），所以单独画、常驻。
         * 叠加安全区那一模式不画：窗口只有状态栏那么高，塞进去就把字挤没了。
         */
        private fun drawControls(canvas: Canvas, width: Int, height: Int, appear: Float) {
            controlPaint.style = Paint.Style.FILL
            controlPaint.strokeWidth = Math.max(1.5f, dp(1.5f))

            // 锁：右上角一个圆点 + 锁体。锁着时画闭合的锁梁，解锁时画张开的。
            val cx = width - dp(13f)
            val cy = dp(13f)
            val r = dp(9f)
            // 锁着的时候这颗锁是**唯一**还能点的地方（整层都穿透了），
            // 所以画得实一点 —— 否则用户只看到一块半透明歌词，根本不知道该点哪儿解锁。
            val lockAlpha = if (isLocked()) 0.92f else 0.72f
            controlPaint.color = withAlpha(baseColor, lockAlpha * appear)
            canvas.drawCircle(cx, cy, r, controlPaint)
            controlPaint.style = Paint.Style.STROKE
            controlPaint.color = withAlpha(primaryColor, lockAlpha * appear)
            // 锁体
            val bodyW = dp(7f)
            val bodyH = dp(5.5f)
            canvas.drawRect(cx - bodyW / 2f, cy - dp(0.5f), cx + bodyW / 2f, cy - dp(0.5f) + bodyH, controlPaint)
            // 锁梁：锁着时是完整半圆，解锁时往右上翻开一个口子。
            val shackleTop = cy - dp(3.4f)
            val shackle = android.graphics.RectF(
                    cx - bodyW / 2f + dp(1f), shackleTop - bodyH * 0.7f,
                    cx + bodyW / 2f - dp(1f), shackleTop + bodyH * 0.5f)
            if (isLocked()) {
                canvas.drawArc(shackle, 180f, 180f, false, controlPaint)
            } else {
                canvas.drawArc(shackle, 200f, 140f, false, controlPaint)
            }

            if (isLocked()) return

            // 拉伸把手：右下角两道斜线。
            controlPaint.style = Paint.Style.STROKE
            controlPaint.color = withAlpha(primaryColor, 0.42f * appear)
            val gx = width - dp(6f)
            val gy = height - dp(6f)
            canvas.drawLine(gx - dp(10f), gy, gx, gy - dp(10f), controlPaint)
            canvas.drawLine(gx - dp(5f), gy, gx, gy - dp(5f), controlPaint)
        }

        private fun withAlpha(color: Int, alpha: Float): Int {
            val a = Math.round(clamp01(alpha) * 255f)
            return Color.argb(a, Color.red(color), Color.green(color), Color.blue(color))
        }

        // ---- 触摸：点 / 拖 / 改大小 / 锁 ----

        override fun onTouchEvent(event: MotionEvent?): Boolean {
            if (event == null) return false
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    startRawX = event.rawX
                    startRawY = event.rawY
                    downAtMs = android.os.SystemClock.elapsedRealtime()
                    moved = false
                    /*
                     * 先判命中、再唤醒控件。
                     *
                     * 顺序不能反：控件收起时那一小块不该能点中（否则就是「看不见却上了锁」），
                     * 所以这一按按「按下去之前」的状态算 —— 收着的时候第一下只负责把控件叫出来。
                     */
                    touchMode = hitTest(event.x, event.y)
                    // 指头一落到窗上就算「焦点在小窗」：锁和把手立刻画出来（见 controlsAwake）。
                    wakeControls()
                    invalidate()
                    val p = params
                    if (p != null) {
                        startWinX = p.x
                        startWinY = p.y
                        startWidth = p.width
                        startHeight = p.height
                    }
                    return true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - startRawX
                    val dy = event.rawY - startRawY
                    if (!moved && Math.abs(dx) + Math.abs(dy) > dp(4f)) {
                        moved = true
                        wakeControls()
                    }
                    if (!moved) return true
                    if (touchMode == MODE_RESIZE) {
                        resizeBy(dx, dy)
                    } else if (touchMode == MODE_MOVE && !isLocked()) {
                        moveBy(dx, dy)
                    }
                    return true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    val isUp = event.actionMasked == MotionEvent.ACTION_UP
                    if (isUp && !moved && touchMode == MODE_LOCK) {
                        setLocked(!isLocked())
                    } else if (moved && (touchMode == MODE_MOVE || touchMode == MODE_RESIZE)) {
                        /*
                         * 叠加模式下**不落盘**四个数。
                         *
                         * 这里是最容易漏的一个入口（reclampIfNeeded 那条已经挡过了）：
                         * 拖动走的是 MODE_MOVE，抬手就落到这一支 —— 于是安全区那套
                         * 「高度 = 状态栏、宽度 = 滑条比例」被当成用户拖出来的尺寸
                         * 写进 KEY_X/Y/W/H。等把开关拨回普通模式，buildParams() 读到的
                         * 就是一条又宽又扁的窗口，把手和锁上下压在一起。
                         * 左右位置那边有自己单独的 KEY_DRAG_RATIO（moveBy 里已经记了），
                         * 这一支在叠加模式下什么都不用存。
                         */
                        if (!overSafeArea()) persistLayout()
                    }
                    /*
                     * 点一下**不再跳回主页面**。
                     *
                     * 原来这里有个 openApp()：这一层是叠在所有窗口之上的「桌面歌词」，
                     * 点它一下就把应用拽到前台，等于每次想拖它、想调它，手指一碰就整屏切走 ——
                     * 尤其叠加在安全区上时，那一条就压在别的应用顶上，误触更是直接打断人家。
                     * 现在单击什么都不做：要动它靠拖（MODE_MOVE），要上锁点右上角那颗锁。
                     */
                    // 手抬起来之后过一会儿把控件收回去（触摸焦点已经不在这块窗上了）。
                    scheduleControlsHide()
                    touchMode = MODE_NONE
                    return true
                }
                else -> return false
            }
        }

        /**
         * 控件是不是「醒着」：**只看最近有没有被碰过**。
         *
         * 锁着的时候原本是一律算醒着的（那颗锁是整层穿透之后唯一能点的地方），
         * 但用户要的是「没焦点就把锁也藏起来」—— 于是锁着也一样会收：
         * 2.2 秒没动静，主窗上那颗锁就不画了。
         *
         * 解锁的路没断：右上角那块（LockChipView）仍然挂着、仍然接触摸，
         * 第一下把控件叫出来（锁重新画出来），第二下才真解锁 —— 见 LockChipView。
         *
         * 画与命中都用这一个判断 —— 画出来的东西和能点的地方必须一致，
         * 否则就是「看不见却能点中」，这类控件最不能破的规矩。
         */
        internal fun controlsAwake(now: Long): Boolean {
            return now - controlsTouchedAtMs < CONTROLS_IDLE_MS
        }

        internal fun wakeControls() {
            controlsTouchedAtMs = android.os.SystemClock.elapsedRealtime()
            removeCallbacks(controlsHideTask)
            // 唤醒之后要重新排队收起，并立刻重画一帧把控件画出来。
            scheduleControlsHide()
            invalidate()
        }

        private fun scheduleControlsHide() {
            removeCallbacks(controlsHideTask)
            postDelayed(controlsHideTask, CONTROLS_IDLE_MS + 80L)
        }

        /** 空闲到点：重画一帧，让 onDraw 里的 controlsAwake 把控件收掉。 */
        private val controlsHideTask: Runnable = Runnable {
            invalidate()
        }

        private fun hitTest(x: Float, y: Float): Int {
            val width = getWidth()
            val height = getHeight()
            /*
             * 叠加安全区这个模式下，锁的命中区必须**收成画出来的那个圆**。
             *
             * 窗口只有状态栏那么高（二十几 dp），而锁的命中区是个 26dp 的方框 ——
             * 它把整个右端全吃掉了。用户想拖小窗，手指多半就落在右端那一块
             * （小窗本来就贴着顶、占掉大半屏宽），于是「拖一下」变成了「点了一下锁」：
             * setLocked(true) 随即将整层设成 FLAG_NOT_TOUCHABLE —— 从此彻底拖不动，
             * 而那颗锁画在一条这么窄的条里，用户根本看不出是自己刚把它锁上了
             * （用户原话：安全区开关了 无法拖动）。
             *
             * 这个模式下窗口高度是锁死的，拉伸把手本来就不该存在（原来它是被锁的
             * 命中区顺手挡掉的，属于歪打正着），所以这里直接不给 MODE_RESIZE，
             * 出了锁那一小块之外一律按拖动处理。
             */
            if (overSafeArea()) {
                /*
                 * 这个模式下**没有任何命中区**：控件一个都不画（见 showControls），
                 * 锁也不存在（见 isLocked）。整层一律按拖动处理。
                 *
                 * 曾经这里留了一小块锁的命中区，结果就是「画都不画却能点中」——
                 * 用户在右上角随手一碰就上了锁，整层立刻 FLAG_NOT_TOUCHABLE。
                 * 画出来的东西和能点的地方必须一致，这是这类控件唯一不能破的规矩。
                 */
                return MODE_MOVE
            }
            // 控件收起来了（没人碰、也没锁）：整窗一律按拖动，别让看不见的地方能点中。
            if (!controlsAwake(android.os.SystemClock.elapsedRealtime())) return MODE_MOVE
            // 锁（右上角，命中区比画出来的大一圈：手指没那么准）
            if (x >= width - dp(26f) && y <= dp(26f)) return MODE_LOCK
            // 拉伸（右下角）
            if (!isLocked() && x >= width - dp(26f) && y >= height - dp(26f)) return MODE_RESIZE
            return MODE_MOVE
        }

        private fun moveBy(dx: Float, dy: Float) {
            val p = params ?: return
            val screenW = resources.displayMetrics.widthPixels
            val screenH = resources.displayMetrics.heightPixels
            if (overSafeArea()) {
                // 贴着安全区这个模式只给左右：上下没有意义，y 恒为 0（拖也拖不动）。
                val x = clampInt((startWinX + dx).toInt(), 0, Math.max(0, screenW - p.width))
                applyLayout(x, 0, p.width, p.height)
                persistOffsetRatio(x, screenW)
                return
            }
            val x = clampInt((startWinX + dx).toInt(), 0, Math.max(0, screenW - p.width))
            val y = clampInt((startWinY + dy).toInt(), 0, Math.max(0, screenH - p.height))
            applyLayout(x, y, p.width, p.height)
        }

        /**
         * 叠加模式下拖出来的左右位置要自己记住：不然下一次巡检又按设置值把它拽回去。
         *
         * 占满整条时**不记**：那时 span 是 0，算出来的比例恒为 0 ——
         * 等关掉占满（比如转横屏），那个 0 会被当成「贴左」，歌词就跑到边上去了
         * （用户原话：安全区铺满，横屏歌词不在正中间）。没有可挪的余地时，
         * 「拖过」这件事本身也不成立，删掉比记一个假的 0 诚实。
         */
        private fun persistOffsetRatio(x: Int, screenW: Int) {
            val span = Math.max(0, screenW - (params?.width ?: 0))
            if (span <= 0) {
                prefs.edit().remove(KEY_DRAG_RATIO).apply()
                return
            }
            prefs.edit().putFloat(KEY_DRAG_RATIO, clamp01(x / span.toFloat())).apply()
        }

        private fun resizeBy(dx: Float, dy: Float) {
            val p = params ?: return
            // 叠加模式下窗口高度锁死成状态栏那一条：拉伸会把它变成压住整条系统栏的方块。
            // 命中区那边已经不给 MODE_RESIZE 了，这里是兜住任何绕过去的调用。
            if (overSafeArea()) return
            val density = resources.displayMetrics.density
            val width = clampInt((startWidth + dx).toInt(),
                    Math.round(MIN_WIDTH_DP * density), Math.round(MAX_WIDTH_DP * density))
            val height = clampInt((startHeight + dy).toInt(),
                    Math.round(MIN_HEIGHT_DP * density), Math.round(MAX_HEIGHT_DP * density))
            val screenW = resources.displayMetrics.widthPixels
            val screenH = resources.displayMetrics.heightPixels
            val x = clampInt(p.x, 0, Math.max(0, screenW - width))
            val y = clampInt(p.y, 0, Math.max(0, screenH - height))
            applyLayout(x, y, width, height)
        }

        init {
            appearStartMs = android.os.SystemClock.elapsedRealtime()
            refreshPalette()
            loadedFontKey = null
            syncFont(WallpaperLyricsState.get().font)
        }
    }

    /**
     * 锁定后那颗解锁按钮所在的小窗口。
     *
     * 它**什么都不画**（见 syncLockChip 里为什么），存在的全部意义是在主窗已经
     * `FLAG_NOT_TOUCHABLE` 的情况下，把右上角那一小块接触摸收下来 —— 于是
     * 「锁定 = 整层穿透，只有解锁按钮能点」这两件事能同时成立。
     */
    private inner class LockChipView(ctx: Context) : View(ctx) {

        override fun onDraw(canvas: Canvas) {
            // 故意不画：锁那个图标是主窗画的，再画一遍两个半透明圆会叠深。
            super.onDraw(canvas)
        }

        override fun onTouchEvent(event: MotionEvent?): Boolean {
            if (event == null) return false
            if (event.actionMasked == MotionEvent.ACTION_UP) {
                /*
                 * ⭐**第一下只把控件叫出来，第二下才解锁**。
                 *
                 * 锁着的时候整层是 NOT_TOUCHABLE，只有这个 chip 能收到触摸；而按新的口径
                 * 「锁着且没有焦点」时主窗那颗锁是不画的。直接解锁的话，用户点的是一块自己
                 * 看不见的地方。所以先唤醒（锁重新画出来），看见之后再点一下才是解锁。
                 */
                val v = view
                if (v != null && !v.controlsAwake(android.os.SystemClock.elapsedRealtime())) {
                    v.wakeControls()
                    return true
                }
                // 延后一拍再解锁：解锁要把自己这个窗口摘掉，
                // 在触摸派发的中途 removeView 容易撞上「正在派发的窗口没了」。
                handler.post {
                    setLocked(false)
                }
            }
            return true
        }
    }
}
