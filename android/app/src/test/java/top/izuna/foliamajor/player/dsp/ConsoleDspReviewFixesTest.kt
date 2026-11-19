package top.izuna.foliamajor.player.dsp

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * 针对调音台独立审查（Round 1）1 High + 4 Medium 中的原生侧问题（#1/#2/#3）的回归测试。
 */
class ConsoleDspReviewFixesTest {

    @Test
    fun `EqSettings fromJson rejects NaN and Infinity strings and produces valid toJson`() {
        val raw = JSONObject(
            """
            {
              "enabled": true,
              "stereo": { "enabled": true, "width": "NaN", "crossfeed": "Infinity", "rotation": "-Infinity" },
              "reverb": { "enabled": true, "rt60": "NaN", "mix": "NaN" },
              "mastering": {
                "bassBoost": { "enabled": true, "gainDb": "NaN", "frequencyHz": "Infinity" },
                "transient": { "enabled": true, "amount": "NaN" },
                "studio": {
                  "normalize": { "enabled": true, "targetLufs": "NaN", "truePeak": true },
                  "restore": { "hum": true, "amount": "NaN" }
                }
              }
            }
            """.trimIndent(),
        )

        val settings = EqSettings.fromJson(raw)
        assertTrue(settings.stereo.width.isFinite())
        assertTrue(settings.stereo.crossfeed.isFinite())
        assertTrue(settings.stereo.rotation.isFinite())
        assertTrue(settings.reverb.rt60Seconds.isFinite())
        assertTrue(settings.mastering.bassBoost.gainDb.isFinite())
        assertTrue(settings.mastering.transient.amount.isFinite())
        assertTrue(settings.mastering.studio.normalize.targetLufs.isFinite())
        assertTrue(settings.mastering.studio.restore.amount.isFinite())

        assertEquals(1f, settings.stereo.width, 1e-4f)
        assertEquals(0f, settings.stereo.crossfeed, 1e-4f)
        assertEquals(2.2f, settings.reverb.rt60Seconds, 1e-4f)
        assertEquals(-14f, settings.mastering.studio.normalize.targetLufs, 1e-4f)

        // 模拟 Android org.json 对 "NaN"/"Infinity" 返回非有限 double 的行为，直接覆盖 EqSettings.number()。
        val nanStereo = object : JSONObject() {
            override fun optBoolean(name: String?, fallback: Boolean): Boolean =
                if (name == "enabled") true else fallback

            override fun optDouble(name: String?, fallback: Double): Double = when (name) {
                "width" -> Double.NaN
                "crossfeed" -> Double.POSITIVE_INFINITY
                "rotation" -> Double.NEGATIVE_INFINITY
                else -> fallback
            }
        }
        val nanRoot = JSONObject().put("enabled", true).put("stereo", nanStereo)
        val fromNan = EqSettings.fromJson(nanRoot)
        assertEquals(1f, fromNan.stereo.width, 1e-4f)
        assertEquals(0f, fromNan.stereo.crossfeed, 1e-4f)
        assertEquals(0f, fromNan.stereo.rotation, 1e-4f)
        assertFalse(fromNan.toJson().toString().contains("NaN"))

        // toJson() 不得因 NaN 抛 JSONException。
        val serialized = settings.toJson()
        assertFalse(serialized.toString().contains("NaN"))
    }

    @Test
    fun `LookaheadLimiter sanitizes NaN and Infinity samples and properties without crashing Pcm16Codec`() {
        val limiter = LookaheadLimiter()
        limiter.configure(48_000, 2)
        limiter.ceiling = Float.NaN
        limiter.releaseSeconds = Float.POSITIVE_INFINITY
        assertTrue(limiter.ceiling.isFinite())
        assertTrue(limiter.releaseSeconds.isFinite())

        val frames = 512
        val buf = FloatArray(frames * 2) { 0.25f }
        buf[10] = Float.NaN
        buf[11] = Float.POSITIVE_INFINITY
        buf[12] = Float.NEGATIVE_INFINITY

        // 处理两块以冲出前瞻延迟线中的异常样本。
        limiter.process(buf, 0, frames, 2)
        val flush = FloatArray(frames * 2) { 0.25f }
        limiter.process(flush, 0, frames, 2)

        for (sample in buf) assertTrue("buf sample not finite: $sample", sample.isFinite() && abs(sample) <= 1f)
        for (sample in flush) assertTrue("flush sample not finite: $sample", sample.isFinite() && abs(sample) <= 1f)

        // Pcm16Codec.encode 不得因 NaN 抛 IllegalArgumentException。
        val codec = Pcm16Codec()
        val out = ByteBuffer.allocate(flush.size * 2)
        codec.encode(flush, flush.size, out)
        assertEquals(flush.size * 2, out.position())
    }

