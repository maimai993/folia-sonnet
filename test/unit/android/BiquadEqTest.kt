package top.izuna.foliamajor.player.dsp

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin

// test/unit/android/BiquadEqTest.kt
// 原生 DSP 的回归：频响、旁通、动态、混响。跑 `./gradlew testDebugUnitTest`。
//
// 这些用例只碰纯 Kotlin 的三件（Biquad / Dynamics / Reverb），不加载 media3 —— 处理器壳
// 与 AudioSink 的接线只能在真机上验（见方案里的真机清单）。

class BiquadEqTest {

    private val sampleRate = 48000

    /** 用正弦测某个频点的稳态增益（dB）：取后半段，避开起始瞬态。 */
    private fun measureGainDb(
        filter: BiquadFilter,
        frequency: Double,
        amplitude: Double = 0.25,
    ): Double {
        val total = sampleRate
        val start = total / 2
        var inputEnergy = 0.0
        var outputEnergy = 0.0
        for (index in 0 until total) {
            val sample = (amplitude * sin(2.0 * PI * frequency * index / sampleRate)).toFloat()
            val out = filter.process(sample, 0)
            if (index >= start) {
                inputEnergy += sample.toDouble() * sample
                outputEnergy += out.toDouble() * out
            }
        }
        return 10.0 * kotlin.math.log10(outputEnergy / inputEnergy)
    }

    @Test
    fun `增益为 0 的段是恒等变换`() {
        val filter = BiquadFilter()
        filter.setPeaking(sampleRate, 1000f, 1.4f, 0f)
        assertTrue(!filter.active)
        for (index in 0 until 64) {
            val sample = index / 64f - 0.5f
            assertEquals(sample, filter.process(sample, 0), 0f)
        }
    }

    @Test
    fun `peaking 段在中心频率给出标称增益`() {
        val filter = BiquadFilter()
        filter.setPeaking(sampleRate, 1000f, 1.4f, 6f)
        assertTrue(filter.active)
        val gain = measureGainDb(filter, 1000.0)
        // Q=1.4 时中心频点的稳态增益就是标称值；留 0.3 dB 给测量窗口与数值误差。
        assertEquals(6.0, gain, 0.3)
    }

    @Test
    fun `lowshelf 只抬低频不抬中高频`() {
        // 搁架的转折点在 f0：那里是标称增益的**一半**（9 dB → 4.5 dB），满量还要往更低频走。
        // Web Audio 的 lowshelf 是同一形状，所以这里断言的是「转折点 = 半量」而不是 9 dB。
        val atCorner = BiquadFilter()
        atCorner.setLowShelf(sampleRate, 31f, 9f)
        val cornerGain = measureGainDb(atCorner, 31.0)

        val atHigh = BiquadFilter()
        atHigh.setLowShelf(sampleRate, 31f, 9f)
        val highGain = measureGainDb(atHigh, 4000.0)

        assertEquals(4.5, cornerGain, 0.6)
        assertEquals(0.0, highGain, 0.3)
        assertTrue("低频提升必须明显高于中高频", cornerGain > highGain + 3.0)
    }

    @Test
    fun `高通与低通在中性值上旁通`() {
        val highPass = BiquadFilter()
        highPass.setHighPass(sampleRate, 20f, 0.7f)
        assertTrue(!highPass.active)

        val lowPass = BiquadFilter()
        lowPass.setLowPass(sampleRate, 20000f, 0.7f)
        assertTrue(!lowPass.active)
    }

    @Test
    fun `punch 为 0 时动态段原样通过`() {
        val stage = DynamicsStage()
        stage.configure(sampleRate, 128)
        val buffer = FloatArray(256) { index ->
            (0.3 * sin(2.0 * PI * 220.0 * index / sampleRate)).toFloat()
        }
        val expected = buffer.copyOf()
        stage.processPunch(buffer, 0, 128, 2, punch = 0f, preGain = 1f)
        for (index in 0 until 256) {
            assertEquals(expected[index], buffer[index], 1e-6f)
        }
    }

