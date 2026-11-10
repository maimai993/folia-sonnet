package top.izuna.foliamajor.automix

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.io.File
import java.nio.FloatBuffer
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * htdemucs（Demucs v4）的四轨分离，本地推理。
 *
 * 模型输入输出（用 onnx 工具实测，不是猜的）：
 *
 *   mix       : float32 [1, 2, 172032]       —— 立体声波形，44.1kHz，约 3.9 秒
 *   mix_spec  : float32 [344, 2049, 2]       —— STFT 频谱
 *   stems_spec: float32 [1376, 2049, 2]      —— 四个轨的频谱，1376 = 344 × 4
 *   stems_time: float32 [1, 4, 2, 172032]    —— 四个轨的波形
 *
 * mix_spec 的形状要读准，这是最容易写错的地方：
 *   · 344 是 **172 帧 × 2 声道**；
 *   · 末尾的 2 不是声道，是 **(实部, 虚部)**。
 * 证据在图里：模型用 `Slice` 沿首维切成两半（两个声道的 172 帧），
 * 又沿末维切成两份做 iSTFT 的实部与虚部；`stems_spec` 那边则是把
 * 两路分别 Reshape 成 [1376, 2049, 1] 再 `Concat` 到末维 —— 只有实/虚才会这样拼。
 *
 * STFT 参数（从图里的内联常量反推，且与 Demucs 官方实现一致）：
 *   N_FFT = 4096, HOP = 1024, 周期 Hann 窗, center = true
 *   172 帧覆盖 (172 - 4) × 1024 = 172032 个样本，两侧各多出的 2 帧是 padding 的边。
 *
 * 内存：一次前向的中间张量峰值约 500MB（模型里 823 个 initializer 之外，
 * 交叉注意力那几层的激活很占地方）。设备可用内存约 2.9GB，
 * 所以**必须一次只跑一个窗口**，宁可慢也不要并行。
 */
object HtdemucsRunner {

    /** Demucs 的工作采样率。 */
    const val SAMPLE_RATE = 44100

    /** 一个窗口的样本数 = 模型的 mix 长度。 */
    const val SEGMENT = 172032

    private const val N_FFT = 4096
    private const val HOP = 1024

    /** 频谱帧数：344 = 172 × 2（声道）；单声道是 172 帧。 */
    private const val FRAMES = 172
    private const val BINS = N_FFT / 2 + 1 // 2049

    /**
     * 四个轨的顺序。
     *
     * htdemucs 的固定顺序是 drums / bass / other / vocals，
     * 与 Demucs 官方的 `sources` 一致 —— 不能按字母排，也不能猜。
     */
    val STEMS = listOf("drums", "bass", "other", "vocals")

    /** 分离结果：每个轨一条单声道波形（已降混），长度与输入一致时最有用。 */
    data class Result(
        /** 键是 STEMS 里的名字，值是 [声道数][样本数] 的波形。 */
        val stems: Map<String, Array<FloatArray>>,
        /** 实际处理的采样率。 */
        val sampleRate: Int,
    )

    private const val MODEL_INPUT_MIX = "mix"
    private const val MODEL_INPUT_SPEC = "mix_spec"
    private const val MODEL_OUTPUT_TIME = "stems_time"

    private var session: OrtSession? = null
    private var environment: OrtEnvironment? = null
    private var loadedPath: String? = null

    /** 周期 Hann 窗。Build once. */
    private val window: FloatArray by lazy {
        FloatArray(N_FFT) { index ->
            (0.5 - 0.5 * cos(2.0 * PI * index / N_FFT)).toFloat()
        }
    }

