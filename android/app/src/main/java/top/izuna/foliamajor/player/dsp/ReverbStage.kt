package top.izuna.foliamajor.player.dsp

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/ReverbStage.kt
// 空间环境混响：并联梳状（含阻尼）+ 串联全通，Freeverb 的结构。
//
// 为什么不直接搬 Web 的卷积：那边的 IR 是 2.2 s、双声道、按当前采样率生成，
// 48 kHz 下约 21 万抽头 —— 逐样本直接卷积在中端机上是几十个点的 CPU。
// 分块 FFT 卷积能跑，但要多写一套状态机，而混响本来就是「听起来在一个空间里」，
// 不是逐样本还原；这里用参数化的房间（RT60 / 阻尼 / 预延迟 / 密度）去描述那个空间。
//
// 参数是怎么来的：
//   · RT60 —— 梳状反馈量由 g = 10^(-3·T_delay / RT60) 反推，T_delay 是该梳状的真实延迟秒数。
//     这条式子就是 RT60 的定义（衰减 60 dB 所需时间），所以滑杆上的 2.20 s 是真的 2.20 s。
//   · 声压级 roomLevelDb —— 湿声的电平，0 dB 表示与直达声同响，-2 dB 是出厂值。
//   · 干湿比 mix —— 等功率交叉：dry = cos(θ)，wet = sin(θ)，θ = mix·π/2。
//     用等功率而不是线性，是因为线性在 mix = 0.5 处会凹下去 3 dB（听感是「开了混响变小」）。
//   · 阻尼与预延迟 —— 用户直接给值，预设只提供房间大小（[PRESET_SCALES]）。
//     换预设时 Web 会把该预设的阻尼与预延迟写进设置当起点，之后两个滑杆各调各的。
//
// 延迟缓冲按**最大**的预设（大教堂 1.9 倍）一次分配好，切换预设只改读写的长度，
// 不在音频线程上分配内存。
//
// 线程：音频渲染线程，逐样本；关卡时整套不跑。

class ReverbStage {

    private var combs: Array<Array<Comb>> = emptyArray()
    private var allpasses: Array<Array<Allpass>> = emptyArray()
    private var preDelayLines: Array<FloatArray> = emptyArray()
    private var preDelayIndex = 0
    private var activeChannels = 0
    private var sampleRate = 44100

    /** 上一次用的预设，换成别的预设时才重设延迟长度。 */
    private var appliedPreset = -1

    fun configure(sampleRate: Int, channels: Int) {
        this.sampleRate = sampleRate
        activeChannels = minOf(channels, MAX_CHANNELS)
        appliedPreset = -1
        if (activeChannels <= 0) {
            combs = emptyArray()
            allpasses = emptyArray()
            preDelayLines = emptyArray()
            return
        }
        val scale = sampleRate / 44100f * MAX_PRESET_SCALE
        combs = Array(activeChannels) { channel ->
            Array(COMB_TUNING.size) { index ->
                val size = ((COMB_TUNING[index] + channel * STEREO_SPREAD) * scale).toInt().coerceAtLeast(1)
                Comb(size)
            }
        }
        allpasses = Array(activeChannels) { channel ->
            Array(ALLPASS_TUNING.size) { index ->
                val size = ((ALLPASS_TUNING[index] + channel * STEREO_SPREAD) * scale).toInt().coerceAtLeast(1)
                Allpass(size)
            }
        }
        val preDelaySize = (sampleRate * MAX_PRE_DELAY_SECONDS).toInt().coerceAtLeast(1)
        preDelayLines = Array(activeChannels) { FloatArray(preDelaySize) }
        preDelayIndex = 0
    }

    /** seek / flush：把尾巴清掉，否则新位置的头几毫秒会拖着上一段的混响。 */
    fun reset() {
        combs.forEach { channel -> channel.forEach { it.reset() } }
        allpasses.forEach { channel -> channel.forEach { it.reset() } }
        preDelayLines.forEach { it.fill(0f) }
        preDelayIndex = 0
    }

    /**
     * @param legacySpace Web 的 space 滑杆（0..1）。混响没打开时按老行为走，保证老设置听起来不变。
     */
    fun process(
        buffer: FloatArray,
        offset: Int,
        frames: Int,
        channels: Int,
        legacySpace: Float,
        reverb: ReverbSettings,
    ) {
        val hasNewReverb = reverb.enabled
        val hasLegacy = !hasNewReverb && legacySpace > 0.001f
        if (!hasNewReverb && !hasLegacy) return
        if (combs.isEmpty()) return

        val preset = if (hasNewReverb) reverb.preset else ReverbPreset.FACTORY
        if (preset != appliedPreset) {
            applyPreset(preset)
            appliedPreset = preset
        }

        // 阻尼与预延迟由设置直接给。老路径（space 滑杆）没有这两项，用出厂的 0.2 / 0。
        val damping = if (hasNewReverb) reverb.damping else LEGACY_DAMPING
        val preDelayFrames = if (hasNewReverb) {
            val ms = reverb.preDelayMs.coerceIn(0f, MAX_PRE_DELAY_SECONDS * 1000f)
            (ms / 1000f * sampleRate).toInt().coerceIn(0, preDelayLines.first().size - 1)
        } else {
            0
        }
        // 干湿比：新参数走等功率交叉，老参数（space 滑杆）仍是原来的「湿声越大干声让一点路」，
        // 这样老设置听起来一个字节都不变。
        val wetGain: Float
        val dryGain: Float
        if (hasNewReverb) {
            val theta = reverb.mix.coerceIn(0f, 1f) * (PI.toFloat() * 0.5f)
            dryGain = cos(theta)
            wetGain = sin(theta) * dbToLinear(reverb.roomLevelDb) * WET_TRIM
        } else {
            wetGain = 0.75f * legacySpace * WET_TRIM
            dryGain = 1f - (0.15f * wetGain).coerceIn(0f, 0.35f)
        }

        val rt60 = if (hasNewReverb) reverb.rt60Seconds.coerceIn(0.3f, 10f) else LEGACY_RT60
        val active = minOf(channels, activeChannels)

        for (frame in 0 until frames) {
            val base = offset + frame * channels
            for (channel in 0 until active) {
                var dry = buffer[base + channel]
                if (preDelayFrames > 0) {
                    val line = preDelayLines[channel]
                    val readIndex = (preDelayIndex + line.size - preDelayFrames) % line.size
                    val delayed = line[readIndex]
                    line[preDelayIndex % line.size] = dry
                    dry = delayed
                    if (channel == active - 1) {
                        // 预延迟线在所有声道之间共用同一个写指针。
                        preDelayIndex += 1
                        if (preDelayIndex >= line.size) preDelayIndex = 0
                    }
                }

                var wet = 0f
                val channelCombs = combs[channel]
                for (comb in channelCombs) {
                    wet += comb.process(dry, rt60, damping, sampleRate)
                }
                wet /= channelCombs.size
                val channelAllpasses = allpasses[channel]
                for (allpass in channelAllpasses) {
                    wet = allpass.process(wet)
                }
                val original = buffer[base + channel]
                buffer[base + channel] = original * dryGain + wet * wetGain
            }
        }
    }

