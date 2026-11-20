package top.izuna.foliamajor.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import top.izuna.foliamajor.wallpaper.STALL_HOLD_MAX_MS
import top.izuna.foliamajor.wallpaper.StallHold

// #314：播放器代数门与锚点 playing 取值的纯逻辑回归。
class PlayerGenerationTest {
    @Test
    fun `旧代数的释放回调不能清新代数的缓冲豁免`() {
        val gate = PlayerGeneration()
        val old = gate.advance()
        val fresh = gate.advance()
        var cleared = 0
        assertFalse(gate.runIfCurrent(old) { cleared++ })
        assertEquals(0, cleared)
        assertTrue(gate.runIfCurrent(fresh) { cleared++ })
        assertEquals(1, cleared)
    }

    @Test
    fun `新代数建立后旧事件被挡掉`() {
        val gate = PlayerGeneration()
        val old = gate.advance()
        assertTrue(gate.isCurrent(old))
        gate.advance()
        assertFalse(gate.isCurrent(old))
    }

    @Test
    fun `READY 但播放器尚未出声时不写 playing=true`() {
        assertFalse(anchorPlayingForEvent("ready", false))
        assertFalse(anchorPlayingForEvent("seeked", false))
        assertFalse(anchorPlayingForEvent("position", false))
    }

    @Test
    fun `真在出声时 ready 与 position 写 playing=true`() {
        assertTrue(anchorPlayingForEvent("ready", true))
        assertTrue(anchorPlayingForEvent("position", true))
    }

    @Test
    fun `paused 与 playing 事件本身就是结论`() {
        // pause() 先发 paused 后 setPlayWhenReady(false)，那一刻播放器真值仍为 true。
        assertFalse(anchorPlayingForEvent("paused", true))
        assertTrue(anchorPlayingForEvent("playing", false))
    }

    // ---------- 跨代清理（#H8） ----------

    @Test
    fun `跨代清理不看代数，过期的一方也能清`() {
        // 旧播放器停在 stalled 里退场：它的清理回调若按代数门禁就被挡掉，
        // 而新一代又迟迟不装源，这条状态就永远没人清。清理必须无条件执行。
        val gate = PlayerGeneration()
        val hold = StallHold()
        val retired = gate.advance()
        hold.update(true, 0L)
        assertTrue(hold.held(1_000L))

        gate.advance()
        assertFalse(gate.isCurrent(retired))
        var cleared = 0
        gate.clearForRetiredGeneration { hold.reset(); cleared++ }
        assertEquals(1, cleared)
        assertFalse(hold.held(1_000L))
        assertFalse(hold.expired(1_000L))
    }

    @Test
    fun `代数前进一步而旧代清理没跑时状态最多撑到上限`() {
        // 验收标准：不残留无限期的 stalled —— 最多 STALL_HOLD_MAX_MS 之后按暂停收起。
        val hold = StallHold()
        hold.update(true, 0L)
        assertTrue(hold.held(STALL_HOLD_MAX_MS))
        assertFalse(hold.held(STALL_HOLD_MAX_MS + 1))
        assertTrue(hold.expired(STALL_HOLD_MAX_MS + 1))
    }
}