    /** 加载（并缓存）模型。重复调用是廉价的。 */
    @Synchronized
    fun ensureLoaded(file: File) {
        val path = file.absolutePath
        if (session != null && loadedPath == path) return
        release()
        val env = OrtEnvironment.getEnvironment()
        /*
         * 单线程、关掉图优化。
         *
         * ORT_OPT_LEVEL_BASIC 已经够：htdemucs 的图里有大量 shape 相关的动态操作，
         * 激进优化在这些节点上容易出错，而收益只有启动快一点点。
         * 线程数留 2 —— 再多在手机上会抢播放线程的 CPU，反而掉音。
         */
        val options = OrtSession.SessionOptions().apply {
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.BASIC_OPT)
            setIntraOpNumThreads(2)
        }
        session = env.createSession(path, options)
        environment = env
        loadedPath = path
    }

    @Synchronized
    fun release() {
        session?.close()
        session = null
        loadedPath = null
    }

    /**
     * 分离整首歌。
     *
     * @param left  左声道，44.1kHz
     * @param right 右声道，44.1kHz（单声道输入时传和 left 相同的数组）
     * @param onProgress 每处理完一个窗口回调一次 (已处理样本, 总样本)
     */
    fun separate(
        left: FloatArray,
        right: FloatArray,
        onProgress: ((Int, Int) -> Unit)? = null,
    ): Result {
        val active = session ?: error("htdemucs 还没加载")
        val env = environment ?: error("ORT 环境未初始化")
        val total = min(left.size, right.size)
        require(total > 0) { "音频是空的" }

        /*
         * 输出缓冲：[轨][声道][样本数]。
         *
         * 一次把四个轨全长都开出来会很大（4 × 2 × 44.1k × 240s ≈ 340MB），
         * 所以这里只留**我们要的**：四个轨各一条立体声。
         * 真正的省内存手段是下面按窗口流式累加，不保留中间结果。
         */
        val out = Array(STEMS.size) { Array(2) { FloatArray(total) } }
        // 重叠区用加权累加，最后除以权重，避免窗口接缝处的爆音。
        val weight = FloatArray(total)

        var start = 0
        while (start < total) {
            val end = min(total, start + SEGMENT)
            val length = end - start

            val mixLeft = FloatArray(SEGMENT)
            val mixRight = FloatArray(SEGMENT)
            System.arraycopy(left, start, mixLeft, 0, length)
            System.arraycopy(right, start, mixRight, 0, length)

            val spec = stftStereo(mixLeft, mixRight)

            val mixShape = longArrayOf(1, 2, SEGMENT.toLong())
            val specShape = longArrayOf((FRAMES * 2).toLong(), BINS.toLong(), 2)

            // [1, 2, SEGMENT]：先整段左声道，再整段右声道（连续写，不用交错）
            val packed = FloatArray(2 * SEGMENT)
            System.arraycopy(mixLeft, 0, packed, 0, SEGMENT)
            System.arraycopy(mixRight, 0, packed, SEGMENT, SEGMENT)

            OnnxTensor.createTensor(env, FloatBuffer.wrap(packed), mixShape).use { mixTensor ->
                OnnxTensor.createTensor(env, FloatBuffer.wrap(spec), specShape).use { specTensor ->
                    active.run(mapOf(MODEL_INPUT_MIX to mixTensor, MODEL_INPUT_SPEC to specTensor)).use { output ->
                        /*
                         * stems_time 的形状是 [1, 4, 2, 172032] —— 取 [0] 拿到
                         * Array<Array<Array<FloatArray>>>，再 [轨道][声道]。
                         * 用名字取而不是下标：模型有两个输出，靠位置假设迟早出错。
                         */
                        val timeValue = output.get(MODEL_OUTPUT_TIME).orElse(null)
                            ?: error("模型没有输出 $MODEL_OUTPUT_TIME")
                        @Suppress("UNCHECKED_CAST")
                        val stemValues = timeValue.value as Array<Array<Array<FloatArray>>>
                        for (stem in STEMS.indices) {
                            for (channel in 0..1) {
                                val source = stemValues[0][stem][channel]
                                val target = out[stem][channel]
                                for (index in 0 until length) {
                                    target[start + index] += source[index]
                                }
                            }
                        }
                    }
                }
            }

            for (index in start until end) weight[index] += 1f
            onProgress?.invoke(end, total)

            if (end >= total) break
            /*
             * 窗口之间留 1/8 的重叠（~0.5 秒）。留得太多是白算，
             * 不留则在接缝处会有明显的相位跳变（iSTFT 的边界效应）。
             */
            start = end - SEGMENT / 8
        }

        // 归一化重叠区
        for (stem in STEMS.indices) {
            for (channel in 0..1) {
                val track = out[stem][channel]
                for (index in 0 until total) {
                    val w = weight[index]
                    if (w > 0f) track[index] /= w
                }
            }
        }

        return Result(
            stems = STEMS.indices.associate { STEMS[it] to out[it] },
            sampleRate = SAMPLE_RATE,
        )
    }

    /**
     * 立体声 STFT，输出模型要的 [344, 2049, 2]。
     *
     * 布局：首维是 (声道, 帧) 展平 —— 声道 0 的 172 帧在前，声道 1 在后；
     * 末维是 (实部, 虚部)。这个顺序是从图里的 Slice 轴推出来的，写反了模型不报错，
     * 只会输出一堆噪声 —— 那是最难查的一类错。
     */
    private fun stftStereo(left: FloatArray, right: FloatArray): FloatArray {
        val out = FloatArray(FRAMES * 2 * BINS * 2)
        val re = FloatArray(N_FFT)
        val im = FloatArray(N_FFT)

        for (channel in 0..1) {
            val samples = if (channel == 0) left else right
            for (frame in 0 until FRAMES) {
                /*
                 * 帧 f 的中心在 f * HOP 处，窗从中心往前 N_FFT/2 开始（center = true）。
                 * 超出范围的部分补 0 —— 模型两侧各多出 2 帧，正是这个 padding。
                 */
                val origin = frame * HOP - N_FFT / 2
                for (index in 0 until N_FFT) {
                    val at = origin + index
                    val value = if (at in samples.indices) samples[at] else 0f
                    re[index] = value * window[index]
                    im[index] = 0f
                }
                fft(re, im)
                // 只取前 BINS 个频点（实信号频谱共轭对称）
                for (bin in 0 until BINS) {
                    val base = ((channel * FRAMES + frame) * BINS + bin) * 2
                    out[base] = re[bin]
                    out[base + 1] = im[bin]
                }
            }
        }
        return out
    }

    /**
     * 原地基 2 FFT。
     *
     * N_FFT = 4096 是 2 的幂，所以不用通用 DFT。
     * 一次 STFT 要跑 172 × 2 = 344 次这个函数，用朴素 DFT 会是 4096² 级别 —— 慢到不可用。
     */
    private fun fft(re: FloatArray, im: FloatArray) {
        val n = re.size
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
                val tr = re[i]; re[i] = re[j]; re[j] = tr
                val ti = im[i]; im[i] = im[j]; im[j] = ti
            }
        }
        var length = 2
        while (length <= n) {
            val angle = -2.0 * PI / length
            val wRe = cos(angle).toFloat()
            val wIm = sin(angle).toFloat()
            var start = 0
            while (start < n) {
                var curRe = 1f
                var curIm = 0f
                val half = length / 2
                for (k in 0 until half) {
                    val even = start + k
                    val odd = even + half
                    val tRe = re[odd] * curRe - im[odd] * curIm
                    val tIm = re[odd] * curIm + im[odd] * curRe
                    re[odd] = re[even] - tRe
                    im[odd] = im[even] - tIm
                    re[even] += tRe
                    im[even] += tIm
                    val nextRe = curRe * wRe - curIm * wIm
                    curIm = curRe * wIm + curIm * wRe
                    curRe = nextRe
                }
                start += length
            }
            length = length shl 1
        }
        // 按 1/sqrt(N) 归一，与 Demucs 的 torch.stft 默认一致（正交归一化）
        val scale = 1f / sqrt(n.toFloat())
        for (i in 0 until n) {
            re[i] *= scale
            im[i] *= scale
        }
    }
}
