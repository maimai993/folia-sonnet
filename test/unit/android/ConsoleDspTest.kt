package top.izuna.foliamajor.player.dsp

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
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
    fun `软拐点越宽在阈值附近介入越早`() {
        // 幅度 0.126 ≈ -18 dBFS，阈值 -20，过载 2 dB —— 正好落在拐点区里。
        // 这也是软拐点唯一能被听出来的地方：远高于阈值时两条曲线都走直线，没有区别。
        fun compressedGain(kneeDb: Float): Double {
            val settings = CompressorSettings(
                enabled = true,
                bandCount = 4,
                profile = CompressorProfile.FLAT,
                bands = Array(4) {
                    CompressorBand(
                        enabled = true, thresholdDb = -20f, ratio = 4f,
                        attackMs = 1f, releaseMs = 30f, makeupDb = 0f, kneeDb = kneeDb,
                    )
                },
            )
            val signal = tone(80.0, sampleRate, 0.126)
            val reference = signal.copyOf()
            runCompressor(signal, 1, settings)
            return gainDb(signal, reference)
        }

        val hard = compressedGain(2f)
        val soft = compressedGain(18f)
        assertTrue("宽拐点应在阈值附近压得更多：硬 $hard dB vs 软 $soft dB", soft < hard - 0.5)
    }

    @Test
    fun `平行压缩按混合比减少压掉的量`() {
        fun compressedGain(mix: Float): Double {
            val settings = CompressorSettings(
                enabled = true,
                bandCount = 4,
                profile = CompressorProfile.FLAT,
                bands = Array(4) {
                    CompressorBand(
                        enabled = true, thresholdDb = -20f, ratio = 4f,
                        attackMs = 2f, releaseMs = 50f, makeupDb = 0f, kneeDb = 6f, mix = mix,
                    )
                },
            )
            val signal = tone(80.0, sampleRate, 0.5)
            val reference = signal.copyOf()
            runCompressor(signal, 1, settings)
            return gainDb(signal, reference)
        }

        val full = compressedGain(1f)
        val half = compressedGain(0.5f)
        // 增益在**线性域**插值：1 + (g - 1)·mix。全压 -10.5 dB（g = 0.30）时，
        // mix = 0.5 应落在 20·log10(0.65) ≈ -3.8 dB，而不是 dB 域的 -5.25。
        assertTrue("平行压缩必须比全压少压：$full dB vs $half dB", half > full + 3.0)
        assertEquals(-3.8, half, 0.8)
    }

    @Test
    fun `声场加宽只放大侧向分量`() {
        val stage = StereoStage()
        // 纯中置（左右相同）不该被改变：这是 M/S 与「左右加延时」的关键区别，
        // 也是单声道兼容性不塌的原因。
        val centred = floatArrayOf(0.4f, 0.4f)
        stage.process(centred, 0, 1, 2, StereoSettings(enabled = true, width = 2f))
        assertEquals(0.4f, centred[0], 1e-5f)
        assertEquals(0.4f, centred[1], 1e-5f)

        // 纯侧向（左右相反）加宽到 2 倍，幅度加倍。
        val sided = floatArrayOf(0.2f, -0.2f)
        stage.process(sided, 0, 1, 2, StereoSettings(enabled = true, width = 2f))
        assertEquals(0.4f, sided[0], 1e-5f)
        assertEquals(-0.4f, sided[1], 1e-5f)
    }

    @Test
    fun `声场宽度归零时折成单声道`() {
        val buffer = floatArrayOf(0.5f, -0.1f, 0.2f, 0.6f)
        StereoStage().process(buffer, 0, 2, 2, StereoSettings(enabled = true, width = 0f))
        // 每一帧的左右都变成原来的中点，且两声道相等。
        assertEquals(0.2f, buffer[0], 1e-5f)
        assertEquals(0.2f, buffer[1], 1e-5f)
        assertEquals(0.4f, buffer[2], 1e-5f)
        assertEquals(0.4f, buffer[3], 1e-5f)
    }

    @Test
    fun `声场关闭或宽度为一都不碰样本`() {
        val stage = StereoStage()
        val off = floatArrayOf(0.5f, -0.1f)
        stage.process(off, 0, 1, 2, StereoSettings(enabled = false, width = 2f))
        assertEquals(0.5f, off[0], 0f)
        assertEquals(-0.1f, off[1], 0f)

        val untouched = floatArrayOf(0.5f, -0.1f)
        stage.process(untouched, 0, 1, 2, StereoSettings(enabled = true, width = 1f))
        assertEquals(0.5f, untouched[0], 0f)
        assertEquals(-0.1f, untouched[1], 0f)
    }

    @Test
    fun `单声道输入直接跳过声场处理`() {
        val buffer = floatArrayOf(0.3f, -0.3f)
        StereoStage().process(buffer, 0, 2, 1, StereoSettings(enabled = true, width = 1.8f))
        assertEquals(0.3f, buffer[0], 0f)
        assertEquals(-0.3f, buffer[1], 0f)
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
              "reverb": { "enabled": true, "preset": 2, "rt60": 4.5, "roomLevelDb": -6, "damping": 0.34, "preDelayMs": 42, "mix": 0.65, "tailOnPause": false },
              "compressor": {
                "enabled": true, "bandCount": 4, "profile": 1,
                "crossovers": [180, 1800, 6500],
                "bands": [
                  { "enabled": true, "thresholdDb": -30, "ratio": 5, "attackMs": 1, "releaseMs": 20, "makeupDb": 2, "kneeDb": 12, "mix": 0.5 },
                  { "enabled": false, "thresholdDb": -18, "ratio": 1.6, "attackMs": 8, "releaseMs": 80, "makeupDb": 0, "kneeDb": 6, "mix": 1 },
                  { "enabled": true, "thresholdDb": -20, "ratio": 1.8, "attackMs": 3, "releaseMs": 50, "makeupDb": 1, "kneeDb": 4, "mix": 0.8 },
                  { "enabled": true, "thresholdDb": -22, "ratio": 2, "attackMs": 2, "releaseMs": 40, "makeupDb": 0, "kneeDb": 2, "mix": 1 }
                ]
              },
              "postEq": { "enabled": true, "gains": [0,0,0,0,0,4,0,0,0,0], "mode": "geq", "q": 1.2, "globalGainDb": 1.5 },
              "stereo": { "enabled": true, "width": 1.5, "bassMonoHz": 140 },
              "saturation": { "enabled": true, "mode": "tube", "driveDb": 14, "mix": 0.35, "outputDb": -8 },
              "limiter": { "ceilingDb": -1.2, "releaseMs": 260 }
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
        assertEquals(first.reverb.damping, second.reverb.damping, 1e-4f)
        assertEquals(first.reverb.preDelayMs, second.reverb.preDelayMs, 1e-4f)
        assertEquals(first.reverb.mix, second.reverb.mix, 1e-4f)
        assertEquals(first.reverb.tailOnPause, second.reverb.tailOnPause)

        assertEquals(first.compressor.enabled, second.compressor.enabled)
        assertEquals(first.compressor.bandCount, second.compressor.bandCount)
        assertEquals(first.compressor.profile, second.compressor.profile)
        assertEquals(first.compressor.crossovers.toList(), second.compressor.crossovers.toList())
        for (index in 0 until CompressorSettings.COMPRESSOR_BAND_COUNT) {
            val expected = first.compressor.bands[index]
            val actual = second.compressor.bands[index]
            assertEquals(expected.enabled, actual.enabled)
            assertEquals(expected.thresholdDb, actual.thresholdDb, 0f)
            assertEquals(expected.ratio, actual.ratio, 0f)
            assertEquals(expected.attackMs, actual.attackMs, 0f)
            assertEquals(expected.releaseMs, actual.releaseMs, 0f)
            assertEquals(expected.makeupDb, actual.makeupDb, 0f)
            assertEquals(expected.kneeDb, actual.kneeDb, 1e-4f)
            assertEquals(expected.mix, actual.mix, 1e-4f)
        }

        assertEquals(first.postEq.enabled, second.postEq.enabled)
        assertEquals(first.postEq.gains.toList(), second.postEq.gains.toList())
        assertEquals(first.postEq.mode, second.postEq.mode)
        assertEquals(first.postEq.q, second.postEq.q, 0f)
        assertEquals(first.postEq.globalGainDb, second.postEq.globalGainDb, 0f)

        assertEquals(first.stereo.enabled, second.stereo.enabled)
        assertEquals(first.stereo.width, second.stereo.width, 1e-4f)
        assertEquals(first.stereo.bassMonoHz, second.stereo.bassMonoHz, 1e-4f)

        assertEquals(first.saturation.enabled, second.saturation.enabled)
        assertEquals(first.saturation.mode, second.saturation.mode)
        assertEquals(first.saturation.driveDb, second.saturation.driveDb, 1e-4f)
        assertEquals(first.saturation.mix, second.saturation.mix, 1e-4f)
        assertEquals(first.saturation.outputDb, second.saturation.outputDb, 1e-4f)

        assertEquals(first.limiter.ceilingDb, second.limiter.ceilingDb, 1e-4f)
        assertEquals(first.limiter.releaseMs, second.limiter.releaseMs, 1e-4f)

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

    @Test
    fun `只开声场加宽也不能按字节直通`() {
        // 立体声级插在混响之前：漏了这一条，用户开了宽度却听见原样。
        val widened = EqSettings.fromJson(
            JSONObject("""{"version":2,"enabled":true,"gains":[0,0,0,0,0,0,0,0,0,0],"stereo":{"enabled":true,"width":1.8}}"""),
        )
        assertTrue(!widened.isFlat())
        assertEquals(1.8f, widened.stereo.width, 1e-4f)
    }

    @Test
    fun `自定义分频点在无压缩时同样是平的`() {
        // 分频点可调之后，最容易坏的地方是「四段求和的幅度还平不平」：
        // LR4 的两条支路只在同一个分频点上才同相，挪位置时必须重算两边。
        val settings = CompressorSettings(
            enabled = true,
            bandCount = 4,
            profile = CompressorProfile.FLAT,
            bands = Array(4) { CompressorBand(enabled = false, ratio = 1f) },
            crossovers = floatArrayOf(180f, 1500f, 6000f),
        )
        for (frequency in intArrayOf(80, 180, 800, 1500, 4000, 6000, 11000)) {
            val signal = tone(frequency.toDouble(), sampleRate)
            val reference = signal.copyOf()
            runCompressor(signal, 1, settings)
            val gain = gainDb(signal, reference)
            assertTrue("$frequency Hz 处的分频求和偏差过大：$gain dB", abs(gain) < 1.2)
        }
    }

    @Test
    fun `分频点倒序会被推回升序`() {
        // 手改过的存档、或者把第一级拖过第二级，都不能让中间那段变成负宽度。
        val safe = sanitizeCrossovers(floatArrayOf(4000f, 300f, 100f))
        assertTrue(safe[0] < safe[1])
        assertTrue(safe[1] < safe[2])
        assertEquals(600f, safe[0], 0f)
        assertEquals(840f, safe[1], 0.5f)
        assertEquals(1176f, safe[2], 1f)
    }

    @Test
    fun `缺省的新字段按中性补齐`() {
        val settings = EqSettings.fromJson(
            JSONObject("""{"version":2,"enabled":true,"gains":[0,0,0,0,0,0,0,0,0,0]}"""),
        )
        assertEquals(DEFAULT_COMPRESSOR_CROSSOVERS.toList(), settings.compressor.crossovers.toList())
        assertEquals(0f, settings.stereo.bassMonoHz, 0f)
        assertTrue(!settings.saturation.enabled)
        assertEquals(SaturationMode.TAPE, settings.saturation.mode)
        assertEquals(-0.3f, settings.limiter.ceilingDb, 1e-4f)
        assertEquals(120f, settings.limiter.releaseMs, 1e-4f)
        // 出厂状态下仍然允许整条链直通：限幅器的默认值算「保护」而不是「效果」。
        assertTrue(settings.isFlat())
    }

    @Test
    fun `饱和在干湿比为 0 时逐位不变`() {
        val stage = SaturationStage()
        stage.configure(sampleRate)
        val buffer = tone(1000.0, 9600)
        val reference = buffer.copyOf()
        stage.process(
            buffer,
            0,
            buffer.size,
            1,
            SaturationSettings(enabled = true, mode = SaturationMode.TUBE, driveDb = 18f, mix = 0f, outputDb = 0f),
        )
        assertArrayEquals(reference, buffer, 0f)
    }

    @Test
    fun `饱和会加出输入里没有的谐波`() {
        // 线性处理只能缩放输入。把输出对输入做最小二乘拟合，剩下的残差就是新加的谐波。
        val stage = SaturationStage()
        stage.configure(sampleRate)
        val input = tone(1000.0, 9600)
        val buffer = input.copyOf()
        stage.process(
            buffer,
            0,
            buffer.size,
            1,
            SaturationSettings(enabled = true, mode = SaturationMode.TAPE, driveDb = 18f, mix = 1f, outputDb = 0f),
        )

        var dot = 0.0
        var energy = 0.0
        for (index in 4800 until input.size) {
            dot += input[index].toDouble() * buffer[index]
            energy += input[index].toDouble() * input[index]
        }
        val scale = dot / energy
        var residual = 0.0
        var outEnergy = 0.0
        for (index in 4800 until input.size) {
            val delta = buffer[index] - (scale * input[index]).toFloat()
            residual += delta * delta
            outEnergy += buffer[index].toDouble() * buffer[index]
        }
        assertTrue("残差占比 ${residual / outEnergy}", residual / outEnergy > 0.01)
    }

    @Test
    fun `低频单声道把反相低频折掉`() {
        // 左右完全反相 = 纯侧向。60 Hz 在 120 Hz 分频点之下，应当被扣掉。
        val frames = 9600
        val buffer = FloatArray(frames * 2)
        for (index in 0 until frames) {
            val value = (0.4 * sin(2.0 * PI * 60.0 * index / sampleRate)).toFloat()
            buffer[index * 2] = value
            buffer[index * 2 + 1] = -value
        }

        val stage = StereoStage()
        stage.configure(sampleRate)
        stage.process(buffer, 0, frames, 2, StereoSettings(enabled = true, width = 1f, bassMonoHz = 120f))

        // 前 4800 帧是滤波器预热的瞬态，只看后面。
        var peak = 0f
        for (index in 4800 until frames) {
            peak = maxOf(peak, abs(buffer[index * 2]), abs(buffer[index * 2 + 1]))
        }
        assertTrue("低频侧向残留峰值 $peak", peak < 0.05f)
    }

    @Test
    fun `限幅器的天花板生效`() {
        val frames = 9600
        val buffer = FloatArray(frames) { (0.9 * sin(2.0 * PI * 220.0 * it / sampleRate)).toFloat() }
        val limiter = LookaheadLimiter()
        limiter.configure(sampleRate, 1)
        limiter.ceiling = 0.5f

        var frame = 0
        while (frame < frames) {
            val block = minOf(128, frames - frame)
            limiter.process(buffer, frame, block, 1)
            frame += block
        }

        var peak = 0f
        for (index in 1024 until frames) peak = maxOf(peak, abs(buffer[index]))
        assertTrue("限幅后峰值 $peak", peak <= 0.52f)
    }
}
