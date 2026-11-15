package top.izuna.foliamajor
import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.animation.AlphaAnimation
import android.view.animation.Animation
import android.view.animation.AnimationSet
import android.view.animation.TranslateAnimation
import android.widget.FrameLayout
import android.widget.TextView

import com.getcapacitor.JSObject

// android/app/src/main/java/top/izuna/foliamajor/FoliaOverlayNotice.java
//
// 后台播放提示的**悬浮条**：样子照 Web 层那条提示（StatusToast）来，但贴在**屏幕下边** ——
// 后台这一条是画在别的应用上面的，压住别人顶部的状态栏/通知比压住底部那条手势条更招人烦。
// 左右留边、水平居中的一条圆角条，只有一行字、**没有按钮**（后台是自动跳过，按钮既点不到
// 也没有意义）。
//
// 为什么不用系统 Toast：Android 11 起后台**不允许**弹自定义 view 的 Toast，只剩下
// 纯文本那条路，于是「和系统画的一样」根本做不到。悬浮窗（SYSTEM_ALERT_WINDOW）
// 能画我们自己的样子，代价是用户要先在系统设置里授权 —— 没授权就退回原来的系统
// Toast（回退在渲染层的 backgroundFailureNotice 里做，这里只回答「挂上去没有」）。
//
// ⚠ 三点必须记住：
//   1. 所有 WindowManager 调用都在**主线程**（Capacitor 的插件方法跑在它自己的
//      HandlerThread 上，直接 addView 会抛并且会让进程死 —— 见 FoliaNativePlugin
//      里其它有线程归属的原生对象）。
//   2. 上下文用 **Application**：提示是在 Activity 已经 stop 之后弹的，抓着 Activity
//      会把它整个泄漏，而且那扇窗口随时可能已经没了。
//   3. ⭐⭐**摘窗口不能只靠动画回调**：早先把 removeView 只挂在出场动画的
//      onAnimationEnd 上，回调一不落（ROM 不派发、窗口令牌中途失效、动画被系统掐掉）
//      那条就**永远留在屏幕上**，表现正是「它出现了就不会消失」。现在动画只是好看，
//      真正的摘除另有一条到点的兜底（见 hide 里的 postDelayed），而且是幂等的。

class FoliaOverlayNotice private constructor() {
    companion object {
        private const val TAG = "FoliaOverlayNotice"

        /** 摘除已经做过了的标记：动画回调与定时兜底两路都会走到，只能真的摘一次。 */
        private val REMOVED: Any = Any()

        // 贴底：与网页那条同一组数，只是翻到下面来 —— 离底边 30dp，再让开安全区（手势条）。
        private const val BOTTOM_MARGIN_DP = 30
        private const val SIDE_MARGIN_DP = 16
        private const val MAX_WIDTH_DP = 640
        private const val RADIUS_DP = 22
        private const val PAD_V_DP = 9
        private const val PAD_H_DP = 16
        private const val TEXT_SP = 14
        private const val MAX_LINES = 2

        private const val IN_MS = 320L
        private const val OUT_MS = 220L
        /** 动画该跑完的时间；过了这一刻还没摘掉就直接摘（回调不落时的兜底）。 */
        private const val OUT_GRACE_MS = OUT_MS + 200
        private const val DEFAULT_DURATION_MS = 4000L

        private val AUTO_HIDE = Runnable { hide() }

        private var current: View? = null
        private var mainHandler: Handler? = null

        /** 这一支有没有「画在别的应用上面」的授权。没授权时调用方该去用系统 Toast。 */
        @JvmStatic
        fun canDraw(context: Context?): Boolean {
            if (context == null) return false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                try {
                    return Settings.canDrawOverlays(context)
                } catch (error: Throwable) {
                    Log.w(TAG, "canDrawOverlays failed", error)
                    return false
                }
            }
            // 6.0 以下这个权限是安装时给的。
            return true
        }

        private fun main(): Handler {
            val existing = mainHandler
            if (existing != null) return existing
            val created = Handler(Looper.getMainLooper())
            mainHandler = created
            return created
        }

