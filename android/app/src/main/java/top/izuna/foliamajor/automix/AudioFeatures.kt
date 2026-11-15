package top.izuna.foliamajor.automix

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.roundToInt

/**
 * 从**已分离的人声轨**上读出三件「音乐语义」，都不需要额外的模型：
 *
 *   · 发声（voicing）—— 这一帧是不是有人在唱（有稳定的基频周期）
 *   · 基频（pitch）   —— 唱到多高，换算成 55–880Hz 四个八度里的位置 0..1
 *   · 和弦 / 调性     —— 12 维色度谱 → 24 个三和弦模板匹配 → 逐帧根音与大小调
 *
 * 为什么是「从人声轨」：色度谱本该从整混音取，但整混音里有鼓，鼓的宽频瞬态会把每一维
 * 都抬起来，和弦就会跟着鼓点乱跳。人声轨 + 其余乐器轨各占一半，鼓已经被分轨拿掉了。
 *
 * 为什么不用模型：这三个量的经典做法本来就是信号处理，CREPE 那种 F0 网络在手机上
 * 多占 10MB 换来的是「更平滑的小数音高」，而这里要的是「这一句在往上走还是往下走」，
 * 自相关足够，还不用多一次前向。
 *
 * 成本：每帧两次 2048 点 FFT（一次求自相关、一次求色度），四分钟约 6000 帧。
 * 与一次分轨推理（几分钟）比可以忽略，所以直接放在同一条后台线程里算。
 */
object AudioFeatures {

    /** 与 envelopeBlock 一致的帧率。 */
    const val FPS = 25

    /** 分析用的采样率：11025Hz。44.1k 整除 4、22.05k 整除 2，都不需要重采样滤波器。 */
    private const val SR = 11_025

    /** 分析窗 1024 点（93ms）。55Hz 的一个周期 200 点，窗里能装五个，够自相关用。 */
    private const val WINDOW = 1024

    /** FFT 长度：窗长两倍，给自相关留出线性的范围。 */
    private const val FFT_N = 2048

    /** 基频搜索范围：1380Hz（假声上限）到 55Hz（男低音下限）。 */
    private const val MIN_LAG = 8
    private const val MAX_LAG = 200

    /** 音高归一的参照：55Hz 起，四个八度到 880Hz。 */
    private const val PITCH_BASE_HZ = 55.0
    private const val PITCH_STEPS = 48.0

    /** YIN 的绝对门限：归一化差分低于它就算「这个周期是可信的」。 */
    private const val YIN_THRESHOLD = 0.15f

    /** 和弦切换的迟滞：新和弦要比当前高这么多才换，免得在两句之间来回跳。 */
    private const val CHORD_MARGIN = 0.035f

    /** 色度谱的取用范围。低于 100Hz 分不出半音，高于 2kHz 全是人声齿音和泛音堆。 */
    private const val CHROMA_LOW_HZ = 100.0
    private const val CHROMA_HIGH_HZ = 2000.0

    data class Result(
        /** 0..1，这一帧有稳定基频的概率。 */
        val voicing: FloatArray,
        /** 0..1，基频在 55–880Hz 里的位置；清音帧为 0。 */
        val pitch: FloatArray,
        /** 0..1，根音 / 12。 */
        val chordRoot: FloatArray,
        /** 0..1，0 是大三和弦、1 是小三和弦。 */
        val chordMinor: FloatArray,
        /** 12 维平均色度（和为 1），给 Web 侧算整曲调性。 */
        val chromaMean: FloatArray,
    )

    /** 空结果：静音段、或这段没跑推理时用。 */
    fun empty(frames: Int): Result = Result(
        voicing = FloatArray(frames),
        pitch = FloatArray(frames),
        chordRoot = FloatArray(frames),
        chordMinor = FloatArray(frames),
        chromaMean = FloatArray(12),
    )

