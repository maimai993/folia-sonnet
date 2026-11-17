package top.izuna.foliamajor.automix

import kotlin.math.exp
import kotlin.math.ln

// 当前文件：混音鼓点三条频带（kick / snare / hat）的边界与 mel 带归属（#344）。
//
// 纯 Kotlin、不碰 ONNX / Android，JVM 单测直接跑。边界必须与 Web 侧 `src/services/analysis/drumHitPicking.ts`
// 的 KICK_MAX_HZ / SNARE_MAX_HZ / HAT_MIN_HZ 一致，**包括 snare 与 hat 之间 4000–6000 Hz 的空档**：
// 那一段不属于任何一条带。以前 Android 把 hat 起点写成 4000，4–6 kHz 的军鼓高频被算进 hat，
// 鼓面偏弱、偏碎；Web 与 Android 对同一首歌挑出的 hit 也就不一样。

object DrumBandEdges {
    const val KICK_MAX_HZ = 150.0
    const val SNARE_MAX_HZ = 4000.0
    const val HAT_MIN_HZ = 6000.0

    /** 三条带的 [from, to) 频率范围，顺序 kick / snare / hat。hat 的上界是正无穷。 */
    val BANDS: Array<DoubleArray> = arrayOf(
        doubleArrayOf(0.0, KICK_MAX_HZ),
        doubleArrayOf(KICK_MAX_HZ, SNARE_MAX_HZ),
        doubleArrayOf(HAT_MIN_HZ, Double.POSITIVE_INFINITY),
    )

    /** 与 Web `melBandCentresHz()` 同一条公式（Slaney mel，见 beatThis.ts）。 */
    fun melBandCentres(nMels: Int, fMin: Double, fMax: Double): DoubleArray {
        val melMin = hzToMel(fMin)
        val melMax = hzToMel(fMax)
        return DoubleArray(nMels) { melToHz(melMin + (melMax - melMin) * (it + 1) / (nMels + 1)) }
    }

    /** 第 [kind] 条带包含哪些 mel 带（中心频率落在 [from, to) 里的）。 */
    fun pickBands(centres: DoubleArray, kind: Int): List<Int> {
        val from = BANDS[kind][0]
        val to = BANDS[kind][1]
        return centres.indices.filter { centres[it] >= from && centres[it] < to }
    }

    fun hzToMel(hz: Double): Double {
        val fSp = 200.0 / 3.0
        if (hz < 1000.0) return hz / fSp
        return 1000.0 / fSp + ln(hz / 1000.0) / (ln(6.4) / 27.0)
    }

    fun melToHz(mel: Double): Double {
        val fSp = 200.0 / 3.0
        val minLogMel = 1000.0 / fSp
        if (mel < minLogMel) return fSp * mel
        return 1000.0 * exp((ln(6.4) / 27.0) * (mel - minLogMel))
    }
}
