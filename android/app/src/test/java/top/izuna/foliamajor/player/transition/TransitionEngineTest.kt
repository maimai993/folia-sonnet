package top.izuna.foliamajor.player.transition

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import top.izuna.foliamajor.player.transition.bridge.DeckControl
import top.izuna.foliamajor.player.transition.engine.CuePhase
import top.izuna.foliamajor.player.transition.engine.EffectOutput
import top.izuna.foliamajor.player.transition.engine.TransitionCue
import top.izuna.foliamajor.player.transition.engine.TransitionEngine

/** 用假 Deck 跑完整状态机：不需要设备、不需要 ExoPlayer、不需要 Looper。 */
class TransitionEngineTest {

    private class FakeDeck : DeckControl {
        var now = 0L
        var prepareResult = true
        val outputs = mutableListOf<EffectOutput>()
        val cues = mutableListOf<TransitionCue>()
        private val scheduled = mutableListOf<Runnable>()
        var finishCount = 0
        var abortCount = 0
        var fallbackCount = 0

        override fun runOnPlayer(action: Runnable) { action.run() }
        override fun scheduleOnPlayer(delayMs: Long, action: Runnable) {
            now += delayMs
            scheduled.add(action)
        }
        override fun cancelOnPlayer(action: Runnable) { scheduled.removeAll { it === action } }
        override fun nowMs(): Long = now
        override fun applyOutput(output: EffectOutput) { outputs.add(output) }
        override fun canHandover(): Boolean = prepareResult
        override fun prepareHandover(url: String, mediaId: String?, startMs: Long): Boolean = prepareResult
        override fun fallbackPrepare(url: String, mediaId: String?) { fallbackCount++ }
        override fun finishHandover() { finishCount++ }
        override fun abortHandover() { abortCount++ }
        override fun restoreTempo() {}
        override fun positionMs(): Long = now
        override fun isPlaying(): Boolean = true
        override fun emitCue(cue: TransitionCue) { cues.add(cue) }

        fun drain(max: Int = 5_000) {
            var guard = 0
            while (scheduled.isNotEmpty() && guard++ < max) {
                scheduled.removeAt(0).run()
            }
        }
    }

    private fun plan(
        style: EffectId = EffectId.PLAIN_BLEND,
        overlap: Int = 400,
    ) = TransitionPlan(style = style, overlapMs = overlap, curve = CurveId.EQUAL_POWER)

    @Test
    fun `完整流程 armed 到 finished`() {
        val deck = FakeDeck()
        val engine = TransitionEngine(deck)
        engine.arm(plan(), null, null)
        assertEquals(TransitionEngine.State.ARMED, engine.state)
        assertTrue(deck.cues.any { it.phase == CuePhase.ARMED })

        assertTrue(engine.start("https://example/a.mp3", "song-a"))
        deck.drain()

        assertEquals(TransitionEngine.State.IDLE, engine.state)
        assertEquals(1, deck.finishCount)
        assertTrue(deck.cues.any { it.phase == CuePhase.STARTED })
        assertTrue(deck.cues.any { it.phase == CuePhase.FINISHED })
        assertTrue("逐帧输出应有多帧", deck.outputs.size >= 15)
        // 终态必须钉死：进场满音量、出场静音、速度归位。
        val last = deck.outputs.last()
        assertEquals(1f, last.incomingGain, 1e-4f)
        assertEquals(0f, last.outgoingGain, 1e-4f)
        assertEquals(1f, last.tempoOut, 1e-4f)
    }

    @Test
    fun `没有交接条件时不硬凑过渡`() {
        val deck = FakeDeck().apply { prepareResult = false }
        val engine = TransitionEngine(deck)
        engine.arm(plan(), null, null)
        engine.start("https://example/a.mp3", "song-a")

        assertEquals(TransitionEngine.State.IDLE, engine.state)
        assertEquals(0, deck.finishCount)
        assertTrue(deck.outputs.isEmpty())
        assertTrue(deck.cues.any { it.phase == CuePhase.FINISHED && it.reason.contains("无交接条件") })
    }

    @Test
    fun `撤销必须收掉额外播放器`() {
        val deck = FakeDeck()
        val engine = TransitionEngine(deck)
        engine.arm(plan(overlap = 4_000), null, null)
        engine.start("https://example/a.mp3", "song-a")
        // 手动跑几拍再撤销。
        repeat(3) { deck.drain(1) }
        engine.cancel("拖动进度条")
        deck.drain()

        assertEquals(1, deck.abortCount)
        assertEquals(0, deck.finishCount)
        assertEquals(TransitionEngine.State.IDLE, engine.state)
        assertTrue(deck.cues.any { it.phase == CuePhase.CANCELLED })
    }

    @Test
    fun `新的计划抢占旧计划`() {
        val deck = FakeDeck()
        val engine = TransitionEngine(deck)
        engine.arm(plan(overlap = 4_000), null, null)
        engine.start("https://example/a.mp3", "song-a")
        engine.arm(plan(style = EffectId.BASS_SWAP, overlap = 2_000), null, null)
        // 抢占发生在 RUNNING：旧交接被撤销，新计划进入 ARMED。
        assertEquals(TransitionEngine.State.ARMED, engine.state)
        assertEquals(1, deck.abortCount)
        assertEquals(EffectId.BASS_SWAP, engine.currentPlan()?.style)
    }

    @Test
    fun `增益随进度单调上升`() {
        val deck = FakeDeck()
        val engine = TransitionEngine(deck)
        engine.arm(plan(overlap = 400), null, null)
        engine.start("https://example/a.mp3", "song-a")
        deck.drain()
        val gains = deck.outputs.dropLast(1).map { it.incomingGain }
        assertTrue(gains.size >= 10)
        for (i in 1 until gains.size) {
            assertTrue("第 $i 帧增益不应回落", gains[i] >= gains[i - 1] - 1e-4f)
        }
    }

    @Test
    fun `硬切 40ms 两拍就结束`() {
        val deck = FakeDeck()
        val engine = TransitionEngine(deck)
        engine.arm(plan(style = EffectId.HARD_CUT, overlap = 40), null, null)
        engine.start("https://example/a.mp3", "song-a")
        deck.drain()
        assertEquals(1, deck.finishCount)
        assertTrue("硬切不该跑出很多帧", deck.outputs.size <= 4)
    }

    @Test
    fun `带 DSP 的效果会产出非单位频段增益`() {
        val deck = FakeDeck()
        val engine = TransitionEngine(deck)
        engine.arm(
            plan(style = EffectId.THREE_BAND_SEAM, overlap = 400).copy(needsDsp = true),
            null, null,
        )
        engine.start("https://example/a.mp3", "song-a")
        deck.drain()
        assertTrue(deck.outputs.any { it.bandIn != top.izuna.foliamajor.player.transition.engine.BandGains.UNIT })
        assertTrue(deck.outputs.any { it.needsDsp })
    }
}
