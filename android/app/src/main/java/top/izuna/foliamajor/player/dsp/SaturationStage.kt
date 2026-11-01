package top.izuna.foliamajor.player.dsp

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tanh

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/SaturationStage.kt
// 饱和 / 染色：给信号加谐波密度，位置在后置均衡之后、声场宽度之前。
//
// 为什么需要它：EQ 只能改「哪些频率多、哪些少」，压缩只能改「响的地方压不压」，
// 两者都做不出「这盘磁带的质感」。饱和是非线性：信号进一个弯折的传输曲线，
// 出来的除了原频率，还有 2 次、3 次……谐波 —— 耳朵听到的是「厚」「扎实」「有颗粒」。
//
// 三种模式的区别在传输曲线的**对称性**与**硬度**：
//   TAPE    奇次为主（对称），外加 12 kHz 一阶滚降，模拟磁带的高频损失；
//   TUBE    非对称（x 上加一点直流偏置），所以有偶次谐波 —— 人耳把偶次当成「暖」；
//   DIODE   更硬的膝，三次为主，颗粒感强，适合鼓与合成器。
//
// 三个参数各管一件事，互不代替：
//   drive   进曲线之前放大多少 dB。越大越早弯，谐波越多；
//   mix     干湿比（等功率）。0.3 ~ 0.5 是「平行饱和」，保留瞬态又加厚度；
//   output  出口电平。饱和会让响度上去，这一步是手动补偿 —— 不做自动补偿，
//           是因为「变响一点」本身也是染色的一部分，替用户决定反而听不出区别。
//
// 线程：音频渲染线程。逐样本非线性 + 最多一个双二阶，无分配。

/** 磁带模式的高频滚降：一阶低通的截止，12 kHz 以上开始变暗。 */
private const val TAPE_TONE_HZ = 12000f

/** 电子管模式的直流偏置。0.3 大约是「偶次比奇次低 12 dB」的常见比例。 */
private const val TUBE_BIAS = 0.35f

/** 非对称整形会把直流抬起来，出口用 20 Hz 高通挡掉，否则会吃掉限幅器的余量。 */
private const val DC_BLOCK_HZ = 20f

class SaturationStage {

    /** TAPE 的高频滚降；TUBE / DIODE 时 bypass。 */
    private val toneFilter = BiquadFilter()

    /** TUBE 的直流阻断（非对称整形的必需项）。 */
    private val dcBlock = BiquadFilter()

    private var sampleRate = 0
    private var lastSettings: SaturationSettings? = null

    fun configure(sampleRate: Int) {
        this.sampleRate = sampleRate
        lastSettings = null
        reset()
    }

    fun reset() {
        toneFilter.reset()
        dcBlock.reset()
    }

    fun process(
        buffer: FloatArray,
        offset: Int,
        frames: Int,
        channels: Int,
        settings: SaturationSettings,
    ) {
        if (!settings.enabled || frames <= 0 || sampleRate <= 0) return
        if (settings !== lastSettings) {
            applyMode(settings)
            lastSettings = settings
        }

        // drive 与 output 都在 dB 里给，进循环之前换成线性增益：逐样本做 pow 就太贵了。
        val drive = 10f.pow(settings.driveDb.coerceIn(0f, 24f) / 20f)
        val output = 10f.pow(settings.outputDb.coerceIn(-24f, 6f) / 20f)
        // 等功率交叉：mix = 0 全干、1 全湿，中点两条各 0.707 —— 与混响、交叉淡化同一套约定。
        val angle = settings.mix.coerceIn(0f, 1f) * (PI.toFloat() / 2f)
        val dryGain = cos(angle)
        val wetGain = sin(angle)
        val count = frames * channels

        when (settings.mode) {
            SaturationMode.TUBE -> {
                // 减去 tanh(bias)，让「静音进 → 静音出」，否则整段会被抬高一个直流。
                val biasOffset = tanh(TUBE_BIAS)
                for (index in 0 until count) {
                    val channel = index % channels
                    val input = buffer[offset + index]
                    var wet = tanh(input * drive + TUBE_BIAS) - biasOffset
                    wet = dcBlock.process(wet, channel) * output
                    buffer[offset + index] = input * dryGain + wet * wetGain
                }
            }

            SaturationMode.DIODE -> {
                for (index in 0 until count) {
                    val input = buffer[offset + index]
                    val gained = input * drive
                    // x / sqrt(1 + x²)：奇函数，膝比 tanh 硬，三次谐波更突出。
                    val wet = (gained / sqrt(1f + gained * gained)) * output
                    buffer[offset + index] = input * dryGain + wet * wetGain
                }
            }

            else -> {
                for (index in 0 until count) {
                    val channel = index % channels
                    val input = buffer[offset + index]
                    var wet = tanh(input * drive)
                    wet = toneFilter.process(wet, channel) * output
                    buffer[offset + index] = input * dryGain + wet * wetGain
                }
            }
        }
    }

    /**
     * 只把当前模式用得上的滤波器打开。
     *
     * 系数变化不清状态（BiquadFilter 的 set* 只换系数），所以拖 drive 滑杆时
     * 不会每隔一帧「啪」一下 —— 这是滑杆能实时试听的前提。
     */
    private fun applyMode(settings: SaturationSettings) {
        if (settings.mode == SaturationMode.TAPE) {
            toneFilter.setLowPass(sampleRate, TAPE_TONE_HZ, BUTTERWORTH_Q)
        } else {
            toneFilter.bypass()
        }
        if (settings.mode == SaturationMode.TUBE) {
            dcBlock.setHighPass(sampleRate, DC_BLOCK_HZ, BUTTERWORTH_Q)
        } else {
            dcBlock.bypass()
        }
    }

    private companion object {
        /** 一阶低通 / 高通的那个 Q：两级串联才是 LR4，这里是单级，用 0.707。 */
        val BUTTERWORTH_Q = (1.0 / sqrt(2.0)).toFloat()
    }
}
