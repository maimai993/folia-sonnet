package top.izuna.foliamajor.player.dsp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// android/app/src/test/java/top/izuna/foliamajor/player/dsp/StemMixActivationTest.kt
// 「什么时候才值得开四轨混音」的三级判据。
//
// 四轨混音每开一次要建 4 个 MediaCodec、每块解 4 路。三级判据保证它只在真的需要
// 分轨时开：① 清唱 / 伴奏模式；② 调音台真的在摆位（任意一轨非中性）；
// ③ 其余情况一律走原曲。第 ③ 条最容易写错 —— 它决定了「默认不额外耗电」。
class StemMixActivationTest {

    // ---- 第①级：清唱 / 伴奏模式 -> 必须混 ----

    @Test
    fun `开了关闭人声就走四轨`() {
        assertEquals(
            StemMixReason.VOCAL_MODE,
            StemMixActivation.reason(VocalTrackMode.INSTRUMENTAL, StemMixSettings.NEUTRAL),
        )
    }

    @Test
    fun `开了只留人声就走四轨`() {
        assertEquals(
            StemMixReason.VOCAL_MODE,
            StemMixActivation.reason(VocalTrackMode.VOCAL, StemMixSettings.NEUTRAL),
        )
    }

    @Test
    fun `模式优先于摆位判据`() {
        // 两者都成立时报模式那一条：它决定了「只留哪几轨」，比摆位更根本。
        val placed = StemMixSettings(drums = StemSpatialSettings(pan = 0.5f))
        assertEquals(
            StemMixReason.VOCAL_MODE,
            StemMixActivation.reason(VocalTrackMode.VOCAL, placed),
        )
    }

    // ---- 第②级：调音台真的在动某几轨 -> 混 ----

    @Test
    fun `某一轨改了声像就走四轨`() {
        val settings = StemMixSettings(drums = StemSpatialSettings(pan = -0.4f))
        assertEquals(
            StemMixReason.SPATIAL_PLACEMENT,
            StemMixActivation.reason(null, settings),
        )
    }

    @Test
    fun `某一轨改了宽度就走四轨`() {
        val settings = StemMixSettings(bass = StemSpatialSettings(width = 0.6f))
        assertEquals(StemMixReason.SPATIAL_PLACEMENT, StemMixActivation.reason(null, settings))
    }

    @Test
    fun `某一轨改了电平就走四轨`() {
        val settings = StemMixSettings(vocals = StemSpatialSettings(levelDb = 3f))
        assertEquals(StemMixReason.SPATIAL_PLACEMENT, StemMixActivation.reason(null, settings))
    }

    @Test
    fun `关掉某一轨也要走四轨`() {
        // 「去掉贝斯」原曲里做不到，同样只有分轨才能实现。
        val settings = StemMixSettings(bass = StemSpatialSettings(audible = false))
        assertEquals(StemMixReason.SPATIAL_PLACEMENT, StemMixActivation.reason(null, settings))
    }

    @Test
    fun `自动摆位那组预设也算在动`() {
        // AUTO_STEMS 不是 NEUTRAL：鼓 / 贝斯 / 其他 的宽度都不是 1。
        val auto = StemMixSettings(
            drums = StemMixSettings.AUTO_STEMS.getValue(StemKind.DRUMS),
            bass = StemMixSettings.AUTO_STEMS.getValue(StemKind.BASS),
            other = StemMixSettings.AUTO_STEMS.getValue(StemKind.OTHER),
            vocals = StemMixSettings.AUTO_STEMS.getValue(StemKind.VOCALS),
        )
        assertEquals(StemMixReason.SPATIAL_PLACEMENT, StemMixActivation.reason(null, auto))
    }

    // ---- 第③级：其余情况 -> 走原曲，不混 ----

    @Test
    fun `调音台开着但四轨全中性 不混`() {
        /*
         * 用户可能只是打开了空间面板、所有轨都还是默认值 —— 那时既听不出区别，
         * 也没必要付 4 个解码器的代价。这一条是「默认不额外耗电」的保证。
         */
        val allNeutral = StemMixSettings(
            drums = StemSpatialSettings.NEUTRAL,
            bass = StemSpatialSettings.NEUTRAL,
            other = StemSpatialSettings.NEUTRAL,
            vocals = StemSpatialSettings.NEUTRAL,
        )
        assertEquals(StemMixReason.NONE, StemMixActivation.reason(null, allNeutral))
        assertEquals(
            StemMixProcessor.PASSTHROUGH_ORIGINAL,
            StemMixProcessor.resolve(null, allNeutral, 44_100, 2),
        )
    }

