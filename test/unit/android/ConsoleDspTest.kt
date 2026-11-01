package top.izuna.foliamajor.player.dsp

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sin
import kotlin.math.sqrt

// test/unit/android/ConsoleDspTest.kt
// 调音台新增四块的回归：四段压缩、后置均衡、频谱、混响参数。
//
// 与 BiquadEqTest 分开是怕一个文件越滚越长（仓库单文件 800 行的门禁）。
// 这些用例同样只碰纯 Kotlin，不加载 media3。

class ConsoleDspTest {

    private val sampleRate = 48000

    private fun tone(frequency: Double, frames: Int, amplitude: Double = 0.3): FloatArray = FloatArray(frames) {
        (amplitude * sin(2.0 * PI * frequency * it / sampleRate)).toFloat()
    }

    private fun rms(buffer: FloatArray, from: Int): Double {
        var sum = 0.0
        for (index in from until buffer.size) sum += buffer[index].toDouble() * buffer[index]
        return sqrt(sum / (buffer.size - from))
    }

    private fun gainDb(out: FloatArray, ref: FloatArray): Double = 20.0 * log10(rms(out, 9600) / rms(ref, 9600))

    /** 按 128 帧一块把整段跑完，与 EqAudioProcessor 的调用方式一致。 */
    private fun runCompressor(buffer: FloatArray, channels: Int, settings: CompressorSettings) {
        val stage = MultibandCompressor()
        stage.configure(sampleRate)
        var frame = 0
        while (frame < buffer.size / channels) {
            val block = minOf(128, buffer.size / channels - frame)
            stage.process(buffer, frame * channels, block, channels, settings)
            frame += block
        }
    }

    @Test
    fun `四段分频在不压缩时是平的`() {
        val settings = CompressorSettings(
            enabled = true,
            bandCount = 4,
            profile = CompressorProfile.FLAT,
            bands = Array(4) { CompressorBand(enabled = false, ratio = 1f) },
        )
        // 分频点附近最容易被切出坑：250 / 2000 / 8000 各取一个，外加两端。
        for (frequency in intArrayOf(80, 250, 1000, 2000, 8000, 12000)) {
            val signal = tone(frequency.toDouble(), sampleRate)
            val reference = signal.copyOf()
            runCompressor(signal, 1, settings)
            val gain = gainDb(signal, reference)
            // LR4 三级级联的求和不是数学上完美的全通，实测最差处约 -0.6 dB。
            assertTrue("$frequency Hz 处的分频求和偏差过大：$gain dB", abs(gain) < 0.9)
        }
    }

    @Test
    fun `压缩只压触发阈值的那一段`() {
        val settings = CompressorSettings(
            enabled = true,
            bandCount = 4,
            profile = CompressorProfile.FLAT,
            bands = Array(4) {
                CompressorBand(enabled = true, thresholdDb = -20f, ratio = 4f, attackMs = 2f, releaseMs = 50f, makeupDb = 0f)
            },
        )
        // 0.5 幅度 ≈ -6 dBFS，超出阈值 14 dB，4:1 应压掉 10.5 dB。
        val signal = tone(80.0, sampleRate, 0.5)
        val reference = signal.copyOf()
        runCompressor(signal, 1, settings)
        val gain = gainDb(signal, reference)
        assertEquals(-10.5, gain, 1.2)
    }

    @Test
    fun `后置均衡的十段与总增益叠在一起`() {
        val eq = TenBandEq()
        eq.configure(sampleRate)
        val gains = FloatArray(EQ_BAND_COUNT)
        gains[5] = 6f
        eq.update(gains, EqCurveMode.GEQ, EQ_BAND_Q, 3f)

        val signal = tone(1000.0, sampleRate)
        val reference = signal.copyOf()
        var frame = 0
        while (frame < sampleRate) {
            val block = minOf(128, sampleRate - frame)
            eq.process(signal, frame, block, 1)
            frame += block
        }
        // 1 kHz 的钟形 +6 dB 叠上总增益 +3 dB。
        assertEquals(9.0, gainDb(signal, reference), 0.4)
    }

    @Test
    fun `PEQ 的窄 Q 不碰远处的频段`() {
        val eq = TenBandEq()
        eq.configure(sampleRate)
        val gains = FloatArray(EQ_BAND_COUNT)
        gains[5] = 12f
        eq.update(gains, EqCurveMode.PEQ, 8f, 0f)

        val far = tone(4000.0, sampleRate)
        val reference = far.copyOf()
        var frame = 0
        while (frame < sampleRate) {
            val block = minOf(128, sampleRate - frame)
            eq.process(far, frame, block, 1)
            frame += block
        }
        assertTrue("Q=8 时 1 kHz 的提升不该明显改到 4 kHz，实际 ${gainDb(far, reference)} dB", abs(gainDb(far, reference)) < 1.5)
    }

