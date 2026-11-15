package top.izuna.foliamajor.automix

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.os.SystemClock
import java.io.File
import java.nio.FloatBuffer
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * SCNet 的四轨分离，本地推理（替代 htdemucs）。
 *
 * 为什么换：MUSDB18-HQ 上四个指标都比 htdemucs 高或持平
 * （vocals 9.88 vs 8.86、other 6.15 vs 5.69、drums 9.43 vs 9.55、bass 8.35 vs 9.30），
 * 模型只有 13MB（htdemucs 108MB），权重是 MIT 许可 —— 可以随 APK 分发。
 *
 * 模型契约（onnxruntime 实测，不是猜的）：
 *
 *   mix_spec  : float32 [1, 4, 2049, 476]   —— 4 通道 = L 实、L 虚、R 实、R 虚
 *   stems_spec: float32 [1, 16, 2049, 476]  —— 16 = 4 轨 × 2 声道 × (实, 虚)
 *
 * STFT 参数（SCNet.forward 自己的，不是 Demucs 的）：
 *   N_FFT = 4096, HOP = 1024, **矩形窗**（没有窗）, 正交归一化（1/√4096）,
 *   center = true, 两端 **reflect** 补边（不是补零）。
 *   11 秒段 = 485100 样本，按模型自己的规则补到 486400，正好 476 帧。
 *
 * 与 htdemucs 的三处差别，任何一处写错都会让曲线全错：
 *   1. 窗：这里是 1.0，不是 Hann。频谱幅度差一个窗，不是小误差。
 *   2. 补边：reflect，不是零。开头 0.05 秒的曲线会因此不同。
 *   3. 段长：11 秒，不是 3.9 秒；块数少一半以上，这是整首更快的主因。
 */
object ScnetRunner {

    const val SAMPLE_RATE = 44100

    /** 一个窗口的样本数：11 秒。模型按 476 帧的固定形状导出。 */
    const val SEGMENT = 485100

    private const val N_FFT = 4096
    private const val HOP = 1024
    private const val BINS = N_FFT / 2 + 1 // 2049
    private const val FRAMES = 476

    /** 模型自己会把 485100 补到 486400；这里照它的规则先补，STFT 的帧数才对得上。 */
    private const val PADDED = 486400

    /** 四个轨的顺序，与模型输出一致。 */
    val STEMS = listOf("drums", "bass", "other", "vocals")

    data class Result(
        val stems: Map<String, Array<FloatArray>>,
        val sampleRate: Int,
        val fromSample: Int = 0,
    )

    private const val MODEL_INPUT = "mix_spec"
    private const val MODEL_OUTPUT = "stems_spec"

    private var session: OrtSession? = null
    private var environment: OrtEnvironment? = null
    private var loadedPath: String? = null

