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
             * 线程数取一半核数：节拍分析通常在用户点「分析」时同步等结果，
             * 全占满会让界面明显卡一下。一半既快又留出 UI 的余量。
             */
            setIntraOpNumThreads(max(2, Runtime.getRuntime().availableProcessors() / 2))
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
     */
    fun analyze(mono: FloatArray): Result {
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

    private fun melSpectrogram(mono: FloatArray): Mel {
        val bands = filterbank ?: buildFilterbank().also { filterbank = it }
        val window = hann ?: FloatArray(N_FFT) { index ->
            (0.5 * (1.0 - cos(2.0 * Math.PI * index / N_FFT))).toFloat()
        }.also { hann = it }

        val pad = N_FFT / 2
        val paddedLength = mono.size + 2 * pad
        val padded = FloatArray(paddedLength)
        // reflect，但不重复边缘样本 —— 这是 numpy 的 'reflect' 与 torch 的默认。
        for (index in 0 until pad) {
            padded[index] = mono[min(pad - index, mono.size - 1)]
            val mirrored = mono[max(0, mono.size - 1 - (pad - index))]
            padded[paddedLength - 1 - index] = mirrored
        }
        System.arraycopy(mono, 0, padded, pad, mono.size)

        val frames = (paddedLength - N_FFT) / HOP + 1
        if (frames <= 0) return Mel(FloatArray(0), 0)

        val data = FloatArray(frames * N_MELS)
        val real = FloatArray(N_FFT)
        val imag = FloatArray(N_FFT)
        val magnitude = FloatArray(N_FFT / 2 + 1)
        val scale = (1.0 / sqrt(N_FFT.toDouble())).toFloat()

        for (frame in 0 until frames) {
            val start = frame * HOP
            for (index in 0 until N_FFT) {
                real[index] = padded[start + index] * window[index]
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