    @Test
    fun `频谱的峰值落在输入频率上`() {
        val analyzer = SpectrumAnalyzer()
        analyzer.configure(sampleRate)
        val signal = tone(1000.0, 8192, 0.5)
        var frame = 0
        while (frame < 8192) {
            val block = minOf(128, 8192 - frame)
            analyzer.push(signal, frame, block, 1)
            frame += block
        }
        val peakBand = analyzer.bands.indices.maxByOrNull { analyzer.bands[it] } ?: -1
        // 32 段对数分布，每段约 1/3 倍频程：1 kHz 落在 17~19 之间。
        assertTrue("1 kHz 的峰值应落在 17~19 段，实际 $peakBand", peakBand in 17..19)
        assertTrue("峰值不能是 0", analyzer.bands[peakBand] > 0.2f)
    }

    @Test
    fun `RT60 越长尾巴越久`() {
        fun tailEnergy(rt60: Float): Double {
            val stage = ReverbStage()
            stage.configure(sampleRate, 1)
            val frames = sampleRate * 2
            val buffer = FloatArray(frames)
            buffer[0] = 0.9f
            val settings = ReverbSettings(enabled = true, rt60Seconds = rt60, roomLevelDb = 0f)
            stage.process(buffer, 0, frames, 1, 0f, settings)
            // 第 1.5 秒附近的能量：短尾巴到这里已经没了。
            var sum = 0.0
            for (index in (sampleRate * 1.4).toInt() until (sampleRate * 1.6).toInt()) sum += abs(buffer[index]).toDouble()
            return sum
        }
        val short = tailEnergy(0.6f)
        val long = tailEnergy(3.5f)
        assertTrue("3.5 s 的尾巴在 1.5 s 处必须比 0.6 s 的更响：$short vs $long", long > short * 2)
    }

    @Test
    fun `v2 载荷解析出压缩器与混响`() {
        val json = JSONObject(
            """
            {
              "version": 2,
              "enabled": true,
              "gains": [1,0,0,0,0,0,0,0,0,0],
              "eq": { "mode": "peq", "q": 2.5, "globalGainDb": -3 },
              "reverb": { "enabled": true, "preset": 2, "rt60": 4.5, "roomLevelDb": -6, "tailOnPause": false },
              "compressor": {
                "enabled": true, "bandCount": 2, "profile": 1,
                "bands": [
                  { "enabled": true, "thresholdDb": -30, "ratio": 5, "attackMs": 1, "releaseMs": 20 },
                  { "enabled": false }
                ]
              },
              "postEq": { "enabled": true, "gains": [0,0,0,0,0,4,0,0,0,0], "mode": "geq", "globalGainDb": 1.5 }
            }
            """.trimIndent(),
        )
        val settings = EqSettings.fromJson(json)
        assertEquals(EqCurveMode.PEQ, settings.mode)
        assertEquals(2.5f, settings.q, 0f)
        assertEquals(-3f, settings.globalGainDb, 0f)
        assertTrue(settings.reverb.enabled)
        assertEquals(ReverbPreset.CATHEDRAL, settings.reverb.preset)
        assertEquals(4.5f, settings.reverb.rt60Seconds, 0f)
        assertEquals(false, settings.reverb.tailOnPause)
        assertTrue(settings.compressor.enabled)
        assertEquals(2, settings.compressor.bandCount)
        assertEquals(CompressorProfile.FLAT, settings.compressor.profile)
        assertEquals(-30f, settings.compressor.bands[0].thresholdDb, 0f)
        assertEquals(5f, settings.compressor.bands[0].ratio, 0f)
        assertTrue(!settings.compressor.bands[1].enabled)
        assertTrue(settings.postEq.enabled)
        assertEquals(4f, settings.postEq.gains[5], 0f)
        assertEquals(1.5f, settings.postEq.globalGainDb, 0f)
    }

    @Test
    fun `v1 载荷的缺项按中性补齐`() {
        val json = JSONObject("""{"version":1,"enabled":true,"gains":[3,0,0,0,0,0,0,0,0,0]}""")
        val settings = EqSettings.fromJson(json)
        assertEquals(EqCurveMode.GEQ, settings.mode)
        assertEquals(0.85f, settings.q, 0f)
        assertTrue(!settings.reverb.enabled)
        assertTrue(!settings.compressor.enabled)
        assertTrue(!settings.postEq.enabled)
        assertEquals(ReverbPreset.FACTORY, settings.reverb.preset)
        assertEquals(2.2f, settings.reverb.rt60Seconds, 0f)
    }

