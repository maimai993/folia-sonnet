package top.izuna.foliamajor
import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager

/**
 * 音乐锁屏：一个**真正的锁屏页面**，不是悬浮窗。
 *
 * 为什么非得是 Activity：悬浮窗（TYPE_APPLICATION_OVERLAY）能不能画在锁屏之上，
 * 各家 ROM 说了算（MIUI / ColorOS 之类会拦，还有专门的「锁屏显示」开关）。
 * `FLAG_SHOW_WHEN_LOCKED` 从 API 27 起就 deprecated 了，官方给悬浮窗的替代方案
 * 根本不存在 —— 那条路只属于 Activity：manifest 的 `android:showWhenLocked`
 * 加 `Activity.setShowWhenLocked(true)`，是系统正式支持的「画在 keyguard 之上」。
 *
 * 这个 Activity 自己**几乎不画东西**（透明），画面由 `WallpaperOverlay` 那一层来画 ——
 * 它把窗口挂到这个 Activity 的 window token 上（TYPE_APPLICATION_PANEL），
 * 于是**锁屏上看到的就是桌面叠层那一层本身**：同一个 WebView、同一套可视化与歌词，
 * 不存在「复制一份浏览器」的两份状态。
 *
 * ## 为什么它必须吃触摸（这一条改过，别改回去）
 *
 * 最早这层是 `FLAG_NOT_TOUCHABLE` 的，指望手势穿到下面的 keyguard，
 * 这样"照常滑动解锁"。实测行不通：一个 `showWhenLocked` 的全屏 Activity 盖在
 * keyguard 之上时，系统会把 keyguard 判成被遮挡（occluded），
 * 那边的解锁手势根本收不到 —— 用户看到的就是「画面在，但怎么滑都解不开锁」。
 *
 * 既然注定要占住这块输入，就得自己把出口给用户：
 *  · **上滑退出**（和很多锁屏的解锁手势同向，符合直觉）；
 *  · 底部面板上那个 **ˇ** 直接退出（它是面板的一行，见 LockScreenControlPanel）。
 *
 * 另外**点一下空白处**收起 / 放出底部那条 UI：看歌词时想要一整屏，点一下就只剩画面；
 * 再点一下放回来，不会有点进去了出不来的那条路。收起之后上滑退出照旧（整屏都归这一层）。
 * 退掉之后就是原本的锁屏，照常解锁。
 *
 * 生命周期由 `WallpaperOverlay` 的屏幕广播掌管：息屏时起、解锁（USER_PRESENT）或
 * 没在播放时结束。
 */
class LockScreenMusicActivity : Activity() {

    companion object {
        /** 上滑超过这个距离才算"退出"，别把手抖当成指令。 */
        private const val SWIPE_UP_DP = 72f
        /** 横向漂移超过这个比例就不算上滑（那是横扫 / 切歌手势）。 */
        private const val SWIPE_MAX_SIDE_RATIO = 0.6f
        /** 一次「点」允许的最大位移：超过就是滑动（上滑退出、拖进度条那类）。 */
        private const val TAP_MAX_MOVE_DP = 16f
        /** 一次「点」的最长按住时间：超过就是长按，不当成切换 UI。 */
        private const val TAP_MAX_DURATION_MS = 400L
    }

    /** 底部的封面 / 歌名 / 时长 / 切歌面板（另开一个子窗口，见 LockScreenControlPanel）。 */
    private var controlPanel: LockScreenControlPanel? = null
    private val panelHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val panelRefresh: Runnable = object : Runnable {
        override fun run() {
            val panel = controlPanel
            if (panel != null) {
                panel.refresh()
            }
            panelHandler.postDelayed(this, LockScreenControlPanel.REFRESH_INTERVAL_MS)
        }
    }

