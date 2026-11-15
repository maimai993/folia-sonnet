package top.izuna.foliamajor.player

import org.junit.Assert.assertFalse
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
}