    @Test
    fun `整份设置往返一次不丢字段`() {
        // 冷启动恢复走的正是这条路：persist 写 toJson、restore 读 fromJson。
        // 中间任何一个字段掉队，用户重开 App 就会发现「压缩器自己关了」这种事，
        // 而且不会有任何报错 —— 所以这条断言比看起来重要。
        val source = JSONObject(
            """
            {
              "version": 2, "enabled": true, "glideMs": 250,
              "gains": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
              "eq": { "mode": "peq", "q": 2.5, "globalGainDb": -3 },
              "effects": { "punch": 0.4, "space": 0.25, "highpass": 30, "lowpass": 18000 },
              "reverb": { "enabled": true, "preset": 2, "rt60": 4.5, "roomLevelDb": -6, "tailOnPause": false },
              "compressor": {
                "enabled": true, "bandCount": 4, "profile": 1,
                "bands": [
                  { "enabled": true, "thresholdDb": -30, "ratio": 5, "attackMs": 1, "releaseMs": 20, "makeupDb": 2 },
                  { "enabled": false, "thresholdDb": -18, "ratio": 1.6, "attackMs": 8, "releaseMs": 80, "makeupDb": 0 },
                  { "enabled": true, "thresholdDb": -20, "ratio": 1.8, "attackMs": 3, "releaseMs": 50, "makeupDb": 1 },
                  { "enabled": true, "thresholdDb": -22, "ratio": 2, "attackMs": 2, "releaseMs": 40, "makeupDb": 0 }
                ]
              },
              "postEq": { "enabled": true, "gains": [0,0,0,0,0,4,0,0,0,0], "mode": "geq", "q": 1.2, "globalGainDb": 1.5 }
            }
            """.trimIndent(),
        )

        val first = EqSettings.fromJson(source)
        val second = EqSettings.fromJson(first.toJson())

        assertEquals(first.version, second.version)
        assertEquals(first.enabled, second.enabled)
        assertEquals(first.glideMs, second.glideMs)
        assertEquals(first.gains.toList(), second.gains.toList())
        assertEquals(first.mode, second.mode)
        assertEquals(first.q, second.q, 0f)
        assertEquals(first.globalGainDb, second.globalGainDb, 0f)
        assertEquals(first.punch, second.punch, 0f)
        assertEquals(first.space, second.space, 0f)
        assertEquals(first.highpassHz, second.highpassHz, 0f)
        assertEquals(first.lowpassHz, second.lowpassHz, 0f)

        assertEquals(first.reverb.enabled, second.reverb.enabled)
        assertEquals(first.reverb.preset, second.reverb.preset)
        assertEquals(first.reverb.rt60Seconds, second.reverb.rt60Seconds, 0f)
        assertEquals(first.reverb.roomLevelDb, second.reverb.roomLevelDb, 0f)
        assertEquals(first.reverb.tailOnPause, second.reverb.tailOnPause)

        assertEquals(first.compressor.enabled, second.compressor.enabled)
        assertEquals(first.compressor.bandCount, second.compressor.bandCount)
        assertEquals(first.compressor.profile, second.compressor.profile)
        for (index in 0 until CompressorSettings.COMPRESSOR_BAND_COUNT) {
            val expected = first.compressor.bands[index]
            val actual = second.compressor.bands[index]
            assertEquals(expected.enabled, actual.enabled)
            assertEquals(expected.thresholdDb, actual.thresholdDb, 0f)
            assertEquals(expected.ratio, actual.ratio, 0f)
            assertEquals(expected.attackMs, actual.attackMs, 0f)
            assertEquals(expected.releaseMs, actual.releaseMs, 0f)
            assertEquals(expected.makeupDb, actual.makeupDb, 0f)
        }

        assertEquals(first.postEq.enabled, second.postEq.enabled)
        assertEquals(first.postEq.gains.toList(), second.postEq.gains.toList())
        assertEquals(first.postEq.mode, second.postEq.mode)
        assertEquals(first.postEq.q, second.postEq.q, 0f)
        assertEquals(first.postEq.globalGainDb, second.postEq.globalGainDb, 0f)

        // 再写一次必须与第一次逐字节相同：说明读写两侧对字段集合的认知是一致的。
        assertEquals(first.toJson().toString(), second.toJson().toString())
    }

    @Test
    fun `全中性时整条链可以按字节直通`() {
        assertTrue(EqSettings.NEUTRAL.isFlat())
        val hot = EqSettings.fromJson(JSONObject("""{"version":2,"enabled":true,"gains":[0,0,0,0,0,0,0,0,0,0]}"""))
        assertTrue(hot.isFlat())
        val withCompressor = EqSettings.fromJson(
            JSONObject("""{"version":2,"enabled":true,"gains":[0,0,0,0,0,0,0,0,0,0],"compressor":{"enabled":true}}"""),
        )
        assertTrue(!withCompressor.isFlat())
    }
}
