package top.izuna.foliamajor.automix

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.io.File
import java.nio.FloatBuffer
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Beat This!（CPJKU, ISMIR 2024）的本地推理。
 *
 * 模型输入输出（用 onnx 工具实测得到，不是猜的）：
 *   input_spectrogram : float32 [1, time, 128]   —— log-mel 频谱
 *   beat              : float32 [1, time]         —— 每帧「这里是拍点」的 logit
 *   downbeat          : float32 [1, time]         —— 每帧「这里是小节头」的 logit
 *
 * 模型里**没有**包含 STFT/mel 前处理（`spectral ops: none`），所以那一段要在这里自己做。
 * 参数与 Web 侧 src/services/analysis/beatThis.ts 一一对应 —— 那份是被真机验证过的，
 * 这里照抄它的数值，避免两边算出不同的频谱：
 *
 *   采样率 22050、N_FFT 1024、hop 441（所以每帧 1/50 秒）、128 个 mel 带、
 *   30Hz..11kHz、Slaney mel、periodic Hann、按 1/sqrt(N_FFT) 归一、
 *   log1p(1000 * max(energy, 1e-10))。
 *
 * 前处理是这块的主要工作量，也是「节拍准不准」的决定因素：
 * 中心化（reflect padding）不能省 —— 少了它每个拍点都会晚半个窗（23ms）。
 */
object BeatThisRunner {

    /** 与 Web 侧一致：22050Hz 单声道。 */
    const val SAMPLE_RATE = 22050
    private const val N_FFT = 1024
    private const val HOP = 441
    private const val N_MELS = 128
    private const val F_MIN = 30.0
    private const val F_MAX = 11000.0
    private const val LOG_MULTIPLIER = 1000.0
    private const val AMIN = 1e-10

    /** 每帧 1/50 秒。 */
    const val FPS = SAMPLE_RATE.toDouble() / HOP

    /**
     * 一次前向最多吃多少帧。
     *
     * beat_this 是自注意力结构，显存/内存随帧数平方增长。上游的 Python 实现按整首歌一次
     * 喂进去，四分钟的歌就是 12000 帧 —— 在手机上那样会直接 OOM。
     * 这里切成带重叠的块，块间取重叠区的平均，再拼回一条连续的 logit 曲线。
     * 2048 帧 ≈ 41 秒，重叠加 50 帧（1 秒），足够让前后文一致。
     */
    private const val CHUNK_FRAMES = 2048
    private const val OVERLAP_FRAMES = 50

    /** 一个拍点。时间单位是秒。 */
    data class Beat(val time: Double, val isDownbeat: Boolean, val confidence: Float)

    /** 分析结果。 */
    data class Result(
        val beats: List<Beat>,
        /** 逐帧 beat logit，供「动感」类效果做脉冲用。 */
        val beatLogits: FloatArray,
        /** 每帧对应的时间步长，便于调用方换算。 */
        val fps: Double,
        /** 是不是被中途取消的：是的话 beats 只覆盖前一段，调用方不该当成整曲结果。 */
        val cancelled: Boolean = false,
    )

    private var env: OrtEnvironment? = null
    private var session: OrtSession? = null
    private var sessionPath: String? = null

    /** 载入（或复用）模型。多次调用只有第一次真的加载。 */
    @Synchronized
    fun ensureLoaded(modelFile: File): OrtSession {
        val existing = session
        if (existing != null && sessionPath == modelFile.absolutePath) return existing

        existing?.close()
        val environment = env ?: OrtEnvironment.getEnvironment().also { env = it }
        val options = OrtSession.SessionOptions().apply {
            /*
             * 线程数取一半核数，但**封顶 3**。
             *
             * 原来八核机就是四线程：节拍分析是整曲一次跑几十秒的活，
             * 四个 ONNX 工作线程一起抢 CPU，别的 App 与音频线程只能捡剩下的 ——
             * 用户看到的是「一分析手机就卡」。少一个线程，推理慢约 20%，
             * 但后台播放、滚动、通知栏都顺畅得多；这是用户能直接感觉到的差别。
             * 下限仍是 2：单线程跑 8 分钟的注意力网络要等到人以为程序挂了。
             */
            setIntraOpNumThreads((Runtime.getRuntime().availableProcessors() / 2).coerceIn(2, 3))
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
        }
        val loaded = environment.createSession(modelFile.absolutePath, options)
        session = loaded
        sessionPath = modelFile.absolutePath
        return loaded
    }

    @Synchronized
    fun close() {
        session?.close()
        session = null
        sessionPath = null
    }