    /** 换预设：只改梳状的读写长度（反馈量由 RT60 每次重算，阻尼与预延迟由设置给）。 */
    private fun applyPreset(preset: Int) {
        val scale = sampleRate / 44100f * PRESET_SCALES[preset.coerceIn(0, PRESET_SCALES.lastIndex)]
        for (channel in combs.indices) {
            for (index in combs[channel].indices) {
                val size = ((COMB_TUNING[index] + channel * STEREO_SPREAD) * scale).toInt().coerceAtLeast(1)
                combs[channel][index].resize(size)
            }
            for (index in allpasses[channel].indices) {
                val size = ((ALLPASS_TUNING[index] + channel * STEREO_SPREAD) * scale).toInt().coerceAtLeast(1)
                allpasses[channel][index].resize(size)
            }
        }
    }

    /** 延迟线：环形缓冲 + 可变长度。梳状与全通只差一条处理式，其余状态管理是同一套。 */
    private abstract class DelayLine(maxSize: Int) {
        protected val buffer = FloatArray(maxSize)
        protected var index = 0
        protected var length = maxSize

        /** 换长度（切预设时调用）。缓冲按最大预设分配，这里只改读写窗口。 */
        fun resize(frames: Int) {
            length = frames.coerceIn(1, buffer.size)
            if (index >= length) index = 0
        }

        open fun reset() {
            buffer.fill(0f)
            index = 0
        }
    }

    private class Comb(maxSize: Int) : DelayLine(maxSize) {
        private var store = 0f

        override fun reset() {
            super.reset()
            store = 0f
        }

        /**
         * @param rt60 目标衰减时间（秒）
         * @param sampleRate 采样率
         *
         * 反馈量按「当前实际延迟」反推：g = 10^(-3·D/T)。D 越长，同样的 RT60 需要更大的 g。
         * 上限 0.985：再高就是自激，听感是越放越响。
         */
        fun process(input: Float, rt60: Float, damping: Float, sampleRate: Int): Float {
            val delaySeconds = length.toFloat() / sampleRate
            val feedback = 10f.pow(-3f * delaySeconds / rt60).coerceAtMost(0.985f)
            val output = buffer[index]
            store = output * (1f - damping) + store * damping
            buffer[index] = input + store * feedback
            index += 1
            if (index >= length) index = 0
            return output
        }
    }

    private class Allpass(maxSize: Int) : DelayLine(maxSize) {
        fun process(input: Float): Float {
            val stored = buffer[index]
            val output = -input + stored
            buffer[index] = input + stored * 0.5f
            index += 1
            if (index >= length) index = 0
            return output
        }
    }

    private companion object {
        val COMB_TUNING = intArrayOf(1116, 1188, 1277, 1356, 1422, 1491)
        val ALLPASS_TUNING = intArrayOf(556, 441, 341)
        const val STEREO_SPREAD = 23
        const val MAX_CHANNELS = 2

        /** 最大的预设缩放（大教堂 1.9），延迟缓冲按它分配。 */
        const val MAX_PRESET_SCALE = 1.9f
        const val MAX_PRE_DELAY_SECONDS = 0.12f

        /** 湿声整体衰减：对齐 ConvolverNode 的 normalize 行为。 */
        const val WET_TRIM = 0.7f

        /** 老 space 滑杆的固定尾巴长度，与 Web 的 2.2 s IR 一致。 */
        const val LEGACY_RT60 = 2.2f

        /** 老 space 路径没有阻尼概念，用它保持原有听感（等同于出厂的 0.2）。 */
        const val LEGACY_DAMPING = 0.2f

        /**
         * 各预设的梳状延迟缩放：越大房间越大。
         *
         * 阻尼与预延迟**不在这里**了 —— 它们是用户滑杆，预设只在切换时把一组合理初值
         * 写进设置（见 EqSettings.ReverbPreset.defaultDamping / defaultPreDelayMs）。
         */
        val PRESET_SCALES = floatArrayOf(1.0f, 1.35f, 1.9f, 0.62f)
    }
}