        /** 底部安全区（dp）：手势条那一条，与网页用的 --folia-safe-area-bottom 同源。 */
        private fun safeBottomDp(): Int {
            try {
                val insets = FoliaNativePlugin.peekPhoneInsets()
                return if (insets == null) 0 else insets.optInt("bottom", 0)
            } catch (error: Throwable) {
                return 0
            }
        }

        /**
         * 弹一条悬浮提示。**必须在主线程调用**（插件方法里请自己 post 过来）。
         *
         * 返回 false 表示没挂上去（没授权 / 窗口令牌失效），调用方据此回退。
         * `durationMs` 到点后自己收掉；不传或传 0 用默认的 4 秒。
         */
        @JvmStatic
        @Synchronized
        fun show(context: Context?, text: String?, durationMs: Long): Boolean {
            val app: Context? = if (context == null) null else context.applicationContext
            if (app == null || text == null || text.trim { it <= ' ' }.isEmpty()) return false
            if (!canDraw(app)) return false

            try {
                // 已经有一条在显示时**换字重算时间**，不要叠第二条：连着几首都放不出来时
                // 屏幕上不该一次盖一次地刷屏（与渲染层那 4 秒去重是同一件事的两个面）。
                val existing = current
                if (existing != null) {
                    val label = existing.findViewWithTag<TextView>("notice-text")
                    if (label != null) label.text = text
                    scheduleHide(durationMs)
                    return true
                }

                val manager = app.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
                if (manager == null) return false

                val density = app.resources.displayMetrics.density
                val label = TextView(app)
                label.tag = "notice-text"
                label.text = text
                label.setTextColor(0xFFFFFFFF.toInt())
                label.setTextSize(TypedValue.COMPLEX_UNIT_SP, TEXT_SP.toFloat())
                label.maxLines = MAX_LINES
                // 网页那条的正文字重是 500（.status-toast-title）。
                label.typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
                label.ellipsize = android.text.TextUtils.TruncateAt.END
                label.maxWidth = (MAX_WIDTH_DP * density).toInt()
                val padV = (PAD_V_DP * density).toInt()
                val padH = (PAD_H_DP * density).toInt()
                label.setPadding(padH, padV, padH, padV)
                // 每行 24sp 的行高，与 Web 上那条（line-height: 24px）一致：
                // 14sp 的字本身占不满 24，补上这 10sp 的间距就是那个行高。
                // setLineSpacing 第一参数是 float，先乘出 px 再转。
                label.setLineSpacing(10f * app.resources.displayMetrics.scaledDensity, 1f)
                label.background = noticeBackground(density)

                val wrap = FrameLayout(app)
                wrap.setPadding((SIDE_MARGIN_DP * density).toInt(), 0, (SIDE_MARGIN_DP * density).toInt(), 0)
                wrap.clipChildren = false
                val inner = FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT)
                inner.gravity = Gravity.CENTER_HORIZONTAL
                wrap.addView(label, inner)

                val params = WindowManager.LayoutParams()
                params.type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                else
                    WindowManager.LayoutParams.TYPE_PHONE
                // 不吃点击：它只是「说一句话」，点它跟点它盖住的那一层是同一回事
                // （Web 上那条不带按钮时也是 pointer-events 只在自己身上）。
                /*
                 * `or` 必须留在上一行行尾：Kotlin 2.3 把握手行首的运算符读成新的语句，
                 * 于是 169 行起每行都报「Expecting an element」。
                 */
                params.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                params.format = android.graphics.PixelFormat.TRANSLUCENT
                params.gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
                // 离底边 30dp **再加**底部安全区：贴在手势条上面的话既挡手势也容易被系统收走。
                // 取的是和网页同一份数（PhoneFitCutout 量出来推给网页的那个，CSS px = dp）。
                params.y = ((BOTTOM_MARGIN_DP + safeBottomDp()) * density).toInt()
                params.width = WindowManager.LayoutParams.MATCH_PARENT
                params.height = WindowManager.LayoutParams.WRAP_CONTENT

                manager.addView(wrap, params)
                current = wrap
                wrap.startAnimation(enterAnimation(density))
                scheduleHide(durationMs)
                return true
            } catch (error: Throwable) {
                // 窗口令牌失效 / 权限被撤 / ROM 不给画：一律当没弹出来，让调用方回退。
                Log.w(TAG, "the overlay notice could not be shown", error)
                current = null
                return false
            }
        }

        /**
         * 收掉当前这一条（如果有）。
         *
         * ⭐出场动画**只是好看**：真正的摘除由 {@link #removeNow} 完成，而它到点那一刻一定会走
         * —— 动画回调（onAnimationEnd）与定时兜底两条路都指向它，谁先到谁摘，后到的被
         * REMOVED 标记挡掉。少了这条兜底，回调不落时提示就永远留在屏幕上。
         */
        @JvmStatic
        @Synchronized
        fun hide() {
            val view = current
            if (view == null) return
            current = null
            main().removeCallbacks(AUTO_HIDE)

            val density = view.resources.displayMetrics.density
            val out = outAnimation(density)
            out.setAnimationListener(object : Animation.AnimationListener {
                override fun onAnimationStart(animation: Animation) {
                }

                override fun onAnimationEnd(animation: Animation) {
                    removeNow(view)
                }

                override fun onAnimationRepeat(animation: Animation) {
                }
            })
            try {
                view.startAnimation(out)
            } catch (error: Throwable) {
                removeNow(view)
            }
            // 兜底：动画这一路出了任何岔子（回调不派发、动画被掐），到点也一定摘掉。
            main().postDelayed({ removeNow(view) }, OUT_GRACE_MS)
        }

        /** 摘窗口。**幂等**：动画回调与定时兜底都会走到这里，只能真的摘一次。 */
        private fun removeNow(view: View) {
            if (view.tag === REMOVED) return
            view.tag = REMOVED
            try {
                val app = view.context.applicationContext
                val manager = app.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
                if (manager != null) manager.removeView(view)
            } catch (error: Throwable) {
                Log.w(TAG, "removing the overlay notice failed", error)
            }
        }

        private fun scheduleHide(durationMs: Long) {
            main().removeCallbacks(AUTO_HIDE)
            main().postDelayed(AUTO_HIDE, if (durationMs > 0) durationMs else DEFAULT_DURATION_MS)
        }

        /**
         * 条子的底：圆角 22dp + 一道 8% 白的边。
         *
         * ⚠ Web 那条是「10% 白的玻璃 + 背后模糊」，模糊在悬浮窗里做不到（背后画的是别的
         * 应用的画面，拿不到那一层），而背景是什么颜色也完全由当时屏幕上是什么决定。
         * 所以这里换成较深的底 —— 换的是可读性，形状、行高、字号、圆角全照搬。
         */
        private fun noticeBackground(density: Float): GradientDrawable {
            val drawable = GradientDrawable()
            drawable.cornerRadius = RADIUS_DP * density
            drawable.setColor(0xF2131317.toInt())
            drawable.setStroke(Math.max(1, density.toInt()), 0x14FFFFFF)
            return drawable
        }

        /** 从下方 18dp 处淡入（与网页那条同一个数，方向翻过来）。 */
        private fun enterAnimation(density: Float): Animation {
            val set = AnimationSet(false)
            val alpha = AlphaAnimation(0f, 1f)
            val move = TranslateAnimation(0f, 0f, 18f * density, 0f)
            set.addAnimation(alpha)
            set.addAnimation(move)
            set.duration = IN_MS
            set.interpolator = android.view.animation.DecelerateInterpolator(1.6f)
            return set
        }

        /** 往下 10dp 淡出。 */
        private fun outAnimation(density: Float): Animation {
            val set = AnimationSet(false)
            val alpha = AlphaAnimation(1f, 0f)
            val move = TranslateAnimation(0f, 0f, 0f, 10f * density)
            set.addAnimation(alpha)
            set.addAnimation(move)
            set.duration = OUT_MS
            set.interpolator = android.view.animation.AccelerateInterpolator(1.4f)
            return set
        }
    }
}