    @Test
    fun `StudioStage resets normalize state when disabled while another studio submodule stays active`() {
        val stage = StudioStage()
        stage.configure(48_000, 2)

        val quietWithNorm = StudioSettings(
            normalize = NormalizeSettings(enabled = true, targetLufs = -9f, truePeak = false),
            restore = RestoreSettings(hum = true, amount = 0.5f),
        )
        // 用极小信号把 normGain 拉高到接近上限 2.2x。
        val warmup = FloatArray(48_000 * 2) { 0.01f }
        stage.process(warmup, 0, 48_000, 2, quietWithNorm)

        // 仅关闭 normalize（hum 保持开启，StudioStage 整体仍非中性），运行一块。
        val humOnly = StudioSettings(
            normalize = NormalizeSettings(enabled = false),
            restore = RestoreSettings(hum = true, amount = 0.5f),
        )
        stage.process(FloatArray(256 * 2) { 0.1f }, 0, 256, 2, humOnly)

        // 重新开启 normalize：首样本应当从中性增益 1.0 起步，而非沿用过期的高增益（~2.2x）。
        val freshSample = FloatArray(64 * 2) { 0.2f }
        stage.process(freshSample, 0, 64, 2, quietWithNorm)
        val firstGain = freshSample[0] / 0.2f
        assertTrue("expected fresh normalize gain near 1.0, got $firstGain", firstGain < 1.3f)
    }

    @Test
    fun `MasteringStage resets noiseGate state when disabled while bassBoost stays active`() {
        val stage = MasteringStage()
        stage.configure(48_000, 2)

        val gateAndBass = MasteringSettings(
            noiseGate = NoiseGateSettings(enabled = true, thresholdDb = -20f, attackMs = 1f, releaseMs = 500f, reductionDb = -24f),
            bassBoost = BassBoostSettings(enabled = true, gainDb = 0.5f, frequencyHz = 90f),
        )
        // 静音段把 gateGain 压到底（-24 dB ≈ 0.063）。
        stage.process(FloatArray(48_000 * 2) { 0.0001f }, 0, 48_000, 2, gateAndBass)

        // 关闭 noiseGate，bassBoost 保持开启。
        val bassOnly = MasteringSettings(
            noiseGate = NoiseGateSettings(enabled = false),
            bassBoost = BassBoostSettings(enabled = true, gainDb = 0.5f, frequencyHz = 90f),
        )
        stage.process(FloatArray(256 * 2) { 0.2f }, 0, 256, 2, bassOnly)

        // 重新打开 noiseGate：传入远超门限的信号，首样本不应被残留 -24 dB 门控压扁。
        val loud = FloatArray(32 * 2) { 0.4f }
        stage.process(loud, 0, 32, 2, gateAndBass)
        assertTrue("expected first loud sample near 0.4 after gate reset, got ${loud[0]}", abs(loud[0]) > 0.25f)
    }

    @Test
    fun `StereoStage crossfeed preserves mono low-frequency unity gain while feeding opposite channel on hard pan`() {
        val sr = 48_000
        val frames = sr // 1 秒
        val settings = StereoSettings(enabled = true, width = 1f, bassMonoHz = 0f, crossfeed = 1f, rotation = 0f)

        fun runSine(freqHz: Double, leftAmp: Float, rightAmp: Float): Pair<Double, Double> {
            val stage = StereoStage()
            stage.configure(sr)
            val buf = FloatArray(frames * 2)
            for (i in 0 until frames) {
                val s = sin(2.0 * PI * freqHz * i / sr).toFloat()
                buf[i * 2] = s * leftAmp
                buf[i * 2 + 1] = s * rightAmp
            }
            stage.process(buf, 0, frames, 2, settings)
            // 取后半秒稳态 RMS
            var sumL = 0.0
            var sumR = 0.0
            val start = frames / 2
            val count = frames - start
            for (i in start until frames) {
                val l = buf[i * 2].toDouble()
                val r = buf[i * 2 + 1].toDouble()
                sumL += l * l
                sumR += r * r
            }
            return Pair(sqrt(sumL / count), sqrt(sumR / count))
        }

        val inputRms = 0.25 / sqrt(2.0)

        // 1) 单声道 100 Hz / 200 Hz 低频：不得出现原 +5.1 dB 膨胀（0.3 ms ITD 带来物理相位差，100 Hz 保持 ±0.5 dB、200 Hz 保持 ±1.0 dB 内）。
        val (mono100L, mono100R) = runSine(100.0, 0.25f, 0.25f)
        val mono100Db = 20.0 * log10(mono100L / inputRms)
        assertTrue("mono 100 Hz gain drift too large: $mono100Db dB", abs(mono100Db) < 0.5)
        assertEquals(mono100L, mono100R, 1e-4)

        val (monoLowL, monoLowR) = runSine(200.0, 0.25f, 0.25f)
        val monoLowDb = 20.0 * log10(monoLowL / inputRms)
        assertTrue("mono 200 Hz gain drift too large: $monoLowDb dB", abs(monoLowDb) < 1.0)
        assertEquals(monoLowL, monoLowR, 1e-4)

        // 2) 单声道 4000 Hz 高频：不得因全局衰减变闷，应保持 ±0.5 dB 内。
        val (monoHighL, _) = runSine(4000.0, 0.25f, 0.25f)
        val monoHighDb = 20.0 * log10(monoHighL / inputRms)
        assertTrue("mono 4000 Hz gain drift too large: $monoHighDb dB", abs(monoHighDb) < 0.5)

        // 3) 极左 300 Hz：右声道应收到明显低频交叉馈送。
        val (panL, panR) = runSine(300.0, 0.25f, 0f)
        assertTrue("expected crossfeed into R on hard-left 300 Hz, got panR=$panR panL=$panL", panR > panL * 0.4)
    }
}