    /**
     * 加载（并缓存）模型。重复调用是廉价的。
     *
     * 两个后台队列都会来这里：智能动感的分块分离、伴奏/清唱的整曲预生成。
     * 首次装模型时若两边同时进来，不加锁会各自 release + createSession 一遍，
     * 前一个 session 没关就丢引用（内存泄漏），后一个还可能读到半初始化的状态。
     */
    @Synchronized
    fun ensureLoaded(file: File) {
        val path = file.absolutePath
        if (session != null && loadedPath == path) return
        release()
        val env = OrtEnvironment.getEnvironment()
        val options = OrtSession.SessionOptions().apply {
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.BASIC_OPT)
            /*
             * 以前固定 2 线程：那时分轨只在用户拨开关时跑一次，怕抢播放的核。
             * 现在整首预分析是常态，2 线程把八核手机当双核用，一首四分多钟的歌
             * 要跑好几分钟。上限放到 6：空出来的两核留给系统和正在播的歌，
             * 而「正在播」的冲突另有一道让路闸管着（见 separate() 里每个窗口
             * 之后那次 separationYield）—— 暂停 / 没放歌时全速，播放时按窗口
             * 耗时让出大头，两件事各管各的。
             */
            setIntraOpNumThreads(Runtime.getRuntime().availableProcessors().coerceIn(2, 6))
            // int8 权重在 CPU 上走 QLinear 算子；关掉 arena，跑完一块就把中间缓冲还回去。
            setMemoryPatternOptimization(false)
            setCPUArenaAllocator(false)
        }
        session = env.createSession(path, options)
        environment = env
        loadedPath = path
    }

    @Synchronized
    fun release() {
        try {
            session?.close()
        } catch (_: Throwable) {
            // 关不掉也不该拖垮下一块。
        }
        session = null
        environment = null
        loadedPath = null
    }

    /**
     * 分离 `[fromSample, toSample)` 这一段。
     *
     * 按 11 秒切窗口，不足一段的尾部补零。SCNet 的输出是整段频谱，没有“半段”的概念，
     * 所以这里不做重叠相加 —— 窗口之间直接相接，边界由模型自己 pad 的尾部承担。
     *
     * @param eager 用户正拨着开关等结果：播放中的让路比例降一档，尽快出活；
     *              后台预生成走默认值，把时间片尽量还给正在放的歌。
     */
    fun separate(
        left: FloatArray,
        right: FloatArray,
        stems: List<Int> = STEMS.indices.toList(),
        fromSample: Int = 0,
        toSample: Int = minOf(left.size, right.size),
        onProgress: ((Int, Int) -> Unit)? = null,
        cancelled: (() -> Boolean)? = null,
        eager: Boolean = false,
    ): Result {
        val active = session ?: error("scnet 还没加载")
        val env = environment ?: error("ORT 环境未初始化")
        val wanted = stems.filter { it in STEMS.indices }.distinct()
        require(wanted.isNotEmpty()) { "没有要分离的轨" }

        val start0 = fromSample.coerceIn(0, minOf(left.size, right.size))
        val end0 = toSample.coerceIn(start0, minOf(left.size, right.size))
        val length = end0 - start0
        require(length > 0) { "音频是空的" }

        val out = Array(wanted.size) { Array(2) { FloatArray(length) } }

        // 每个窗口都要重算一遍的缓冲，抬到循环外复用 —— 否则每段要抛掉 20MB 垃圾。
        val mono = FloatArray(2 * PADDED)
        val spec = FloatArray(4 * BINS * FRAMES)
        val re = FloatArray(N_FFT)
        val im = FloatArray(N_FFT)
        /*
         * 逆变换的累加缓冲区是**补边后的时间轴**：torch 的 istft 先把每帧摆到
         * frame*hop 上，累加 (T-1)*hop + N_FFT 个样本，再把两端各 n_fft/2 切掉。
         * 所以这里要比 PADDED 长一个窗，取结果时从 half 开始 —— 少这一截，
         * 整段音频会往左偏 46ms，块与块之间也对不齐。
         */
        val acc = FloatArray(PADDED + N_FFT)
        val tally = FloatArray(PADDED + N_FFT)

        var window = 0
        var cursor = start0
        val total = (length + SEGMENT - 1) / SEGMENT
        /*
         * 让路计数随任务进出：两个分离（预生成 + 精修）同时跑时，
         * AutomixLoad 会按「不止一个任务」抬高让路比例。
         */
        AutomixLoad.beginSeparation()
        try {
            while (cursor < end0) {
                if (cancelled?.invoke() == true) break
                val windowStarted = SystemClock.elapsedRealtime()
                // 尾部不足 11 秒时补零：模型形状固定，多出来的零在裁回时丢掉。
                for (channel in 0..1) {
                    val samples = if (channel == 0) left else right
                    val base = channel * PADDED
                    for (index in 0 until PADDED) {
                        val at = cursor + index
                        mono[base + index] = if (at < end0) samples[at] else 0f
                    }
                }
                stft(mono, spec, re, im)

                val input = OnnxTensor.createTensor(
                    env,
                    FloatBuffer.wrap(spec),
                    longArrayOf(1, 4, BINS.toLong(), FRAMES.toLong()),
                )
                input.use { tensor ->
                    active.run(mapOf(MODEL_INPUT to tensor)).use { result ->
                        /*
                         * 必须在这个 use 里读完：会话一关，tensor 的 buffer 就失效了。
                         * 也正因为如此，iSTFT 直接在这里做，不再把 62MB 的频谱拷出来。
                         */
                        val plane = (result[0] as OnnxTensor).floatBuffer
                        for (slot in wanted.indices) {
                            val source = wanted[slot]
                            for (channel in 0..1) {
                                istftInto(plane, source, channel, out[slot][channel], acc, tally, re, im, cursor, start0, length)
                            }
                        }
                    }
                }
                cursor += SEGMENT
                window += 1
                onProgress?.invoke(window, total)
                /*
                 * 一个窗口跑完了，让一次路。以前这里什么都不做：4 条推理线程
                 * 连跑几十个窗口，正在放的歌抢不到时间片，用户听到的是
                 * 「负载太大，卡到歌词对不上曲子」。让路比例由 AutomixLoad
                 * 按前后台 / 播放状态 / 任务数决定，空闲时几乎不让，速度不受影响。
                 */
                AutomixLoad.separationYield(SystemClock.elapsedRealtime() - windowStarted, eager)
            }
        } finally {
            AutomixLoad.endSeparation()
        }
        return Result(
            stems = wanted.indices.associate { STEMS[wanted[it]] to out[it] },
            sampleRate = SAMPLE_RATE,
            fromSample = start0,
        )
    }

    /**
     * 一帧一帧做 STFT，写进 `[4][BINS][FRAMES]`。
     *
     * 通道顺序是「先声道、再实虚」：L 实、L 虚、R 实、R 虚。
     */
    private fun stft(mono: FloatArray, out: FloatArray, re: FloatArray, im: FloatArray) {
        val half = N_FFT / 2
        val plane = BINS * FRAMES
        for (channel in 0..1) {
            val base = channel * PADDED
            for (frame in 0 until FRAMES) {
                val origin = frame * HOP - half
                for (index in 0 until N_FFT) {
                    // reflect 补边：pos < 0 时镜像到 -pos，越过末尾时镜像回来。
                    val pos = origin + index
                    val at = when {
                        pos < 0 -> -pos
                        pos >= PADDED -> 2 * PADDED - 2 - pos
                        else -> pos
                    }.coerceIn(0, PADDED - 1)
                    re[index] = mono[base + at]
                    im[index] = 0f
                }
                fft(re, im)
                // fft 已乘 1/√N，与 torch.stft 的 normalized=True 一致。
                val realPlane = channel * 2 * plane
                for (bin in 0 until BINS) {
                    val offset = realPlane + bin * FRAMES + frame
                    out[offset] = re[bin]
                    out[offset + plane] = im[bin]
                }
            }
        }
    }

    /**
     * 取 `[source][channel]` 的两路频谱，逆变换并累加到结果。
     *
     * 矩形窗、hop = N/4：每个样本被 4 帧覆盖。但段首段尾不是 —— 用实际累加的
     * `tally` 去除，边界才不会塌。
     */
    private fun istftInto(
        plane: FloatBuffer,
        source: Int,
        channel: Int,
        target: FloatArray,
        acc: FloatArray,
        tally: FloatArray,
        re: FloatArray,
        im: FloatArray,
        cursor: Int,
        start: Int,
        length: Int,
    ) {
        val size = BINS * FRAMES
        val base = (source * 2 + channel) * 2 * size
        val half = N_FFT / 2
        java.util.Arrays.fill(acc, 0f)
        java.util.Arrays.fill(tally, 0f)
        for (frame in 0 until FRAMES) {
            for (bin in 0 until BINS) {
                re[bin] = plane.get(base + bin * FRAMES + frame)
                im[bin] = plane.get(base + size + bin * FRAMES + frame)
            }
            irfft(re, im)
            val origin = frame * HOP
            for (index in 0 until N_FFT) {
                val at = origin + index
                if (at >= acc.size) break
                acc[at] += re[index]
                tally[at] += 1f
            }
        }
        /*
         * center = true：帧 0 的中心落在样本 0 上，可它在补边后的时间轴里是第 half 个。
         * 所以有效信号是 acc[half .. half + PADDED)，不是 acc[0 .. PADDED)。
         */
        val offset = cursor - start
        for (index in 0 until PADDED) {
            val to = offset + index
            if (to >= length) break
            val at = half + index
            val w = if (tally[at] > 0f) tally[at] else 1f
            target[to] += acc[at] / w
        }
    }

    /** 由 2049 个频点重建 4096 点实信号（正交归一化的逆）。 */
    private fun irfft(re: FloatArray, im: FloatArray) {
        val n = re.size
        // 共轭对称补全：k 与 n-k 互为共轭。
        for (k in n / 2 + 1 until n) {
            re[k] = re[n - k]
            im[k] = -im[n - k]
        }
        // ifft(x) = conj(fft(conj(x)))，fft 已带 1/√n，两次正好是 1/n。
        for (k in 0 until n) im[k] = -im[k]
        fft(re, im)
        for (k in 0 until n) im[k] = -im[k]
    }

    /** 原地基 2 FFT，末尾乘 1/√n（正交归一化，与 torch.stft 的 normalized=True 一致）。 */
    private fun fft(re: FloatArray, im: FloatArray) {
        val n = re.size
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
        val scale = 1f / sqrt(n.toFloat())
        for (i in 0 until n) {
            re[i] *= scale
            im[i] *= scale
        }
    }
}