    /**
     * 分析一段单声道 PCM（-1..1，[sampleRate] 必须已经是 22050）。
     *
     * 阻塞调用，可能跑几十秒（四分钟的歌在手机上约 10~30 秒），必须在后台线程。
     *
     * `cancelled` 在每一块之前问一次：切歌、退出时正在跑的这一次不该继续占着单线程队列，
     * 后面的分析全会被它堵住（界面上就是「智能动感一直没反应」）。
     */
    fun analyze(mono: FloatArray, cancelled: (() -> Boolean)? = null): Result {
        val model = session ?: error("beat_this 还没载入")
        val mel = melSpectrogram(mono)
        if (mel.frames <= 0) return Result(emptyList(), FloatArray(0), FPS)

        val beatLogits = FloatArray(mel.frames)
        val downbeatLogits = FloatArray(mel.frames)
        /* 哪些帧已经有值了。用它而不是 isNaN 判断：FloatArray 新建出来是 0，不是 NaN。 */
        val filled = BooleanArray(mel.frames)
        val environment = env ?: error("ORT 环境未初始化")

        var start = 0
        while (start < mel.frames) {
            if (cancelled?.invoke() == true) {
                // 只交回已经算完的那一截；调用方看 `cancelled` 决定是否采用。
                return Result(pickPeaks(beatLogits, downbeatLogits), beatLogits.copyOfRange(0, start), FPS, true)
            }
            val end = min(mel.frames, start + CHUNK_FRAMES)
            val length = end - start
            // 这一块要喂的切片：[1, length, 128]
            val input = FloatArray(length * N_MELS)
            System.arraycopy(mel.data, start * N_MELS, input, 0, length * N_MELS)

            val shape = longArrayOf(1, length.toLong(), N_MELS.toLong())
            OnnxTensor.createTensor(environment, FloatBuffer.wrap(input), shape).use { tensor ->
                model.run(mapOf("input_spectrogram" to tensor)).use { output ->
                    @Suppress("UNCHECKED_CAST")
                    val beat = (output[0].value as Array<FloatArray>)[0]
                    @Suppress("UNCHECKED_CAST")
                    val down = (output[1].value as Array<FloatArray>)[0]

                    for (i in 0 until length) {
                        val frame = start + i
                        if (filled[frame]) {
                            /*
                             * 块间重叠区取平均：块边界处的预测通常略差
                             * （没有后文可看），平均能把它抹平。
                             */
                            beatLogits[frame] = (beatLogits[frame] + beat[i]) / 2f
                            downbeatLogits[frame] = (downbeatLogits[frame] + down[i]) / 2f
                        } else {
                            beatLogits[frame] = beat[i]
                            downbeatLogits[frame] = down[i]
                            filled[frame] = true
                        }
                    }
                }
            }
            if (end >= mel.frames) break
            start = end - OVERLAP_FRAMES
            if (start <= 0) start = end
            /*
             * 一块推理（最长约 41 秒音频）刚刚结束：这里是唯一不会打断数据流的地方。
             * 后台时让出 60ms，前台立刻返回。
             */
            AutomixLoad.yieldUnless { cancelled?.invoke() == true }
        }

        val beats = pickPeaks(beatLogits, downbeatLogits)
        return Result(beats, beatLogits, FPS)
    }

    /**
     * 把两条 logit 曲线变成拍点。
     *
     * 做法是标准的 peak picking：
     *   1. sigmoid 转成 0..1；
     *   2. 找局部极大值（比左右各 [PEAK_RADIUS] 帧都高）；
     *   3. 卡一个阈值，滤掉噪声；
     *   4. 补一个「最小拍间隔」，避免一个鼓点被数成两拍。
     *
     * 这几个常数与 Web 侧一致；将来若发现节拍偏密/偏疏，先怀疑它们而不是模型。
     */
    private fun pickPeaks(beat: FloatArray, downbeat: FloatArray): List<Beat> {
        if (beat.isEmpty()) return emptyList()
        val sig = FloatArray(beat.size) { sigmoid(beat[it]) }
        val dsig = FloatArray(downbeat.size) { sigmoid(downbeat[it]) }

        val threshold = 0.28f
        val peakRadius = 3
        // 最小间隔 0.15s ≈ 400 BPM。比任何真实音乐都快，纯粹用来挡「一拍两报」。
        val minGapFrames = (0.15 * FPS).toInt()

        val out = ArrayList<Beat>()
        var lastFrame = -minGapFrames
        for (frame in sig.indices) {
            val value = sig[frame]
            if (value < threshold) continue
            var isPeak = true
            for (offset in 1..peakRadius) {
                if (frame - offset >= 0 && sig[frame - offset] > value) { isPeak = false; break }
                if (frame + offset < sig.size && sig[frame + offset] > value) { isPeak = false; break }
            }
            if (!isPeak) continue
            if (frame - lastFrame < minGapFrames) continue
            lastFrame = frame
            out.add(Beat(
                time = frame / FPS,
                isDownbeat = dsig[frame] >= 0.5f,
                confidence = value,
            ))
        }
        return out
    }

