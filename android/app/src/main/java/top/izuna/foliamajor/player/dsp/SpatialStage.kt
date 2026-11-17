package top.izuna.foliamajor.player.dsp

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.pow

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/SpatialStage.kt
// 空间声场里的单轨摆位：pan 定左右，width 定自身宽度，levelDb 定响度。
//
// 与 StereoStage 的区别：StereoStage 处理「已经混好的整首」的中侧分量；这里处理
// **单个音轨**，再把摆好位的四轨相加 —— 于是鼓可以放左边、人声留在中间，这才是
// 「可调单个音轨空间声场」。
//
// 摆位顺序：先 constant-power pan（左右增益），再做 M/S 宽度（只改该轨自己的侧向），
// 最后乘电平。pan 与 width 都保持等功率，四轨相加后不会因为摆位而整体变响太多；
// 峰值仍由链末的前瞻限幅器兜住。
//
// 线程：音频渲染线程，逐样本；系数只在参数变化时重算，循环里不再 pow / cos。

class SpatialStage {

    private var last: StemSpatialSettings? = null
    private var leftGain = 1f
    private var rightGain = 1f
    private var width = 1f
    private var level = 1f

    fun reset() {
        last = null
        leftGain = 1f
        rightGain = 1f
        width = 1f
        level = 1f
    }

    /**
     * 对一个音轨的交错立体声缓冲做摆位（原地）。
     *
     * 单声道没有「位置」可言，直接乘电平跳过 pan/width。
     */
    fun process(
        buffer: FloatArray,
        offset: Int,
        frames: Int,
        channels: Int,
        settings: StemSpatialSettings,
    ) {
        if (frames <= 0) return
        if (settings !== last) applySettings(settings)

        // 关掉的轨直接静音；全中性时是恒等变换，别白跑一遍。
        if (!settings.audible) {
            for (index in offset until offset + frames * channels) buffer[index] = 0f
            return
        }
        val neutral = abs(width - 1f) < 0.001f
            && abs(leftGain - 1f) < 0.001f
            && abs(rightGain - 1f) < 0.001f
            && abs(level - 1f) < 0.001f
        if (channels < 2) {
            for (index in offset until offset + frames * channels) buffer[index] *= level
            return
        }
        if (neutral) return
        for (frame in 0 until frames) {
            val base = offset + frame * channels
            val left = buffer[base] * leftGain
            val right = buffer[base + 1] * rightGain
            val mid = (left + right) * 0.5f
            val side = (left - right) * 0.5f * width
            buffer[base] = (mid + side) * level
            buffer[base + 1] = (mid - side) * level
        }
    }

    private fun applySettings(settings: StemSpatialSettings) {
        last = settings
        level = if (settings.audible) dbToLinear(settings.levelDb.coerceIn(-24f, 6f)) else 0f
        val pan = settings.pan.coerceIn(-1f, 1f)
        val angle = (pan + 1f) * 0.25f * PI.toFloat()
        leftGain = cos(angle)
        rightGain = sin(angle)
        width = settings.width.coerceIn(0f, 2f)
    }

    private fun dbToLinear(db: Float): Float = 10f.pow(db / 20f)
}