    /**
     * 一次算完三条曲线 + 平均色度。
     *
     * `hop` 是 44.1kHz 下的采样步长（envelopeBlock 传 1764）。降采样后每帧走 `hop/4` 点。
     */
    fun analyze(
        vocals: Array<FloatArray>?,
        instruments: Array<FloatArray>?,
        hop: Int,
        frames: Int,
        sampleRate: Int = ScnetRunner.SAMPLE_RATE,
    ): Result {
        if (frames <= 0) return empty(0)
        val decimation = (sampleRate / SR).coerceAtLeast(1)
        val voiceMono = decimate(vocals, decimation)
        val instrumentMono = decimate(instruments, decimation)
        // 两条都空就没有任何可算的东西（纯静音段）。
        if (voiceMono.isEmpty() && instrumentMono.isEmpty()) return empty(frames)
        val hasInstruments = instrumentMono.isNotEmpty() && voiceMono.isNotEmpty()

        val step = (hop / decimation).coerceAtLeast(1)
        val voicing = FloatArray(frames)
        val pitch = FloatArray(frames)
        val chordRoot = FloatArray(frames)
        val chordMinor = FloatArray(frames)
        val chromaMean = FloatArray(12)

        val hann = FloatArray(WINDOW) { index ->
            (0.5 * (1.0 - cos(2.0 * Math.PI * index / WINDOW))).toFloat()
        }
        val re = FloatArray(FFT_N)
        val im = FloatArray(FFT_N)
        val power = FloatArray(FFT_N / 2 + 1)
        val binHz = SR.toDouble() / FFT_N

        // 逐帧的色度：人声占一半，其余乐器占一半（和弦主要在伴奏里，根音常在贝斯上）。
        val chroma = FloatArray(12)
        var currentRoot = -1
        var currentMinor = 0
        var currentScore = 0f

        for (frame in 0 until frames) {
            val start = frame * step
            re.fill(0f)
            im.fill(0f)
            var energy = 0.0
            for (index in 0 until WINDOW) {
                val at = start + index
                val voice = if (at < voiceMono.size) voiceMono[at] else 0f
                val instrument = if (at < instrumentMono.size) instrumentMono[at] else 0f
                /*
                 * 两条轨等权相加：人声轨决定「有没有唱」，乐器轨决定「唱的是什么和弦」。
                 * 只给了一条（基线阶段还没有分轨，人声和乐器是同一条混音）就整条用上，
                 * 免得把一个 0.25 的增益带进能量门限里。
                 */
                val sample = if (hasInstruments) (voice + instrument) * 0.5f * hann[index] else voice * hann[index]
                re[index] = sample
                energy += sample.toDouble() * sample
            }
            if (energy < 1e-7) {
                // 这一段是静音：保持上一帧的和弦（不要让和弦在静音里乱跳），音高给 0。
                if (currentRoot >= 0) {
                    chordRoot[frame] = currentRoot / 12f
                    chordMinor[frame] = currentMinor.toFloat()
                }
                continue
            }

            Fft.forward(re, im)
            for (bin in power.indices) {
                power[bin] = re[bin] * re[bin] + im[bin] * im[bin]
            }

            // ── 色度谱：把功率谱按音高类折叠成 12 维 ──
            chroma.fill(0f)
            var chromaSum = 0.0
            for (bin in 1 until power.size) {
                val hz = bin * binHz
                if (hz < CHROMA_LOW_HZ || hz > CHROMA_HIGH_HZ) continue
                /*
                 * 以 A=440 为原点的半音数，再挪到「C = 0」的编号上。
                 *
                 * 不挪的话 0 号是 A：C 大三和弦会被判成 3 号（D#），整首歌的根音
                 * 全部偏三个半音 —— 这正是「和弦看着在跳、但和听到的对不上」的样子。
                 * A 在 C 起算的十二个音里是 9 号。
                 */
                val semitone = 12.0 * ln(hz / 440.0) / ln(2.0)
                val pitchClass = ((semitone.roundToInt() + 9) % 12 + 12) % 12
                // 取幅度而不是功率：功率会让高次谐波压过基音，和弦根音就听不出来了。
                val value = Math.sqrt(power[bin].toDouble()).toFloat()
                chroma[pitchClass] += value
                chromaSum += value
            }
            if (chromaSum > 1e-6) {
                for (index in 0 until 12) {
                    chroma[index] = (chroma[index] / chromaSum).toFloat()
                    chromaMean[index] += chroma[index]
                }
            }

            // ── 音高：自相关 → YIN 累积均值归一化差分 ──
            val f0 = estimatePitch(re, im, power, energy)
            voicing[frame] = f0.first
            pitch[frame] = f0.second

            // ── 和弦：24 个三和弦模板里挑最像的，带迟滞 ──
            if (chromaSum > 1e-6) {
                val best = matchChord(chroma)
                val root = best.first
                val minor = best.second
                val score = best.third
                if (currentRoot < 0 || (root != currentRoot || minor != currentMinor) && score > currentScore + CHORD_MARGIN) {
                    currentRoot = root
                    currentMinor = minor
                    currentScore = score
                } else if (root == currentRoot && minor == currentMinor) {
                    // 同一个和弦持续时更新分数，让它缓慢贴合当下的响度。
                    currentScore = currentScore * 0.8f + score * 0.2f
                }
                chordRoot[frame] = currentRoot / 12f
                chordMinor[frame] = currentMinor.toFloat()
            } else if (currentRoot >= 0) {
                chordRoot[frame] = currentRoot / 12f
                chordMinor[frame] = currentMinor.toFloat()
            }
        }

        if (chromaMean.any { it > 0f }) {
            val sum = chromaMean.sum()
            if (sum > 1e-6) for (index in 0 until 12) chromaMean[index] /= sum
        }
        return Result(voicing, pitch, chordRoot, chordMinor, chromaMean)
    }

