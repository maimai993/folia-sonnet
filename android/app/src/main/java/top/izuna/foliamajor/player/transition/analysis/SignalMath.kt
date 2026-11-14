package top.izuna.foliamajor.player.transition.analysis

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt
import top.izuna.foliamajor.player.transition.BandBalance

// android/app/src/main/java/top/izuna/foliamajor/player/transition/analysis/SignalMath.kt
// 分析层共用的数学：RMS / dB、K 计权近似、自相关测速、FFT、色度、三频段能量。
// 全部是纯函数、输入是降采样后的单声道 FloatArray，因此可以直接跑 JVM 单测，
// 对应 Web 侧 automix/signalAnalysis.ts，但不依赖 OfflineAudioContext。

object SignalMath {

    const val SILENCE_DB = -60f
    const val ANALYSIS_RATE = 11_025

    fun gainToDb(gain: Float): Float =
        if (gain <= 1e-6f) SILENCE_DB else (20f * log10(gain.toDouble())).toFloat()

    fun dbToGain(db: Float): Float = 10f.pow(db / 20f)

    fun rms(samples: FloatArray, from: Int, to: Int): Float {
        val a = from.coerceAtLeast(0)
        val b = to.coerceAtMost(samples.size)
        if (b <= a) return 0f
        var sum = 0.0
        var i = a
        while (i < b) {
            val v = samples[i].toDouble()
            sum += v * v
            i++
        }
        return sqrt(sum / (b - a)).toFloat()
    }

    fun rmsDb(samples: FloatArray, from: Int, to: Int): Float = gainToDb(rms(samples, from, to))

    /**
     * K 计权的高架 + 高通近似（ITU-R BS.1770 的简化版）：两级双二阶系数直接写成
     * 一阶差分，够用来比较两首歌的相对响度，不用于对外报告绝对 LUFS。
     */
    fun kWeight(samples: FloatArray): FloatArray {
        val out = FloatArray(samples.size)
        var x1 = 0f; var x2 = 0f; var y1 = 0f; var y2 = 0f
        // 高架 ~ +4 dB @ 2 kHz
        val b0 = 1.535f; val b1 = -2.58f; val b2 = 1.11f
        val a1 = -1.66f; val a2 = 0.69f
        for (i in samples.indices) {
            val x = samples[i]
            var y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            // 高通 ~ 38 Hz
            y -= 0.98f * (y1 - x1)
            if (!y.isFinite()) y = 0f
            out[i] = y
            x2 = x1; x1 = x
            y2 = y1; y1 = y
        }
        return out
    }

    fun loudnessLufs(samples: FloatArray, sampleRate: Int): Float? {
        if (samples.isEmpty()) return null
        val weighted = kWeight(samples)
        // 400 ms 块、75% 重叠，取能量前 20% 的块均值（简化 gating）。
        val block = (sampleRate * 0.4f).roundToInt().coerceAtLeast(1)
        val hop = (block * 0.25f).roundToInt().coerceAtLeast(1)
        val energies = ArrayList<Float>()
        var start = 0
        while (start + block <= weighted.size) {
            val r = rms(weighted, start, start + block)
            energies.add(r * r + 1e-9f)
            start += hop
        }
        if (energies.isEmpty()) return null
        val sorted = energies.sortedDescending()
        val take = max(1, (sorted.size * 0.2f).roundToInt())
        var sum = 0.0
        for (i in 0 until take) sum += sorted[i].toDouble()
        val mean = sum / take
        return (-0.691 + 10.0 * log10(mean)).toFloat().coerceIn(-70f, 0f)
    }