    private fun sigmoid(value: Float): Float = (1.0 / (1.0 + exp(-value.toDouble()))).toFloat()

    // ───────────────────────── mel 频谱前处理 ─────────────────────────

    private data class MelBand(val weights: FloatArray, val start: Int, val end: Int)

    private var filterbank: Array<MelBand>? = null
    private var hann: FloatArray? = null

    private fun hzToMel(hz: Double): Double {
        val fSp = 200.0 / 3.0
        if (hz < 1000.0) return hz / fSp
        return 1000.0 / fSp + ln(hz / 1000.0) / (ln(6.4) / 27.0)
    }

    private fun melToHz(mel: Double): Double {
        val fSp = 200.0 / 3.0
        val minLogMel = 1000.0 / fSp
        if (mel < minLogMel) return fSp * mel
        return 1000.0 * exp((ln(6.4) / 27.0) * (mel - minLogMel))
    }

    private fun buildFilterbank(): Array<MelBand> {
        val bins = N_FFT / 2 + 1
        val melMin = hzToMel(F_MIN)
        val melMax = hzToMel(F_MAX)
        val corners = DoubleArray(N_MELS + 2) { index ->
            melToHz(melMin + (melMax - melMin) * index / (N_MELS + 1))
        }
        return Array(N_MELS) { band ->
            val row = FloatArray(bins)
            val left = corners[band]
            val centre = corners[band + 1]
            val right = corners[band + 2]
            for (bin in 0 until bins) {
                val hz = bin.toDouble() * SAMPLE_RATE / N_FFT
                val rising = if (centre == left) 0.0 else (hz - left) / (centre - left)
                val falling = if (right == centre) 0.0 else (right - hz) / (right - centre)
                row[bin] = max(0.0, min(rising, falling)).toFloat()
            }
            var from = 0
            while (from < bins && row[from] == 0f) from += 1
            var to = bins
            while (to > from && row[to - 1] == 0f) to -= 1
            MelBand(row, from, to)
        }
    }

    private class Mel(
        val data: FloatArray,
        val frames: Int,
    )

    /**
     * 混音的三条鼓点频带（kick / snare / hats），每帧一个值 —— 只做前处理，**不跑模型**。
     *
     * 给 时计 的仿真鼓面用（Web 侧 `drumHits.ts` 的 `loadMixDrumHits`）：整曲解码 + mel 放在原生，
     * 四分钟的歌一两秒；而 WebView 里的 `decodeAudioData` 要几秒到几十秒，那段时间鼓面只能停在
     * 「正在从混音里读鼓点…」。鼓点是靠 mel 的起音挑的，不需要神经网络，所以这里只到 mel 为止，
     * 挑点仍然在 Web 侧（`pickBandHits`），两边算法只有一份。
     *
     * 频带划分与 Web 侧 `drumBandTracks` 一致：中心频率落在 [0,150) / [150,4000) / [6000,∞)。
     */
    fun drumBands(mono: FloatArray, cancelled: (() -> Boolean)? = null): Array<FloatArray> {
        val mel = melSpectrogram(mono)
        if (mel.frames <= 0) return Array(3) { FloatArray(0) }
        val centres = melBandCentres()
        val edges = doubleArrayOf(0.0, 150.0, 4000.0, Double.MAX_VALUE)
        return Array(3) { kind ->
            val picked = (0 until N_MELS).filter { centres[it] >= edges[kind] && centres[it] < edges[kind + 1] }
            val track = FloatArray(mel.frames)
            if (picked.isNotEmpty()) {
                for (frame in 0 until mel.frames) {
                    // 三条频带各扫一遍整曲：后台时每 2048 帧让一次，并允许中途取消。
                    if (frame and 2047 == 0) {
                        if (cancelled?.invoke() == true) return@Array FloatArray(0)
                        AutomixLoad.yieldPoint()
                    }
                    var sum = 0f
                    for (band in picked) sum += mel.data[frame * N_MELS + band]
                    track[frame] = sum / picked.size
                }
            }
            track
        }
    }

    /** 每个 mel 带的中心频率，与 Web 侧 `melBandCentresHz()` 同一条公式。 */
    private fun melBandCentres(): DoubleArray {
        val melMin = hzToMel(F_MIN)
        val melMax = hzToMel(F_MAX)
        return DoubleArray(N_MELS) { melToHz(melMin + (melMax - melMin) * (it + 1) / (N_MELS + 1)) }
    }

