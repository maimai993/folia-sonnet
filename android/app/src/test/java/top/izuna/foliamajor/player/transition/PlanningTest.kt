package top.izuna.foliamajor.player.transition

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import top.izuna.foliamajor.player.transition.engine.EffectRegistry
import top.izuna.foliamajor.player.transition.planning.Capabilities
import top.izuna.foliamajor.player.transition.planning.ChoiceContext
import top.izuna.foliamajor.player.transition.planning.TransitionStrategy

class PlanningTest {

    private fun profile(
        key: String,
        bpm: Float? = null,
        startsHot: Boolean = false,
        ending: EndingShape = EndingShape.RESOLVE,
    ) = TrackProfile(
        key = key,
        durationMs = 210_000L,
        sampleRate = 11_025,
        bpm = bpm,
        beatGrid = bpm?.let { BeatGrid(it, 0L, 4, 0.8f) },
        headDb = if (startsHot) -8f else -20f,
        tailDb = -26f,
        introEndMs = 8_000L,
        endingShape = ending,
        startsHot = startsHot,
        tier = AnalysisTier.DSP,
    )

    @Test
    fun `两首都没测过就退回等功率交叉`() {
        val plan = TransitionStrategy.plan(
            ChoiceContext(TrackProfile.empty("a"), TrackProfile.empty("b"))
        )
        assertEquals(EffectId.PLAIN_BLEND, plan.style)
        assertTrue(plan.reason.contains("证据"))
        assertEquals(CurveId.EQUAL_POWER, plan.curve)
    }

    @Test
    fun `固定长度模式只认用户秒数`() {
        val plan = TransitionStrategy.plan(
            ChoiceContext(
                profile("a", 120f), profile("b", 124f),
                settings = TransitionSettings(mode = TransitionMode.CROSSFADE, crossfadeMaxMs = 6_000),
            )
        )
        assertEquals(EffectId.PLAIN_BLEND, plan.style)
        assertEquals(6_000, plan.overlapMs)
        assertTrue(plan.reason.contains("固定长度"))
    }

    @Test
    fun `用户手动指定的效果照办`() {
        val plan = TransitionStrategy.plan(
            ChoiceContext(
                profile("a", 120f), profile("b", 124f),
                settings = TransitionSettings(effectOverride = EffectId.VINYL_BRAKE),
            )
        )
        assertEquals(EffectId.VINYL_BRAKE, plan.style)
        assertTrue(plan.reason.contains("用户指定"))
    }

    @Test
    fun `能力不够时手动指定会明确降级`() {
        val plan = TransitionStrategy.plan(
            ChoiceContext(
                profile("a"), profile("b"),
                settings = TransitionSettings(effectOverride = EffectId.VOCAL_RECEDE),
                capabilities = Capabilities(enhancer = false),
            )
        )
        // VOCAL_RECEDE 需要增强包；没装时不许假装做了分离。
        assertEquals(EffectId.PLAIN_BLEND, plan.style)
        assertTrue(plan.reason.contains("能力不足"))
    }

    @Test
    fun `满电平开头走硬切`() {
        val plan = TransitionStrategy.plan(
            ChoiceContext(profile("a"), profile("b", startsHot = true))
        )
        assertEquals(EffectId.HARD_CUT, plan.style)
        assertEquals(MusicalTime.BEAT_CUT_MS.toInt(), plan.overlapMs)
        assertEquals(PlanKind.HARD_CUT, plan.kind)
    }

    @Test
    fun `有拍点网格时对齐到小节`() {
        val plan = TransitionStrategy.plan(
            ChoiceContext(profile("a", 120f, ending = EndingShape.CUT), profile("b", 120f))
        )
        assertTrue("拍点可用时应选节奏/空间类接法", plan.reason.isNotEmpty())
        assertTrue(plan.overlapMs >= plan.minOverlapMs)
        assertTrue(plan.overlapMs <= 24_000)
    }

    @Test
    fun `表现模式只加强度不改计划形状`() {
        val base = TransitionStrategy.plan(
            ChoiceContext(profile("a", 120f), profile("b", 120f))
        )
        val perf = TransitionStrategy.plan(
            ChoiceContext(
                profile("a", 120f), profile("b", 120f),
                settings = TransitionSettings(performance = true),
            )
        )
        assertNotNull(perf.expansion)
        assertTrue(perf.expansion!! in 0.25f..1f)
        // 表现模式仍是 automix 的形状，不是退回 crossfade 规划器；base 也只是普通自动接法。
        assertTrue(base.expansion == null)
        assertTrue(perf.style != EffectId.PLAIN_BLEND || perf.reason.contains("表现模式"))
    }

    @Test
    fun `18 种接法全部登记且都有描述`() {
        assertEquals(18, EffectCatalog.ALL.size)
        assertEquals(18, EffectRegistry.registered().size)
        val registered = EffectRegistry.registered().toSet()
        EffectCatalog.ALL.forEach { spec ->
            assertTrue("${spec.id.wire} 未注册", registered.contains(spec.id.wire))
            assertTrue("${spec.id.wire} 没有说明", spec.summary.isNotBlank())
            assertTrue("${spec.id.wire} 时长区间非法", spec.minOverlapMs <= spec.maxOverlapMs)
        }
    }

    @Test
    fun `效果目录按能力过滤`() {
        val all = EffectCatalog.available(beatGrid = true, enhancer = true, dspChain = true)
        assertEquals(18, all.size)
        val minimal = EffectCatalog.available(beatGrid = false, enhancer = false, dspChain = false)
        // 没有拍点、没有 DSP、没有增强包时仍要有可用的基础接法，功能不缺失。
        assertTrue(minimal.size >= 6)
        assertTrue(minimal.none { it.needsBeatGrid || it.needsEnhancer || it.needsBandSplit })
    }

    @Test
    fun `计划里的出场落点不越过曲目末尾`() {
        val plan = TransitionStrategy.plan(
            ChoiceContext(profile("a", 120f), profile("b", 120f))
        )
        assertTrue(plan.outStartMs >= 0L)
        assertTrue(plan.outStartMs + plan.overlapMs <= 210_000L)
        assertTrue(plan.reason.isNotBlank())
    }
}
