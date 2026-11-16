package top.izuna.foliamajor.automix

import kotlin.math.cos
import kotlin.math.sin

/**
 * 原地基-2 复数快速傅里叶变换（长度必须是 2 的幂）。
 *
 * 只有一个实现，三个调用方：节拍模型的 log-mel 前处理（[BeatThisRunner]）、
 * 基频的自相关（[AudioFeatures]）、和弦的色度谱（同样在 [AudioFeatures]）。
 * 以前节拍那边自己写了一份私有的；再抄第二份就一定会有一次「只改了一边」的漂移，
 * 而这种漂移在音频里表现为「音高整体偏低半个音」这类极难查的错。
 */
object Fft {

    /** 正变换：输入时域 → 输出频域（原地）。 */
    fun forward(real: FloatArray, imag: FloatArray) = transform(real, imag, inverse = false)

    /** 逆变换：输入频域 → 输出时域（原地，含 1/N 归一）。 */
    fun inverse(real: FloatArray, imag: FloatArray) = transform(real, imag, inverse = true)

    private fun transform(real: FloatArray, imag: FloatArray, inverse: Boolean) {
        val n = real.size
        require(imag.size == n) { "实部虚部长度必须一致：${real.size} vs ${imag.size}" }
        require(n and (n - 1) == 0) { "长度必须是 2 的幂：$n" }

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
        val sign = if (inverse) 1.0 else -1.0
        var length = 2
        while (length <= n) {
            val angle = sign * 2.0 * Math.PI / length
            val wReal = cos(angle).toFloat()
            val wImag = sin(angle).toFloat()
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

        if (inverse) {
            val scale = 1f / n
            for (index in 0 until n) {
                real[index] *= scale
                imag[index] *= scale
            }
        }
    }
}
