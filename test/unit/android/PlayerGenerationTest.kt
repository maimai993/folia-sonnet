package top.izuna.foliamajor.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

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
}
