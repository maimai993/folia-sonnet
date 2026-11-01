package top.izuna.foliamajor.player.dsp

import kotlin.math.abs

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/StereoStage.kt
// 声场宽度与低频单声道，挂在后置均衡之后、混响之前。
//
// 为什么用 M/S 而不是「左右各加一点延时」：延时差会让单声道兼容性变差 —— 在手机
// 外放或蓝牙单声道音箱上，反相成分直接抵消，声音会变薄。M/S 只改侧向分量的权重，
// 中置（人声、底鼓）原样不动，collapse 到单声道时正好退回去，不丢东西。
//
//   M = (L + R) / 2      S = (L - R) / 2
//   L' = M + S·width     R' = M - S·width
//
// width = 0 → 完全单声道；1 → 原样；2 → 侧向加倍（宽到喇叭外面）。
// 大于 1 时峰值可能超过原信号，由链末的前瞻限幅器兜住（它本来就要处理 EQ 的增益）。
//
// 低频单声道：[StereoSettings.bassMonoHz] 大于 0 时，侧向信号先过一遍 LR4 高通，
// 该频率以下的侧向就没了 —— 于是这一段只剩中置，低频不再随声像左右摆。
// 唱片里的低频常常两声道相位不一致，叠起来会抵消，在外放上表现成「底鼓没了」；
// 这一步是母带处理的常规做法，而这个频段本来也听不出方向。
//
// 为什么用高通而不是「side 减去低通」：低通在截止点附近有 100° 以上的相移，
// 用一个相移过的分量去减原信号，差值的幅度会**大于**原信号（实测 60 Hz 在
// 120 Hz 分频点上放大 33%）—— 听感是低频反而更轰。直接高通没有这个问题：
// 它只是把截止点以下的侧向拿走，截止点以上原样通过。
//
// 位置为什么在混响之前：混响每声道有自己的梳状延时线，本身就是立体声的。若把宽度
// 处理放在它后面，混响尾巴会被再拉宽一次，听起来像「两个房间叠在一起」。放在前面
// 只作用于干声，尾巴仍由混响自己的声道差决定。
//
// 线程：音频渲染线程，逐样本；唯一的分配发生在 configure。

/** 最多 4 对（8 声道）—— 与 BiquadFilter 的 MAX_CHANNELS 一致。 */
private const val MAX_PAIRS = 4

/** LR4 的两级 Butterworth Q。 */
private const val BUTTERWORTH_Q = 0.7071f

class StereoStage {

    /** 每对声道的两级高通，作用在侧向信号上；只在开了低频单声道时打开。 */
    private val bassHigh = Array(MAX_PAIRS) { Array(2) { BiquadFilter() } }

    private var sampleRate = 0
    private var appliedBassHz = 0f

    fun configure(sampleRate: Int) {
        this.sampleRate = sampleRate
        appliedBassHz = 0f
        reset()
    }

    /** seek / flush 之后清状态（低频单声道有滤波器，不清会把上一段的尾巴带进来）。 */
    fun reset() {
        bassHigh.forEach { pair -> pair.forEach { it.reset() } }
    }

    fun process(
        buffer: FloatArray,
        offset: Int,
        frames: Int,
        channels: Int,
        settings: StereoSettings,
    ) {
        // 单声道没有「侧」可言。
        if (!settings.enabled || channels < 2) return
        val width = settings.width.coerceIn(0f, 2f)
        val bassHz = settings.bassMonoHz.coerceIn(0f, 400f)
        val monoBass = bassHz > 0f
        if (monoBass) applyBass(bassHz)
        // 宽度恰好 1 且没开低频单声道时是恒等变换，别白跑一遍。
        if (!monoBass && abs(width - 1f) < 0.001f) return

        val pairs = minOf(channels / 2, MAX_PAIRS)
        for (frame in 0 until frames) {
            val base = offset + frame * channels
            // 成对处理；声道数为奇数时最后一个通道没有伴，原样留着。
            for (pair in 0 until pairs) {
                val left = buffer[base + pair * 2]
                val right = buffer[base + pair * 2 + 1]
                val mid = (left + right) * 0.5f
                var side = (left - right) * 0.5f
                if (monoBass) {
                    // 两级 Butterworth 串联 = LR4 高通，截止点以下的侧向被拿走。
                    side = bassHigh[pair][0].process(side, 0)
                    side = bassHigh[pair][1].process(side, 0)
                }
                side *= width
                buffer[base + pair * 2] = mid + side
                buffer[base + pair * 2 + 1] = mid - side
            }
        }
    }

    /**
     * 低频单声道的分频只随频率变，所以只在滑杆真的动了的时候重算系数。
     *
     * 只换系数、不清状态：拖滑杆时听到的是「折成单声道的边界在移动」，
     * 而不是每拖一格「啪」一下。
     */
    private fun applyBass(bassHz: Float) {
        if (abs(bassHz - appliedBassHz) < 0.01f) return
        appliedBassHz = bassHz
        for (pair in 0 until MAX_PAIRS) {
            for (tap in 0 until 2) {
                bassHigh[pair][tap].setHighPass(sampleRate, bassHz, BUTTERWORTH_Q)
            }
        }
    }
}