    /** 数字静音边缘：从两端往里找第一个超过阈值的样本。 */
    fun silenceEdges(samples: FloatArray, sampleRate: Int, thresholdDb: Float = -50f): Pair<Long, Long> {
        val threshold = dbToGain(thresholdDb)
        val step = (sampleRate * 0.02f).roundToInt().coerceAtLeast(1)
        fun firstLoud(): Int {
            var i = 0
            while (i < samples.size) {
                if (rms(samples, i, minOf(i + step, samples.size)) > threshold) return i
                i += step
            }
            return samples.size
        }
        fun lastLoud(): Int {
            var i = samples.size
            while (i > 0) {
                val a = maxOf(0, i - step)
                if (rms(samples, a, i) > threshold) return i
                i = a
            }
            return 0
        }
        val head = firstLoud()
        val tail = (samples.size - lastLoud()).coerceAtLeast(0)
        return Pair((head * 1000L) / sampleRate, (tail * 1000L) / sampleRate)
    }

    /**
     * 自相关测速：对能量包络做 40..240 BPM 范围的自相关，挑最强峰，再折半 / 倍速归一。
     * 返回 (bpm, confidence)。这是 Web 侧 estimateTempo 的原生对应，精度不如 Beat This!，
     * 但零权重、零 so，且置信度会如实写进 BeatGrid —— 规划层据此决定要不要用拍点类效果。
     */
    fun estimateTempo(envelope: FloatArray, sampleRate: Int, envelopeHop: Int): Pair<Float, Float>? {
        if (envelope.size < 64) return null
        val hopSeconds = envelopeHop.toFloat() / sampleRate.toFloat()
        val minLag = (60f / 240f / hopSeconds).roundToInt().coerceAtLeast(2)
        val maxLag = (60f / 40f / hopSeconds).roundToInt().coerceAtMost(envelope.size / 2)
        if (maxLag <= minLag) return null

        var mean = 0.0
        for (v in envelope) mean += v.toDouble()
        mean /= envelope.size
        val centered = FloatArray(envelope.size) { (envelope[it] - mean).toFloat() }

        var bestLag = -1
        var bestScore = 0.0
        var total = 0.0
        val scores = DoubleArray(maxLag + 1)
        for (lag in minLag..maxLag) {
            var sum = 0.0
            var n = 0
            var i = 0
            while (i + lag < centered.size) {
                sum += centered[i].toDouble() * centered[i + lag].toDouble()
                n++
                i++
            }
            val score = if (n > 0) sum / n else 0.0
            scores[lag] = score
            total += abs(score)
            if (score > bestScore) { bestScore = score; bestLag = lag }
        }
        if (bestLag <= 0 || total <= 0.0) return null

        // 置信度：主峰相对平均自相关的突出程度。0.35 以上才允许用拍点类效果。
        val average = total / (maxLag - minLag + 1)
        val confidence = (bestScore / (average + 1e-9) / 6.0).toFloat().coerceIn(0f, 1f)
        var bpm = 60f / (bestLag * hopSeconds)
        while (bpm < 70f) bpm *= 2f
        while (bpm > 180f) bpm /= 2f
        return Pair(bpm, confidence)
    }

    /** 能量包络：每 hop 个样本一个 RMS，再做一阶差分取正向变化（onset）。 */
    fun onsetEnvelope(samples: FloatArray, hop: Int = 256): FloatArray {
        if (samples.isEmpty()) return FloatArray(0)
        val n = (samples.size + hop - 1) / hop
        val raw = FloatArray(n) { rms(samples, it * hop, minOf((it + 1) * hop, samples.size)) }
        val out = FloatArray(n)
        for (i in 1 until n) out[i] = max(0f, raw[i] - raw[i - 1])
        return out
    }

