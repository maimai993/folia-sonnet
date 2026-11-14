package top.izuna.foliamajor.wallpaper

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// #314：播放器等数据的这段时间不按「暂停时隐藏」收起，但有上限；连着报同一个状态不能把上限往后挪。
class StallHoldTest {
    @Test
    fun `没报过等数据时不豁免`() {
        val hold = StallHold(maxMs = 15_000L)
        assertFalse(hold.held(1_000L))
        assertFalse(hold.expired(1_000L))
    }

    @Test
    fun `等数据期间豁免到上限为止`() {
        val hold = StallHold(maxMs = 15_000L)
        assertTrue(hold.update(true, 10_000L))
        assertTrue(hold.held(10_000L))
        assertTrue(hold.held(25_000L))
        assertFalse(hold.held(25_001L))
        assertTrue(hold.expired(25_001L))
    }

    @Test
    fun `位置刻度连着报等数据不会把上限顺延`() {
        val hold = StallHold(maxMs = 15_000L)
        assertTrue(hold.update(true, 10_000L))
        // 每秒一拍，一直报 true：起点必须还是第一次那一下。
        for (tick in 1..20) {
            assertFalse(hold.update(true, 10_000L + tick * 1_000L))
        }
        assertFalse(hold.held(30_000L))
        assertTrue(hold.expired(30_000L))
    }

    @Test
    fun `恢复出声后立刻不再豁免`() {
        val hold = StallHold(maxMs = 15_000L)
        hold.update(true, 10_000L)
        assertTrue(hold.update(false, 13_000L))
        assertFalse(hold.held(13_000L))
        assertFalse(hold.expired(13_000L))
        // 之后真按了暂停，快照是 playing=false，但这里早已不豁免。
        assertFalse(hold.held(14_000L))
    }

    @Test
    fun `再卡一次重新起算`() {
        val hold = StallHold(maxMs = 15_000L)
        hold.update(true, 10_000L)
        hold.update(false, 24_000L)
        assertTrue(hold.update(true, 24_500L))
        assertTrue(hold.held(39_000L))
        assertFalse(hold.held(39_501L))
    }

    @Test
    fun `时钟往回走时按不豁免处理`() {
        val hold = StallHold(maxMs = 15_000L)
        hold.update(true, 10_000L)
        assertFalse(hold.held(9_000L))
    }
}
