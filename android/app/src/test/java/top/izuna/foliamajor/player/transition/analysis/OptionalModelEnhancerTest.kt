package top.izuna.foliamajor.player.transition.analysis

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import top.izuna.foliamajor.player.transition.AnalysisTier
import top.izuna.foliamajor.player.transition.BeatGrid
import top.izuna.foliamajor.player.transition.TrackProfile

// android/app/src/test/java/top/izuna/foliamajor/player/transition/analysis/OptionalModelEnhancerTest.kt
// 增强包「装上」与「真算」是两件事（issue H21）：占位实现不得冒充 ENHANCED，也不得捏造置信度。
class OptionalModelEnhancerTest {

    private fun profile(confidence: Float = 0.5f) = TrackProfile(
        key = "k",
        durationMs = 200_000L,
        sampleRate = 44_100,
        beatGrid = BeatGrid(bpm = 120f, phaseMs = 0L, confidence = confidence),
        tier = AnalysisTier.DSP,
    )

    @Test
    fun `占位实现自称已安装但不算分析`() {
        val passthrough = PassthroughEnhancer(sizeBytes = 1024L)
        assertTrue(passthrough.installed)
        assertFalse(passthrough.producesAnalysis)
    }

    @Test
    fun `占位实现原样交回档案，不抬高拍点置信度`() {
        val base = profile(confidence = 0.5f)
        val enhanced = PassthroughEnhancer(sizeBytes = 1024L).enhance(base)
        assertEquals(0.5f, enhanced.beatGrid?.confidence ?: -1f, 0.0001f)
        assertEquals(base, enhanced)
    }

    @Test
    fun `真实增强包默认声明会产生分析`() {
        val real = object : EnhancerPack {
            override val installed = true
            override val sizeBytes = 1024L
            override fun enhance(base: TrackProfile): TrackProfile? = base
        }
        assertTrue(real.producesAnalysis)
    }

    @Test
    fun `绑定占位实现时当前包不声称产生分析`() {
        OptionalModelEnhancer.bind(PassthroughEnhancer(sizeBytes = 1024L))
        try {
            assertEquals(false, OptionalModelEnhancer.current()?.producesAnalysis)
        } finally {
            OptionalModelEnhancer.bind(null)
        }
    }

    @Test
    fun `解绑后没有当前增强包`() {
        OptionalModelEnhancer.bind(null)
        assertEquals(null, OptionalModelEnhancer.current())
    }
}