    /** 混成单声道再按 `decimation` 点平均降采样。 */
    private fun decimate(stem: Array<FloatArray>?, decimation: Int): FloatArray {
        if (stem == null || stem.isEmpty() || stem[0].isEmpty()) return FloatArray(0)
        val left = stem[0]
        val right = if (stem.size > 1 && stem[1].size == left.size) stem[1] else left
        val out = FloatArray(left.size / decimation)
        for (index in out.indices) {
            var sum = 0f
            val base = index * decimation
            for (offset in 0 until decimation) {
                val at = base + offset
                if (at < left.size) sum += (left[at] + right[at]) * 0.5f
            }
            out[index] = sum / decimation
        }
        return out
    }

    /**
     * 自相关 + YIN，返回 (发声度, 音高位置)。
     *
     * `re` / `im` 传进来时是**频域**的（刚做完正变换），这里就地改成自相关再逆变换。
     * 复用同一块内存，避免每帧新建两个 2048 的数组 —— 6000 帧下那是 12 万次分配。
     */
    private fun estimatePitch(re: FloatArray, im: FloatArray, power: FloatArray, energy: Double): Pair<Float, Float> {
        // 自相关 = 功率谱的逆变换
        for (index in 0 until FFT_N / 2 + 1) {
            re[index] = power[index]
            im[index] = 0f
        }
        for (index in FFT_N / 2 + 1 until FFT_N) {
            re[index] = power[FFT_N - index]
            im[index] = 0f
        }
        Fft.inverse(re, im)

        val r0 = re[0]
        if (r0 <= 1e-9f) return 0f to 0f

        /*
         * YIN 的差分函数：d(τ) ≈ 2·(r(0) − r(τ))。
         *
         * 直接看 r(τ)/r(0) 会被「滞后越长、重叠越少」的系统性衰减带偏，唱得越高反而
         * 越像清音；差分函数把这条基线减掉了，这才是能直接卡门限的量。
         */
        val diff = FloatArray(MAX_LAG + 1)
        var running = 0f
        for (lag in 1..MAX_LAG) {
            diff[lag] = 2f * (r0 - re[lag])
            running += diff[lag]
            // 累积均值归一化：短滞后那一段天然偏小，不归一化就会一直选到最低的 lag。
            if (running > 1e-9f) diff[lag] = diff[lag] * lag / running
        }

        var bestLag = -1
        var bestValue = Float.MAX_VALUE
        /*
         * 取**第一个**低于门限的谷：不是全局最小值。
         *
         * 全局最小值常常落在两倍周期上（差一点也能对上），取它会让整首歌的音高系统性
         * 低一个八度 —— 听感上就是「歌词的起伏整体压扁、永远在低处晃」。
         * 所以一进谷就顺着下降沿走到底，停在那里。
         */
        var lag = MIN_LAG
        while (lag <= MAX_LAG) {
            if (diff[lag] < YIN_THRESHOLD) {
                while (lag + 1 <= MAX_LAG && diff[lag + 1] < diff[lag]) lag += 1
                bestLag = lag
                bestValue = diff[lag]
                break
            }
            lag += 1
        }
        if (bestLag < 0) return 0f to 0f

        // 抛物线插值：整数 lag 的精度在 1kHz 处只有 3%，插值后能到 0.3%。
        var refined = bestLag.toFloat()
        if (bestLag > 1 && bestLag < MAX_LAG) {
            val a = diff[bestLag - 1]
            val b = diff[bestLag]
            val c = diff[bestLag + 1]
            val denominator = 2f * (2f * b - a - c)
            if (abs(denominator) > 1e-9f) refined += (c - a) / denominator
        }
        val hz = SR / refined
        if (hz < 40f || hz > 1500f) return 0f to 0f

        val voicing = (1f - bestValue / (YIN_THRESHOLD * 2f)).coerceIn(0f, 1f)
        val steps = 12.0 * ln(hz / PITCH_BASE_HZ) / ln(2.0)
        val normalized = (steps / PITCH_STEPS).coerceIn(0.0, 1.0).toFloat()
        return voicing to normalized
    }

    /** 24 个三和弦模板（12 根音 × 大小调）里挑最像的，返回 (根音, 是否小调, 得分)。 */
    private fun matchChord(chroma: FloatArray): Triple<Int, Int, Float> {
        val major = intArrayOf(0, 4, 7)
        val minor = intArrayOf(0, 3, 7)
        var bestRoot = 0
        var bestMinor = 0
        var bestScore = -1f
        for (root in 0 until 12) {
            for (kind in 0..1) {
                val shape = if (kind == 0) major else minor
                var score = 0f
                for (tone in shape) score += chroma[(root + tone) % 12]
                // 模板只有三个音，落在其余九个音上的能量就是「不像」的部分：减掉它。
                score -= 0.25f * (1f - score)
                if (score > bestScore) {
                    bestScore = score
                    bestRoot = root
                    bestMinor = kind
                }
            }
        }
        return Triple(bestRoot, bestMinor, bestScore)
    }
}
