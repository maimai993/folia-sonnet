package top.izuna.foliamajor.player.dsp

import java.nio.ByteBuffer
import kotlin.math.roundToInt

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/Pcm16Codec.kt
// 16bit 小端 PCM ↔ 浮点的来回转换，带 TPDF 抖动。
//
// 从 EqAudioProcessor 里拆出来，是因为「量化噪声」这条口径只该写一遍：降位深的那一端
// 加抖动、全精度的那一端不加，两个方向混在一个类里最容易改错一边。
//
// 字节序：Android 全平台小端，这里按字节拼，不依赖 ByteBuffer 的 order ——
// queueInput 拿到的是 direct buffer，读它的 order 比读两个字节贵。

/**
 * 抖动幅度：±1 LSB，三角分布。
 *
 * 处理路径每一步都要重新量化一次；没有抖动的话，量化误差与信号相关，听感是低电平段落
 * 有一层「跟着旋律走的沙沙声」（尤其混响尾巴）。三角分布的 pd 噪声把相关误差换成
 * 不相关的白噪声，代价是噪声底抬高约 4.8 dB（到 -93 dBFS），换来耳感上的干净。
 *
 * 直通路径不经过这里，所以「关掉总开关」仍然是逐字节相同。
 */
private const val DITHER_LSB = 1f

internal class Pcm16Codec {

    /** xorshift32 的状态。抖动噪声不要求密码学质量，只要求不相关、可重复。 */
    private var ditherState = 0x9E3779B9.toInt()

    /** 16bit 小端字节 → [-1, 1) 浮点。 */
    fun decode(source: ByteArray, sampleCount: Int, target: FloatArray) {
        var byteIndex = 0
        for (index in 0 until sampleCount) {
            val low = source[byteIndex].toInt() and 0xFF
            val high = source[byteIndex + 1].toInt()
            target[index] = ((high shl 8) or low).toShort() / 32768f
            byteIndex += 2
        }
    }

    /** 浮点 → 16bit 小端，带 ±1 LSB 的 TPDF 抖动。 */
    fun encode(source: FloatArray, sampleCount: Int, target: ByteBuffer) {
        for (index in 0 until sampleCount) {
            val noise = (nextRandomUnit() - nextRandomUnit()) * DITHER_LSB
            var value = (source[index] * 32768f + noise).roundToInt()
            if (value > 32767) value = 32767 else if (value < -32768) value = -32768
            target.put((value and 0xFF).toByte())
            target.put(((value shr 8) and 0xFF).toByte())
        }
    }

    private fun nextRandomUnit(): Float {
        var x = ditherState
        x = x xor (x shl 13)
        x = x xor (x ushr 17)
        x = x xor (x shl 5)
        ditherState = x
        return (x ushr 8) / 16777216f
    }
}