    private fun melSpectrogram(mono: FloatArray): Mel {
        if (mono.isEmpty()) return Mel(FloatArray(0), 0)
        val bands = filterbank ?: buildFilterbank().also { filterbank = it }
        val window = hann ?: FloatArray(N_FFT) { index ->
            (0.5 * (1.0 - cos(2.0 * Math.PI * index / N_FFT))).toFloat()
        }.also { hann = it }

        val pad = N_FFT / 2
        val frames = (mono.size + 2 * pad - N_FFT) / HOP + 1
        if (frames <= 0) return Mel(FloatArray(0), 0)

        val data = FloatArray(frames * N_MELS)
        val real = FloatArray(N_FFT)
        val imag = FloatArray(N_FFT)
        val magnitude = FloatArray(N_FFT / 2 + 1)
        val scale = (1.0 / sqrt(N_FFT.toDouble())).toFloat()
        val last = mono.size - 1
        /*
         * 不再为整首歌建一条「两侧补齐」的副本。
         *
         * 原来那条 `padded` 是 mono.size + N_FFT 个 float —— 四分钟的歌 53MB，
         * 而且还要整段 arraycopy 一次。它唯一的作用是让每帧取窗时不用判边界，
         * 可边界只有最前最后各半窗。改成按需反射，省掉这 53MB 与一次全量拷贝。
         *
         * 反射规则与原来逐字一致（numpy 'reflect'）：左越界取 mono[-i]，
         * 右越界取 mono[2*(n-1)-i]，两侧都夹到 [0, n-1]（很短的音频也不会越界）。
         * 判断写在取样本的那一层，不抽成一个局部函数 —— 这里每帧要跑 1024 次，
         * 一首歌三千万次，函数调用的开销是实打实的。
         */

        for (frame in 0 until frames) {
            // 每 1024 帧（约 20 秒音频）让一次：前台只做一次优先级检查，后台让出 CPU。
            if (frame and 1023 == 0) AutomixLoad.yieldPoint()
            val start = frame * HOP - pad
            for (index in 0 until N_FFT) {
                val source = start + index
                val sample = when {
                    source < 0 -> mono[min(-source, last)]
                    source > last -> mono[max(0, 2 * last - source)]
                    else -> mono[source]
                }
                real[index] = sample * window[index]
                imag[index] = 0f
            }
            fft(real, imag)
            for (bin in magnitude.indices) {
                magnitude[bin] = sqrt(real[bin] * real[bin] + imag[bin] * imag[bin]) * scale
            }
            for (band in 0 until N_MELS) {
                val entry = bands[band]
                var energy = 0f
                for (bin in entry.start until entry.end) {
                    energy += magnitude[bin] * entry.weights[bin]
                }
                data[frame * N_MELS + band] =
                    Math.log1p(LOG_MULTIPLIER * max(energy.toDouble(), AMIN)).toFloat()
            }
        }
        return Mel(data, frames)
    }

    /**
     * 原地基-2 快速傅里叶变换（长度必须是 2 的幂）。
     *
     * 自己写而不是用 JTransforms：只需要这一个 1024 点变换，
     * 为它引一个第三方库不值得，而且这段代码是标准写法、容易核。
     */
    private fun fft(real: FloatArray, imag: FloatArray) {
        val n = real.size
        // 位反转置换
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) {
                j = j xor bit
                bit = bit shr 1
            }
            j = j or bit
            if (i < j) {
                val tr = real[i]; real[i] = real[j]; real[j] = tr
                val ti = imag[i]; imag[i] = imag[j]; imag[j] = ti
            }
        }
        // 蝶形运算
        var length = 2
        while (length <= n) {
            val angle = -2.0 * Math.PI / length
            val wReal = cos(angle).toFloat()
            val wImag = kotlin.math.sin(angle).toFloat()
            var i = 0
            while (i < n) {
                var curReal = 1.0f
                var curImag = 0.0f
                for (k in 0 until length / 2) {
                    val a = i + k
                    val b = a + length / 2
                    val xr = real[b] * curReal - imag[b] * curImag
                    val xi = real[b] * curImag + imag[b] * curReal
                    real[b] = real[a] - xr
                    imag[b] = imag[a] - xi
                    real[a] += xr
                    imag[a] += xi
                    val nextReal = curReal * wReal - curImag * wImag
                    curImag = curReal * wImag + curImag * wReal
                    curReal = nextReal
                }
                i += length
            }
            length = length shl 1
        }
    }
}
