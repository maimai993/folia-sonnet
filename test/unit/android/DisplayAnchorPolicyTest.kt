package top.izuna.foliamajor.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// 桌面歌词显示锚点的写入判定：纯音乐切到有歌词的歌后，快照卡在 playing=false 必须被播放器真值翻回来。
class DisplayAnchorPolicyTest {
    @Test
    fun `位置对得上且播停一致时不写`() {
        assertFalse(displayAnchorNeedsWrite(true, 10_100L, true, 10_000L))
        assertFalse(displayAnchorNeedsWrite(true, 9_900L, true, 10_000L))
    }

    @Test
    fun `快照停在暂停而播放器在播时即便位置对得上也要写`() {
        // 换歌那一刻快照被写成 playing=false、锚点 0；新歌刚起播，采样值也在 0 附近。
        assertTrue(displayAnchorNeedsWrite(false, 0L, true, 120L))
        assertTrue(displayAnchorNeedsWrite(false, 5_000L, true, 5_000L))
    }

    @Test
    fun `快照在播而播放器已停时要写`() {
        assertTrue(displayAnchorNeedsWrite(true, 5_000L, false, 5_000L))
    }

    @Test
    fun `位置差超过一个采样周期时要写`() {
        assertTrue(displayAnchorNeedsWrite(true, 10_000L + DISPLAY_ANCHOR_TOLERANCE_MS, true, 10_000L))
        assertTrue(displayAnchorNeedsWrite(true, 10_000L - DISPLAY_ANCHOR_TOLERANCE_MS, true, 10_000L))
    }

    @Test
    fun `都停着且位置对得上时不写`() {
        assertFalse(displayAnchorNeedsWrite(false, 5_000L, false, 5_100L))
    }

    @Test
    fun `缓冲中不算出声`() {
        assertTrue(playerAudible(true, false))
        assertFalse(playerAudible(true, true))
        assertFalse(playerAudible(false, false))
        assertFalse(playerAudible(false, true))
    }

    @Test
    fun `要求播着却在等数据才算卡住`() {
        // #314：网络一卡播放器停在 BUFFERING，播放意图还在。
        assertTrue(playerStalled(playWhenReady = true, bufferingState = true, isPlaying = false))
    }

    @Test
    fun `用户暂停后即便还在缓冲也不算卡住`() {
        assertFalse(playerStalled(playWhenReady = false, bufferingState = true, isPlaying = false))
    }

    @Test
    fun `出错或放完停在非缓冲状态不算卡住`() {
        // IDLE / ENDED：playWhenReady 可能还是 true，但它不会自己好起来。
        assertFalse(playerStalled(playWhenReady = true, bufferingState = false, isPlaying = false))
    }

    @Test
    fun `真在出声不算卡住`() {
        assertFalse(playerStalled(playWhenReady = true, bufferingState = false, isPlaying = true))
        assertFalse(playerStalled(playWhenReady = true, bufferingState = true, isPlaying = true))
    }

    @Test
    fun `后台一秒一拍的陈旧采样补上墙钟后不触发核对写锚点`() {
        // #320：采样在 10_000，过了 900ms 核对；外推锚点此刻约在 10_900。
        val display = extrapolatedDisplayPositionMs(10_000L, 1_000L, 1_900L, true, 1f)
        assertEquals(10_900L, display)
        assertFalse(displayAnchorNeedsWrite(true, 10_900L, true, display))
        // 不补的话差 900ms，必然越过容差往回拽。
        assertTrue(displayAnchorNeedsWrite(true, 10_900L, true, 10_000L))
    }

    @Test
    fun `外推按倍速并封顶`() {
        assertEquals(11_000L, extrapolatedDisplayPositionMs(10_000L, 1_000L, 1_500L, true, 2f))
        assertEquals(10_000L + DISPLAY_POSITION_EXTRAPOLATE_MAX_MS,
            extrapolatedDisplayPositionMs(10_000L, 1_000L, 60_000L, true, 1f))
        assertEquals(10_000L, extrapolatedDisplayPositionMs(10_000L, 5_000L, 1_000L, true, 1f))
    }

    @Test
    fun `没在出声或采样失效时不外推`() {
        assertEquals(10_000L, extrapolatedDisplayPositionMs(10_000L, 1_000L, 1_900L, false, 1f))
        assertEquals(10_000L, extrapolatedDisplayPositionMs(10_000L, 0L, 1_900L, true, 1f))
    }

    // ---------- 原生 seek 的回弹守卫（#H9） ----------

    @Test
    fun `守卫窗内小于 250ms 的回退照写`() {
        // 拖到 60s 落位之后，播放器接着报一条 59.9s：差在容差内，就是这次 seek 的真落位。
        val guard = armNativeSeekGuard(60_000L, 1_000L)
        assertEquals(59_900L, seekGuardVerdict(guard, 59_900L, 1_050L))
    }

    @Test
    fun `守卫窗内旧位置那条不写`() {
        // seek 还没落位，播放器先用旧位置（10s）报了一条不连续：写下去歌词就弹回去了。
        val guard = armNativeSeekGuard(60_000L, 1_000L)
        assertNull(seekGuardVerdict(guard, 10_000L, 1_030L))
    }

    @Test
    fun `守卫窗过期之后同样的回退照写`() {
        // 播放器崩在缓冲里、一直没落位：窗口到上限就放行，别让歌词永久停住。
        val guard = armNativeSeekGuard(60_000L, 1_000L)
        assertEquals(10_000L, seekGuardVerdict(guard, 10_000L, 1_000L + NATIVE_SEEK_GUARD_MAX_MS + 1L))
    }

    @Test
    fun `落位之后窗口再撑一小段就关`() {
        val armed = armNativeSeekGuard(60_000L, 1_000L)
        val confirmed = advanceNativeSeekGuard(armed, 60_000L, 1_060L)
        assertTrue(confirmed.confirmed)
        // 收尾期里紧跟着的那条旧位置仍然不写。
        assertNull(seekGuardVerdict(confirmed, 10_000L, 1_200L))
        // 收尾期结束：窗口关掉，之后一律照写。
        val closed = advanceNativeSeekGuard(confirmed, 60_000L, 1_060L + NATIVE_SEEK_GUARD_HOLD_MS + 1L)
        assertFalse(closed.armed)
        assertEquals(10_000L, seekGuardVerdict(closed, 10_000L, 99_999L))
    }

    @Test
    fun `没打开窗口时一律照写`() {
        assertEquals(10_000L, seekGuardVerdict(NATIVE_SEEK_GUARD_IDLE, 10_000L, 1_000L))
        assertFalse(nativeSeekGuardActive(NATIVE_SEEK_GUARD_IDLE, 1_000L))
    }

    @Test
    fun `时钟倒退按过期处理而不是永久挂住`() {
        val guard = armNativeSeekGuard(60_000L, 5_000L)
        assertEquals(10_000L, seekGuardVerdict(guard, 10_000L, 1_000L))
        assertFalse(nativeSeekGuardActive(advanceNativeSeekGuard(guard, 10_000L, 1_000L), 1_000L))
    }

    @Test
    fun `seek 到 0 与单曲循环回绕都在容差内放行`() {
        val toZero = armNativeSeekGuard(0L, 1_000L)
        assertEquals(0L, seekGuardVerdict(toZero, 0L, 1_010L))
        // 单曲循环回绕：目标就是 0，播放器报 5ms 也算落位。
        assertEquals(5L, seekGuardVerdict(toZero, 5L, 1_020L))
    }
}
