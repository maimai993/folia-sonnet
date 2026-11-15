package top.izuna.foliamajor.player

import org.junit.Assert.assertEquals
import org.junit.Test

// android/app/src/test/java/top/izuna/foliamajor/player/UnplayableDecisionTest.kt
// 一首歌确实放不了（地址重试过也拿不到）时该跳过还是停下。
//
// 两条边界都容易写错，而且写错在真机上表现为「一直在跳歌」或「明明开了自动跳过却不动」：
//   · 设置关掉时不能自作主张跳过；
//   · 设置开着时也不能无限跳 —— 整个歌单都无版权会把队列扫空。

class UnplayableDecisionTest {

    @Test
    fun `默认跳过`() {
        assertEquals(UnplayableDecision.SKIP_NEXT, decideOnUnplayable(autoSkip = true, consecutiveSkips = 0))
    }

    @Test
    fun `关掉自动跳过就停下`() {
        assertEquals(UnplayableDecision.STOP, decideOnUnplayable(autoSkip = false, consecutiveSkips = 0))
    }

    @Test
    fun `连续跳过到达上限就停下`() {
        assertEquals(UnplayableDecision.SKIP_NEXT, decideOnUnplayable(autoSkip = true, consecutiveSkips = 4))
        assertEquals(UnplayableDecision.STOP, decideOnUnplayable(autoSkip = true, consecutiveSkips = 5))
    }

    @Test
    fun `上限可调`() {
        assertEquals(UnplayableDecision.STOP, decideOnUnplayable(true, 2, maxConsecutiveSkips = 2))
    }
}
