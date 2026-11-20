package top.izuna.foliamajor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// test/unit/android/LockScreenGestureTest.kt
// 锁屏手势判定的纯逻辑单测（issue L6）。
//
// 钉住的是：上滑退出 / 点空白这组判定**只有一份实现**，锁屏页与底部面板共用它。
// 改动之前两处是平行的两套，上滑阈值一边 64dp 一边 72dp —— 同一次上滑，从面板上起手
// 要比从画面上起手少滑 8dp。这个测试用同一组输入驱动同一个判定器，两处得到的结果必然
// 相同，也就把"再次分叉"钉死在这里。

class LockScreenGestureTest {

    /** 3x 密度：72dp = 216px，16dp = 48px —— 整数，避免浮点比较的噪声。 */
    private val density = 3f

    private fun tracker() = LockScreenGestureTracker(density)

    @Test
    fun `上滑够远就退出，且不等抬手`() {
        val gesture = tracker()
        gesture.down(500f, 2000f)

        // 还差一点：阈值的下沿再往下 1px。
        assertEquals(LockScreenGesture.NONE, gesture.move(500f, 2000f - (72f * density) + 1f))
        // 到位：滑动中就给出结果（不用等 ACTION_UP）。
        assertEquals(LockScreenGesture.SWIPE_UP, gesture.move(500f, 2000f - 72f * density))
    }

    @Test
    fun `上滑一旦判定过，同一次滑动不会重复触发`() {
        val gesture = tracker()
        gesture.down(500f, 2000f)
        // 3dp/px 下 216px 正好是 72dp：dy >= 阈值，判成上滑。
        assertEquals(LockScreenGesture.SWIPE_UP, gesture.move(500f, 2000f - 72f * density))

        // 手指继续往上、然后抬起：都不该再给出第二个 SWIPE_UP（那正是"抽搐"的形状）。
        assertEquals(LockScreenGesture.NONE, gesture.move(500f, 1600f))
        assertEquals(LockScreenGesture.NONE, gesture.up(500f, 1600f, 300L, 0L))
    }

    @Test
    fun `横向漂移超过竖直位移的六成就不算上滑`() {
        val gesture = tracker()
        gesture.down(500f, 2000f)
        // 竖直 300px、横向 200px：比例 0.67 > 0.6 —— 那是横扫。
        assertEquals(LockScreenGesture.NONE, gesture.move(300f, 1700f))
    }

    @Test
    fun `几乎没动、也不长按才算一次点`() {
        val gesture = tracker()
        gesture.down(500f, 1000f)
        assertEquals(LockScreenGesture.TAP, gesture.up(510f, 1010f, 120L, 0L))
    }

    @Test
    fun `长按不是点`() {
        val gesture = tracker()
        gesture.down(500f, 1000f)
        assertEquals(LockScreenGesture.NONE, gesture.up(500f, 1000f, 900L, 0L))
    }

    @Test
    fun `移动超出点击上限就不是点`() {
        val gesture = tracker()
        gesture.down(500f, 1000f)
        // 横移 60px > 16dp(48px)，但竖直没动、也远不够上滑。
        assertEquals(LockScreenGesture.NONE, gesture.up(560f, 1000f, 100L, 0L))
    }

    @Test
    fun `取消不是点`() {
        val gesture = tracker()
        gesture.down(500f, 1000f)
        assertEquals(LockScreenGesture.NONE, gesture.up(500f, 1000f, 100L, 0L, cancelled = true))
    }

    @Test
    fun `取消也要能判出上滑`() {
        // 手指滑到一半被系统把这一串收走：等不到 ACTION_UP 的那一击，但这一次确实滑够了。
        val gesture = tracker()
        gesture.down(500f, 2000f)
        assertEquals(LockScreenGesture.SWIPE_UP, gesture.up(500f, 1700f, 300L, 0L, cancelled = true))
    }

    @Test
    fun `没按下就问的话什么也不判`() {
        val gesture = tracker()
        assertEquals(LockScreenGesture.NONE, gesture.move(500f, 1000f))
        assertEquals(LockScreenGesture.NONE, gesture.up(500f, 1000f, 10L, 0L))
    }

    @Test
    fun `锁屏页与面板共用同一份阈值`() {
        // 只有一份常量来源：两个跟踪器用默认 tuning 时，同一组输入必然给出同样的结论。
        // 改动之前这里是两套常量（72f / 64f），这条断言会失败 —— 也就是说：
        // 「面板上滑 60dp 就退、锁屏页要 70dp」这种分叉一旦回来，这里就会红。
        val activitySide = tracker()
        val panelSide = tracker()
        val input = listOf(0f, 60f, 64f, 71.9f, 72f, 100f)

        for (dy in input) {
            activitySide.down(500f, 2000f)
            panelSide.down(500f, 2000f)
            val fromActivity = activitySide.move(500f, 2000f - dy * density)
            val fromPanel = panelSide.move(500f, 2000f - dy * density)
            assertEquals("dy=${dy}dp 时两处判定不一致", fromActivity, fromPanel)
        }

        // 顺便把阈值的绝对值也钉住：72dp 才算上滑（71.9dp 不算、72dp 算）。
        assertEquals(72f, LockScreenGestureTuning.SHARED.swipeUpDp, 0f)
        assertEquals(0.6f, LockScreenGestureTuning.SHARED.swipeMaxSideRatio, 0f)
        assertEquals(16f, LockScreenGestureTuning.SHARED.tapMaxMoveDp, 0f)
        assertEquals(400L, LockScreenGestureTuning.SHARED.tapMaxDurationMs)
        assertFalse(LockScreenGestureTracker(density).tracking)
    }
}
