package top.izuna.foliamajor

// android/app/src/main/java/top/izuna/foliamajor/LockScreenGesture.kt
// 音乐锁屏那几种手势的判定：上滑退出、点空白。锁屏页（LockScreenMusicActivity）与它底部的
// 控制面板（LockScreenControlPanel）共用这一份，常量与判定都只有一处。

/**
 * 一次手势的判定结果。
 *
 * 三个宿主（锁屏页的 `dispatchTouchEvent`、面板外壳的 `setOnTouchListener`、面板上那条
 * 退出手柄）拿到 [Gesture] 自己决定要做什么：锁屏页与外壳按"上滑退出 / 点空白"分工，
 * 手柄把"点击"翻成"退场动画"。
 */
internal enum class LockScreenGesture {
    /** 还没到判定条件。 */
    NONE,

    /** 上滑到位，该退出这一页。 */
    SWIPE_UP,

    /** 在同一个位置按下又抬起、也没长按 —— 一次"点"。 */
    TAP,
}

/**
 * 一套手势阈值，全部以 dp / ms 表示，与屏幕密度无关。
 *
 * ## 为什么只有一份
 *
 * 这里原本是**两套平行的实现、两套常量**：面板那份注释写着"与锁屏页那条同值，别让两处的
 * 手感不一样"，但实际只有点击那一组真的一样，上滑阈值一边 64dp 一边 72dp —— 同一次
 * 上滑，从面板上起手要比从画面上起手少滑 8dp。任何一次手感调整都得改两处，漏改即分叉。
 *
 * ## 为什么统一到 72dp（锁屏页那一侧）
 *
 * issue 说得很直白：两处使用场景不同（整页 vs 卡片），64dp 与 72dp 的差异可能是有意的。
 * 但放大的那一侧只能是"更难误触"的那一侧，而**整页那一侧恰恰是更危险的一侧**：
 * 上滑退出会顺手把无密码的锁屏解掉（见 LockScreenMusicActivity.dismiss），一次误判就是
 * "手机自己回桌面了"。卡片那一侧最坏的后果只是收起了锁屏页，代价小得多。
 *
 * 反过来，统一到 64dp 等于放松整页这一侧的门槛，把误触风险放在代价最大的地方，还要在
 * 那一侧补一条"上滑距离够不够"的额外判定来补偿，逻辑只会更绕。所以取 72dp：
 * 整页行为与改动前完全一致（不会有任何人因为这次统一而被更容易地踢出锁屏页），
 * 卡片侧多 8dp —— 那是往"更难误触"的方向偏，不是往"更容易误触"。
 */
internal data class LockScreenGestureTuning(
    /** 竖直方向位移超过多少 dp 才算上滑。 */
    val swipeUpDp: Float = 72f,
    /** 横向漂移占竖直位移的比例上限：超了就是横扫（切歌手势那类），不算上滑。 */
    val swipeMaxSideRatio: Float = 0.6f,
    /** 一次"点"允许的最大位移：超过就是滑动。 */
    val tapMaxMoveDp: Float = 16f,
    /** 一次"点"允许的最长按住时间：超过就是长按。 */
    val tapMaxDurationMs: Long = 400L,
) {
    companion object {
        /** 锁屏页与面板共用的那一份。改这里就是改两处，不需要再同步别的地方。 */
        @JvmField
        val SHARED = LockScreenGestureTuning()
    }
}

/**
 * 一次手势的判定器：吃按下时的锚点，之后每来一个触点就问一次。
 *
 * 刻意不碰 `MotionEvent`：宿主把 `rawX` / `rawY` / `eventTime` / `downTime` 四个数字喂进来，
 * 于是整套判定可以在 JVM 单测里跑（见 LockScreenGestureTest）。
 *
 * 多指只认第一根手指：第二根手指按下时锚点不动，抬手也一样 —— 那是缩放 / 误触，
 * 不该被判成上滑退出或者点空白。
 */
internal class LockScreenGestureTracker(
    private val density: Float,
    private val tuning: LockScreenGestureTuning = LockScreenGestureTuning.SHARED,
) {

    private var downX = 0f
    private var downY = 0f
    /** 这一串事件是否还在跟踪。上滑一旦触发就置 false，防止一次滑动里反复 dismiss。 */
    var tracking: Boolean = false
        private set

    /** 按下。之后每次 [evaluate] 都与这里记的锚点比较。 */
    fun down(x: Float, y: Float) {
        downX = x
        downY = y
        tracking = true
    }

    /**
     * 松开 / 取消：这一串到此为止，并且**直接返回这一串的最后判定**。
     *
     * 抬起这一下也要能判出上滑：手指在半路停住、或者被系统收走事件（ACTION_CANCEL）
     * 时，只有 ACTION_MOVE 那条路是走不到的，等不到抬手就永远退不出去。
     */
    fun up(x: Float, y: Float, eventTime: Long, downTime: Long, cancelled: Boolean = false): LockScreenGesture {
        if (!tracking) return LockScreenGesture.NONE
        val gesture = when {
            isSwipeUp(y, x) -> LockScreenGesture.SWIPE_UP
            // 只有**抬起**才算点击：CANCEL 是系统把这一串收走了，不是用户点了一下。
            !cancelled && isTap(x, y, eventTime, downTime) -> LockScreenGesture.TAP
            else -> LockScreenGesture.NONE
        }
        tracking = false
        return gesture
    }

    /**
     * 滑动中的一次采样。
     *
     * 上滑**滑到位就走，不等抬手** —— 等 ACTION_UP 的话，手指在半路停一下、或者被锁屏的
     * 手势条 / 系统把事件收走，就永远等不到那一击。判成上滑之后 [tracking] 变 false，
     * 同一次滑动里不会再触发第二次，也不必再等 [up]。
     */
    fun move(x: Float, y: Float): LockScreenGesture {
        if (!tracking) return LockScreenGesture.NONE
        if (isSwipeUp(y, x)) {
            tracking = false
            return LockScreenGesture.SWIPE_UP
        }
        return LockScreenGesture.NONE
    }

    private fun isSwipeUp(rawY: Float, rawX: Float): Boolean {
        val dy = downY - rawY
        val dx = Math.abs(rawX - downX)
        val threshold = tuning.swipeUpDp * density
        return dy >= threshold && dx <= dy * tuning.swipeMaxSideRatio
    }

    private fun isTap(rawX: Float, rawY: Float, eventTime: Long, downTime: Long): Boolean {
        val limit = tuning.tapMaxMoveDp * density
        return Math.abs(rawX - downX) <= limit
                && Math.abs(rawY - downY) <= limit
                && (eventTime - downTime) <= tuning.tapMaxDurationMs
    }
}
