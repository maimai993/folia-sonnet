package top.izuna.foliamajor.automix

import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * 人声净曲线：把鼓在 250–2000Hz 里的残留从已分离的 vocals 轨里扣掉。
 *
 * ## 为什么换了分轨模型也还是跟鼓抖
 *
 * 军鼓的能量主体落在 **150–2500Hz**，男声基频（85–180）、女声基频（165–255）
 * 和它们的前几次谐波全在这段里。也就是说：**人声频段和军鼓频段本来就重叠**。
 * 任何四轨模型（htdemucs、SCNet、换多大的都一样）的 vocals 轨都会留一层鼓的瞬态——
 * 这不是模型能力问题，是频段重叠。拿 250–2000 做带通再取 RMS，鼓每敲一下，
 * 这条曲线就跳一下，逐字缩放的字就跟着抖。
 *
 * 所以换模型解决不了这件事。能解决的是：**同一时刻，鼓轨也在手里**。
 * 两条波形都分离出来了，把鼓在该频段的贡献减掉，剩下的才是人声。
 *
 * ## 三步，都在帧级（25 帧/秒，与 envelopeBlock 一致）
 *
 * 1. **能量域谱减**：`sqrt(max(0, v² − (k·d)²))`。用能量减而不是幅度减，
 *    因为两条 RMS 各自的平方才是能量；k = 0.6 是留余量，按 1.0 减会把齿音一起削掉。
 * 2. **鼓击门控**：只看鼓包络的**上升沿**（`d[i] − d[i−1]`），只在击打那一下压。
 *    副歌里鼓一直在响，按绝对能量压会把整段歌词压死——这是最容易踩的坑。
 * 3. **3 点中值 + 一阶跟随**：中值把 40ms 的孤峰整根拔掉（低通只会把它抹成鼓包），
 *    再双向慢跟随，只留 1~3 秒的乐句起伏。
 */
object VocalCurve {

    /** 与枚举块一致的帧率：25 帧/秒，40ms 一格。 */
    const val FPS = 25

    /** 带通下沿：男声基频 85–180 的二次谐波以上，同时避开底鼓与贝斯的基频。 */
    private const val LOW_HZ = 250.0

    /** 带通上沿：2k 以上基本是辅音气声，交给 vocalAir 单独一条。 */
    private const val HIGH_HZ = 2000.0

    /** 谱减深度。留余量，不按 1.0 减。 */
    private const val SUBTRACT = 0.6f

    /** 鼓击瞬间最多压掉多少：留 0.12，不让曲线在每一下军鼓上塌成 0。 */
    private const val GATE_DEPTH = 0.88f

    /** 一阶跟随系数。40ms × 0.34 ≈ 一句唱腔的起落时间常数。 */
    private const val FOLLOW = 0.34f

    /**
     * 一条轨的带限 RMS 包络：每 `hop` 个样本一个值。
     *
     * `lowHz` / `highHz` 是带通的下、上截止，0 表示不设这一侧的界。用两个一阶低通相减
     * 得到带内分量（上限低通 减 下限低通），不是严格的滤波器组，但对 25fps 的能量包络
     * 足够——这里要的是「这一刻这一频段有多响」，不是要还原波形。
     *
     * 两条声道各算各的低通会串相位，所以先混成单声道再滤。
     */
    fun bandRms(
        stem: Array<FloatArray>?,
        hop: Int,
        lowHz: Double,
        highHz: Double,
        sampleRate: Int = ScnetRunner.SAMPLE_RATE,
    ): FloatArray {
        if (stem == null || stem.isEmpty() || stem[0].isEmpty()) return FloatArray(0)
        val left = stem[0]
        val right = if (stem.size > 1) stem[1] else left
        val total = left.size
        val safeHop = hop.coerceAtLeast(1)
        val out = FloatArray((total + safeHop - 1) / safeHop)
        val alphaHigh = if (highHz > 0.0) lowPassAlpha(highHz, sampleRate) else 0f
        val alphaLow = if (lowHz > 0.0) lowPassAlpha(lowHz, sampleRate) else 0f
        var lpHigh = 0.0
        var lpLow = 0.0
        var frame = 0
        var count = 0
        var sum = 0.0
        for (index in 0 until total) {
            val mono = (left[index] + (if (index < right.size) right[index] else left[index])) * 0.5
            lpHigh = if (alphaHigh > 0f) lpHigh + alphaHigh * (mono - lpHigh) else mono
            lpLow = if (alphaLow > 0f) lpLow + alphaLow * (mono - lpLow) else 0.0
            val band = lpHigh - lpLow
            sum += band * band
            count += 1
            if (count == safeHop || index == total - 1) {
                out[frame] = sqrt(sum / count).toFloat()
                frame += 1
                sum = 0.0
                count = 0
            }
        }
        return out
    }

    /** 一阶低通的系数：a = 1 − e^(−2π·fc/fs)。截止频率远低于采样率时这个近似很稳。 */
    private fun lowPassAlpha(cutoffHz: Double, sampleRate: Int): Float =
        (1.0 - exp(-2.0 * Math.PI * cutoffHz / sampleRate)).toFloat()

    /**
     * 人声净曲线。
     *
     * `drums` 为空（这首歌没有鼓、或者只分离了人声）时退化成「带通 + 平滑」，
     * 仍然比直接读 vocals 整轨干净，只是没有谱减那一步。
     */
    fun envelope(
        vocals: Array<FloatArray>?,
        drums: Array<FloatArray>?,
        hop: Int,
        sampleRate: Int = ScnetRunner.SAMPLE_RATE,
    ): FloatArray {
        val vocalBand = bandRms(vocals, hop, LOW_HZ, HIGH_HZ, sampleRate)
        if (vocalBand.isEmpty()) return vocalBand
        val n = vocalBand.size
        val drumBand = bandRms(drums, hop, LOW_HZ, HIGH_HZ, sampleRate)
        val gateSource = if (drumBand.size == n) drumBand else FloatArray(n) { drumBand.getOrElse(it) { 0f } }

        val gated = FloatArray(n)
        for (i in 0 until n) {
            val noise = SUBTRACT * gateSource[i]
            val clean = sqrt(max(0f, vocalBand[i] * vocalBand[i] - noise * noise))
            val previous = if (i > 0) gateSource[i - 1] else gateSource[i]
            val rise = max(0f, gateSource[i] - previous)
            // 相对上升率：鼓击那一下接近 1，持续段（包括副歌）接近 0。
            val relative = if (gateSource[i] > 1e-5f) (rise / gateSource[i]).coerceIn(0f, 1f) else 0f
            gated[i] = clean * (1f - GATE_DEPTH * relative)
        }

        // 3 点中值：med(a,b,c) = max(min(a,b), min(max(a,b), c))。
        val median = FloatArray(n)
        for (i in 0 until n) {
            median[i] = when {
                i == 0 || i == n - 1 -> gated[i]
                else -> {
                    val a = gated[i - 1]
                    val b = gated[i]
                    val c = gated[i + 1]
                    max(min(a, b), min(max(a, b), c))
                }
            }
        }

        val out = FloatArray(n)
        var level = 0f
        for (i in 0 until n) {
            level += (median[i] - level) * FOLLOW
            out[i] = level
        }
        return out
    }
}