    /** 迭代 Cooley-Tukey FFT，原地处理实部 / 虚部。长度必须是 2 的幂。 */
    fun fft(real: FloatArray, imag: FloatArray) {
        val n = real.size
        if (n < 2 || (n and (n - 1)) != 0) return
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while ((j and bit) != 0) { j = j xor bit; bit = bit shr 1 }
            j = j xor bit
            if (i < j) {
                val tr = real[i]; real[i] = real[j]; real[j] = tr
                val ti = imag[i]; imag[i] = imag[j]; imag[j] = ti
            }
        }
        var len = 2
        while (len <= n) {
            val ang = -2.0 * Math.PI / len
            val wr = cos(ang).toFloat(); val wi = sin(ang).toFloat()
            var i = 0
            while (i < n) {
                var cr = 1f; var ci = 0f
                for (k in 0 until len / 2) {
                    val ur = real[i + k]; val ui = imag[i + k]
                    val vr = real[i + k + len / 2] * cr - imag[i + k + len / 2] * ci
                    val vi = real[i + k + len / 2] * ci + imag[i + k + len / 2] * cr
                    real[i + k] = ur + vr; imag[i + k] = ui + vi
                    real[i + k + len / 2] = ur - vr; imag[i + k + len / 2] = ui - vi
                    val nr = cr * wr - ci * wi
                    ci = cr * wi + ci * wr
                    cr = nr
                }
                i += len
            }
            len = len shl 1
        }
    }

    private fun hann(n: Int): FloatArray = FloatArray(n) {
        (0.5 - 0.5 * cos(2.0 * Math.PI * it / (n - 1))).toFloat()
    }

    /** 频谱三频段能量占比（低 <250 Hz，中 250..4k，高 >4k）。 */
    fun bandBalance(samples: FloatArray, sampleRate: Int, from: Int, to: Int, fftSize: Int = 2048): BandBalance {
        val window = hann(fftSize)
        var low = 0.0; var mid = 0.0; var high = 0.0
        var pos = from.coerceAtLeast(0)
        val end = to.coerceAtMost(samples.size)
        var blocks = 0
        while (pos + fftSize <= end) {
            val re = FloatArray(fftSize); val im = FloatArray(fftSize)
            for (i in 0 until fftSize) re[i] = samples[pos + i] * window[i]
            fft(re, im)
            for (k in 1 until fftSize / 2) {
                val freq = k.toDouble() * sampleRate / fftSize
                val mag = re[k] * re[k] + im[k] * im[k]
                when {
                    freq < 250.0 -> low += mag
                    freq < 4_000.0 -> mid += mag
                    else -> high += mag
                }
            }
            blocks++
            pos += fftSize / 2
        }
        if (blocks == 0) return BandBalance.FLAT
        val sum = low + mid + high
        if (sum <= 0.0) return BandBalance.FLAT
        return BandBalance(
            (low / sum).toFloat(), (mid / sum).toFloat(), (high / sum).toFloat(),
        )
    }

    /** 12 音级色度：返回主音级 0..11，测不出返回 -1。 */
    fun dominantChroma(samples: FloatArray, sampleRate: Int, from: Int, to: Int, fftSize: Int = 4096): Int {
        val window = hann(fftSize)
        val chroma = DoubleArray(12)
        var pos = from.coerceAtLeast(0)
        val end = to.coerceAtMost(samples.size)
        var blocks = 0
        while (pos + fftSize <= end) {
            val re = FloatArray(fftSize); val im = FloatArray(fftSize)
            for (i in 0 until fftSize) re[i] = samples[pos + i] * window[i]
            fft(re, im)
            for (k in 1 until fftSize / 2) {
                val freq = k.toDouble() * sampleRate / fftSize
                if (freq < 55.0 || freq > 2_000.0) continue
                val mag = sqrt((re[k] * re[k] + im[k] * im[k]).toDouble())
                val midi = (69.0 + 12.0 * ln(freq / 440.0) / ln(2.0)).roundToInt()
                chroma[((midi % 12) + 12) % 12] += mag
            }
            blocks++
            pos += fftSize / 2
        }
        if (blocks == 0) return -1
        var best = -1
        var bestValue = 0.0
        val total = chroma.sum()
        for (i in 0..11) {
            if (chroma[i] > bestValue) { bestValue = chroma[i]; best = i }
        }
        // 太平均说明没有明确调性，别拿一个随机峰值去算调性关系。
        return if (total > 0 && bestValue / total > 0.14) best else -1
    }
}