    @Test
    fun `punch 压得住响的信号也留得住轻的信号`() {
        val loudBlock = FloatArray(256) { index ->
            (0.8 * sin(2.0 * PI * 220.0 * index / sampleRate)).toFloat()
        }
        val quietBlock = FloatArray(256) { index ->
            (0.02 * sin(2.0 * PI * 220.0 * index / sampleRate)).toFloat()
        }

        // 8 ms 的 attack ≈ 3 个块：一块之内只压下去一点，稳态要看十几块之后。
        val loudStage = DynamicsStage()
        loudStage.configure(sampleRate, 128)
        var loudPeak = 0f
        repeat(20) {
            val buffer = loudBlock.copyOf()
            loudStage.processPunch(buffer, 0, 128, 2, punch = 1f, preGain = 1f)
            loudPeak = peak(buffer)
        }

        val quietStage = DynamicsStage()
        quietStage.configure(sampleRate, 128)
        var quietPeak = 0f
        repeat(20) {
            val buffer = quietBlock.copyOf()
            quietStage.processPunch(buffer, 0, 128, 2, punch = 1f, preGain = 1f)
            quietPeak = peak(buffer)
        }

        assertTrue("响的信号必须被压到三成以下，实际 $loudPeak", loudPeak < 0.24f)
        // 远低于阈值：只受 makeup（+3 dB）影响，不该被压。
        assertTrue("轻的信号不该被压掉，实际 $quietPeak", quietPeak > 0.02f * 0.9f)
    }

    @Test
    fun `punch 段不负责限幅`() {
        // 限幅是整条链末端 LookaheadLimiter 的事（见 AudioQualityTest）：它必须在多段压缩、
        // 后置 EQ、混响之后。这一条守着「别把限幅偷偷塞回 punch」—— 塞回去的话，
        // 后级再加的增益就没人兜了。
        val stage = DynamicsStage()
        stage.configure(sampleRate, 128)
        val hot = FloatArray(256) { 3.5f }
        stage.processPunch(hot, 0, 128, 2, punch = 0f, preGain = 1f)
        assertEquals(3.5f, peak(hot), 1e-6f)
    }

    @Test
    fun `混响在脉冲之后留下尾巴`() {
        val stage = ReverbStage()
        stage.configure(sampleRate, 2)
        val frames = 8192
        val buffer = FloatArray(frames * 2)
        buffer[0] = 0.5f
        buffer[1] = 0.5f
        stage.process(buffer, 0, frames, 2, 1f, ReverbSettings.NEUTRAL)

        var tail = 0.0
        for (index in 4000 until frames) {
            tail += abs(buffer[index * 2].toDouble())
        }
        assertTrue("湿声必须还在响，实际能量 $tail", tail > 0.01)
    }

    @Test
    fun `设置解析会夹紧越界值并补齐缺项`() {
        val json = JSONObject().apply {
            put("version", 1)
            put("enabled", true)
            put("gains", org.json.JSONArray("[99,-99,3]"))
            put("effects", JSONObject().put("punch", 5.0).put("space", -2.0))
        }
        val settings = EqSettings.fromJson(json)
        assertEquals(EqSettings.fromJson(json).version, 1)
        assertEquals(10, settings.gains.size)
        assertEquals(12f, settings.gains[0], 0f)
        assertEquals(-12f, settings.gains[1], 0f)
        assertEquals(3f, settings.gains[2], 0f)
        assertEquals(0f, settings.gains[9], 0f)
        assertEquals(1f, settings.punch, 0f)
        assertEquals(0f, settings.space, 0f)
        // 缺项按中性值补齐，不是 0 Hz。
        assertEquals(20f, settings.highpassHz, 0f)
        assertEquals(20000f, settings.lowpassHz, 0f)
    }

    private fun peak(buffer: FloatArray): Float {
        var value = 0f
        for (sample in buffer) {
            val magnitude = abs(sample)
            if (magnitude > value) value = magnitude
        }
        return value
    }
}