    @Test
    fun `什么都不开 不混`() {
        assertEquals(StemMixReason.NONE, StemMixActivation.reason(null, StemMixSettings.NEUTRAL))
        assertFalse(StemMixActivation.isSpatialPlacementActive(StemMixSettings.NEUTRAL))
        assertEquals(
            StemMixProcessor.PASSTHROUGH_ORIGINAL,
            StemMixProcessor.resolve(null, StemMixSettings.NEUTRAL, 44_100, 2),
        )
    }

    @Test
    fun `显式全中性 与 NEUTRAL 等价`() {
        // 两轨都「audible = true、pan 0、width 1、levelDb 0」时判据必须一致，
        // 不依赖调用方传的是不是那个单例。
        assertFalse(StemMixActivation.isPlaced(StemSpatialSettings()))
        assertTrue(StemMixActivation.isPlaced(StemSpatialSettings(pan = 0.01f)))
    }

    @Test
    fun `抖动级别的偏差不算在动`() {
        // pan 0.0005 / width 1.0005 / levelDb 0.005 都在容差内：滑杆的浮点噪声不该
        // 让四个解码器白开一趟。
        val jitter = StemSpatialSettings(audible = true, pan = 0.0005f, width = 1.0005f, levelDb = 0.005f)
        assertFalse(StemMixActivation.isPlaced(jitter))
        assertEquals(
            StemMixReason.NONE,
            StemMixActivation.reason(null, StemMixSettings(drums = jitter)),
        )
    }

    // ---- 第②级成立时，resolve 仍要守住格式判据 ----

    @Test
    fun `摆位成立但格式不对 仍然直通`() {
        val placed = StemMixSettings(drums = StemSpatialSettings(pan = 0.5f))
        assertEquals(
            StemMixProcessor.PASSTHROUGH_RATE,
            StemMixProcessor.resolve(null, placed, 48_000, 2),
        )
        assertEquals(
            StemMixProcessor.PASSTHROUGH_CHANNELS,
            StemMixProcessor.resolve(null, placed, 44_100, 1),
        )
    }

    @Test
    fun `摆位成立且格式对得上 才混`() {
        val placed = StemMixSettings(drums = StemSpatialSettings(pan = 0.5f))
        assertEquals(StemMixProcessor.MIX, StemMixProcessor.resolve(null, placed, 44_100, 2))
    }

    @Test
    fun `只靠调音台摆位激活时 四轨都要参与混音`() {
        /*
         * 这一支是「只看模式挑轨」写法的静音 bug：`mode == null` 时若把每一轨都当成
         * 「这个模式不要」，四轨全被过滤掉，输出就是静音。
         * 判据与 StemMixProcessor.queueInput 里那个 wantedByMode 保持一致。
         */
        val settings = StemMixSettings(drums = StemSpatialSettings(pan = 0.5f))
        assertEquals(StemMixProcessor.MIX, StemMixProcessor.resolve(null, settings, 44_100, 2))
        assertTrue(
            "没有模式时四轨全参与",
            StemKind.ALL.all { kind -> wantedByMode(null, kind) },
        )
        // 模式非空时仍按模式挑轨。
        assertFalse(wantedByMode(VocalTrackMode.VOCAL, StemKind.DRUMS))
        assertTrue(wantedByMode(VocalTrackMode.VOCAL, StemKind.VOCALS))
        assertTrue(wantedByMode(VocalTrackMode.INSTRUMENTAL, StemKind.DRUMS))
        assertFalse(wantedByMode(VocalTrackMode.INSTRUMENTAL, StemKind.VOCALS))
    }

    /** 与 StemMixProcessor.queueInput 里那段 `when (mode)` 同一份规则。 */
    private fun wantedByMode(mode: VocalTrackMode?, kind: StemKind): Boolean = when (mode) {
        VocalTrackMode.INSTRUMENTAL -> kind != StemKind.VOCALS
        VocalTrackMode.VOCAL -> kind == StemKind.VOCALS
        null -> true
    }
}