    private var tracking = false
    /** 这次手势已经触发过退出了：防止一次滑动里反复 dismiss（那正是"抽搐"的形状）。 */
    private var gestureConsumed = false
    private var startX = 0f
    private var startY = 0f

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        /*
         * 解锁之后才起来的，立刻退场。
         *
         * 起这一页是**跨进程**的，而亮屏和解锁（指纹）几乎同时发生 —— 有时宿主报到得
         * 比"该退场了"那条消息还晚，那一笔 finish 就落在"还没登记宿主"的空档里
         * （WallpaperOverlay.finishLockScreenNow 找不到宿主，只能什么都不做）。
         * 于是这一页留在桌面上，而且它**吃触摸** —— 用户报的正是
         * 「指纹解锁进桌面后，有概率直接进那个歌词界面，操作不了手机」。
         * 这里在挂任何窗口之前先自检一次，退掉是零副作用的。
         */
        if (top.izuna.foliamajor.wallpaper.WallpaperOverlay
                .shared(this).lockScreenRecentlyUnlocked()) {
            finish()
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            // API 33 起子窗口不会自动继承：不设这一条，挂在它上面的叠层窗口
            // 反而会跑到 keyguard 后面去（静默，不报错也不显示）。
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                setInheritShowWhenLocked(true)
            }
        }
        /*
         * 注意这里**没有** FLAG_NOT_TOUCHABLE（见类注释）：不自己接住触摸，
         * 用户就既滑不动锁屏、也关不掉这一层 —— 等于被自己的锁屏页关在外面。
         * NOT_FOCUSABLE 保留：这只是展示层，不该抢走输入法 / 按键焦点。
         */
        window.addFlags(
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                        WindowManager.LayoutParams.FLAG_FULLSCREEN)
        setContentView(View(this))
        handWindowTokenToOverlay()
        /*
         * 底部面板**单独**排队，不等叠层交接那一趟。
         *
         * 原来它挂在 handWindowTokenToOverlay 的 post 里，那一趟要先去通知叠层换宿主，
         * 而换宿主会摘窗口 + 重建页面（整整一秒的加载与淡入）；
         * 被排在后面，于是"刚亮屏那一下"既没有面板也没有手势 ——
         * 这正是「必须等它全部出现才退得掉」的一半。
         */
        window.decorView.post { attachControlPanel() }
        panelHandler.postDelayed(panelRefresh, LockScreenControlPanel.REFRESH_INTERVAL_MS)
    }

    /** 底部那条控制条。挂不上（token / ROM 拒绝）也不影响锁屏页本身。 */
    private fun attachControlPanel() {
        if (controlPanel != null) {
            return
        }
        val panel = LockScreenControlPanel(this)
        controlPanel = panel
        /*
         * 面板上那一片没有控件的区域也算"空白"：它自己只负责报告，状态在这一页里翻
         * （两处共用一个开关，不会面板收了、页面还以为开着，于是再点一下放不回来）。
         */
        panel.setBlankTapHandler { toggleChrome() }
        panel.attach()
        /*
         * 叠层每次重挂都会跑到面板上面去（同级子窗口按添加顺序叠），
         * 所以这里登记一个回调：它一挂上，面板就摘了再挂一次回到最上层。
         * 少了这一段，面板会在锁屏期间莫名消失（换宿主 / 自愈重载之后就看不见了）。
         */
        top.izuna.foliamajor.wallpaper.WallpaperOverlay
                .shared(this)
                .setWindowAttachedListener { reorderControlPanel() }
    }

    /** 把面板重新排到叠层之上（detach + attach 是子窗口唯一的重排手段）。 */
    private fun reorderControlPanel() {
        val panel = controlPanel ?: return
        window.decorView.post {
            val current = controlPanel ?: return@post
            current.detach()
            current.attach()
        }
    }

    /**
     * 上滑退出接在**窗口这一层**，而不是内容视图上。
     *
     * 挂在 root View 的 OnTouchListener 上时，只有事件被一路分派到那个 View 才收得到：
     * 页面刚起来那一段（窗口还没完成首帧、叠层还在淡入）事件常常到不了它，
     * 于是「刚亮屏就往上滑」毫无反应，必须等画面完整出现才滑得动。
     * `dispatchTouchEvent` 是窗口收到事件的**第一个**入口，比 View 分发更早、也更全。
     */
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                tracking = true
                gestureConsumed = false
                startX = event.rawX
                startY = event.rawY
            }
            MotionEvent.ACTION_MOVE -> {
                /*
                 * 滑到位就走，**不等抬手**。
                 *
                 * 等 ACTION_UP 的话，手指在半路停一下、或者被锁屏的手势条 /
                 * 系统把事件收走（ACTION_CANCEL）就永远等不到那一击，退出不会发生 ——
                 * 用户看到的就是"滑了，没反应"。
                 */
                if (tracking && !gestureConsumed && isSwipeUp(event)) {
                    tracking = false
                    gestureConsumed = true
                    dismiss()
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (tracking && !gestureConsumed && isSwipeUp(event)) {
                    gestureConsumed = true
                    dismiss()
                } else if (tracking && !gestureConsumed
                        && event.actionMasked == MotionEvent.ACTION_UP
                        && isTap(event)) {
                    // 只有**抬起**才算点击：CANCEL 是系统把这一串收走了，不是用户点了一下。
                    gestureConsumed = true
                    toggleChrome()
                }
                tracking = false
            }
            else -> {
            }
        }
        /*
         * 事件必须**继续往下传**：这一层只是顺便看一眼手势，不是来吃事件的。
         * 一旦在这里吞掉，面板上的按钮和锁屏自己的手势条都收不到了。
         */
        return super.dispatchTouchEvent(event)
    }

    /**
     * 一次「点」：几乎没移动、也不长按 —— 滑动和上滑退出都不算。
     *
     * 走到这里的点击**必然落在画面上**：底部那条面板是另一个子窗口，落在它上面的事件
     * 到不了这里（它自己的 onTouch 先吃掉）；而画歌词那一层叠层是 NOT_TOUCHABLE 的，
     * 事件照样穿过来。所以不用再去判点击落在哪儿 —— 用户眼里的"空白区域"就是这一整片。
     */
    private fun isTap(event: MotionEvent): Boolean {
        val limit = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP,
                TAP_MAX_MOVE_DP, resources.displayMetrics)
        return Math.abs(event.rawX - startX) <= limit
                && Math.abs(event.rawY - startY) <= limit
                && (event.eventTime - event.downTime) <= TAP_MAX_DURATION_MS
    }

    /**
     * 点空白区域：收起 / 放出底部那条 UI。再点一下放回来，不会有一条回不来的死路。
     *
     * 状态**只有一份**，就在面板里（这里读它的当前值再翻）：页面与面板两处都能触发，
     * 各存一份的话重排一次就会对不上，表现是"点一下收了，再点还是收着"。
     */
    private fun toggleChrome() {
        val panel = controlPanel ?: return
        panel.setChromeHidden(!panel.isChromeHidden(), true)
    }

    /** 向上、够远、而且不是横着扫的 —— 才认它是"退出"。 */
    private fun isSwipeUp(event: MotionEvent): Boolean {
        val dy = startY - event.rawY
        val dx = Math.abs(event.rawX - startX)
        val threshold = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP,
                SWIPE_UP_DP, resources.displayMetrics)
        return dy >= threshold && dx <= dy * SWIPE_MAX_SIDE_RATIO
    }

    override fun onResume() {
        super.onResume()
        // 转屏 / 多窗口之后 token 会变，回来再交一次。
        handWindowTokenToOverlay()
        // 面板同理：旧窗口那个 token 已经失效，不重挂的话按钮会变成"点了没反应"。
        window.decorView.post {
            val panel = controlPanel
            if (panel != null) {
                panel.detach()
                panel.attach()
            }
        }
    }

    /**
     * 把窗口 token 交给叠层。
     *
     * 必须等 decorView 真的贴上窗口之后才拿得到 token —— 在 onCreate 里直接读会拿到 null，
     * 于是窗口以 PANEL 类型挂上去时立刻被拒（表现是「锁屏上什么都没有，日志也不报错」）。
     */
    private fun handWindowTokenToOverlay() {
        val decorView: View = window.decorView
        decorView.post {
            top.izuna.foliamajor.wallpaper.WallpaperOverlay
                    .shared(this@LockScreenMusicActivity)
                    .setLockScreenHost(this@LockScreenMusicActivity)
        }
    }

    override fun onDestroy() {
        // 定时刷新必须停：Runnable 持有 Activity，漏掉这一句就是整屏 Activity 泄漏。
        panelHandler.removeCallbacks(panelRefresh)
        val panel = controlPanel
        if (panel != null) {
            panel.detach()
            controlPanel = null
        }
        // 回调持有 Activity，不清掉就是整屏泄漏（叠层是进程级单例）。
        top.izuna.foliamajor.wallpaper.WallpaperOverlay
                .shared(this)
                .setWindowAttachedListener(null)
        /*
         * 不是我们主动 finish 的 —— 被系统回收了（内存紧张 / 锁屏那个 task 被清）。
         * 记一笔给诊断：用户看到"闪一下就没"时，能分清到底是判退场还是被回收。
         */
        if (!isFinishing) {
            top.izuna.foliamajor.wallpaper.WallpaperOverlay
                    .shared(this)
                    .noteLockScreenUnexpectedDestroy()
        }
        // 宿主没了，挂在它上面的窗口必须立刻摘掉：PANEL 窗口的 token 失效后
        // 会抛 BadTokenException / 直接被系统移除，而叠层自己还以为它挂着。
        top.izuna.foliamajor.wallpaper.WallpaperOverlay.shared(this).setLockScreenHost(null)
        super.onDestroy()
    }

    /**
     * 用户主动退场。
     *
     * 必须通知叠层一声：不然它下一轮巡检会发现"锁屏页没了、但锁屏条件还成立"，
     * 于是退回悬浮窗那条路再挂一层上来 —— 用户刚关掉的又自己回来了。
     */
    fun dismissFromPanel() {
        dismiss()
    }

    private fun dismiss() {
        top.izuna.foliamajor.wallpaper.WallpaperOverlay
                .shared(this)
                .noteLockScreenDismissedByUser()
        /*
         * 顺手把锁屏解掉（只在它**没有密码**的时候）。
         *
         * 用户点退出要的是"回到桌面"，不是"关掉这一层、然后再自己滑一次" ——
         * 而上滑退出这个手势本身和很多 ROM 的解锁手势同向，用户期待的正是解锁。
         * 有密码 / 指纹的锁屏不能代劳（那需要用户认证，系统会自己弹认证界面），
         * 那种情况只退掉这一层，把锁屏原样还给用户。
         */
        try {
            val manager = getSystemService(KEYGUARD_SERVICE) as android.app.KeyguardManager
            if (manager != null && !manager.isKeyguardSecure
                    && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                manager.requestDismissKeyguard(this, null)
            }
        } catch (error: Throwable) {
            android.util.Log.w("FoliaLockScreen", "Could not dismiss the keyguard", error)
        }
        finish()
    }

    /**
     * 返回键：这个页面是锁屏上的一层，按返回不该"退出应用"，也不该留在这里挡着。
     */
    override fun onBackPressed() {
        dismiss()
    }
}
