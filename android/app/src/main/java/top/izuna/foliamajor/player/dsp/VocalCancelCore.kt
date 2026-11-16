package top.izuna.foliamajor.player.dsp

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.sign

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/VocalCancelCore.kt
// 关闭人声的**算法本体**：与 AudioProcessor、ByteBuffer、Android 全部无关，
// 只有「进来一对 16bit 样本、出去一对 16bit 样本」。
//
// 为什么单独拆出来：这个功能前两版的毛病（字节序、缓冲错位、削波）全在
// 音频线程上，写坏样本不会抛异常，logcat 里干干净净，只能靠耳朵发现。
// 拆开之后 VocalCancelProcessor 只剩十几行搬运代码，算法这边用普通 JVM 单测
// 就能覆盖（见 app/src/test/.../VocalCancelTest.kt），不用再拿用户的耳朵验收。
//
// 原理：混音里人声几乎总在正中（左右幅相同、相位相同）。把它拆成
//
//   M = (L + R) / 2   中置分量（人声、贝斯、底鼓都在这儿）
//   S = (L - R) / 2   侧向分量（铺底、混响、两侧乐器）
//
// 然后把中置按比例减掉、侧向原样留着：
//
//   L' = L - k·M
//   R' = R - k·M
//
// 减完之后 M' = (1-k)·M，S' = S —— 也就是说**侧向一点没被放大**。
//
// ★ 早先写的是「减对面声道」（L' = L - k·R），那等于 (1-k)M + (1+k)S：
// 侧向被放大到 1+k 倍，满幅的立体声内容一减就过载，只能靠限幅器硬压 ——
// 而限幅压出来的方波，听感就是用户说的「滋滋滋」。换成减中置之后
// |L'| ≤ max(|L|,|R|)，物理上不可能越界，限幅器退化成兜底。
//
// k=1 能把居中人声完全减掉，但居中的贝斯与底鼓也一起没 —— 所以 k 取 0.92，
// 再把 110Hz 以下按比例补回去一点，留住歌的骨架。这是这类算法的固有代价，
// 不是 bug：网易云那条「关闭人声」的说明里写的也是同一件事。
internal class VocalCancelCore {

    /** 上一次 process 写出的左声道（16bit，已限幅）。 */
    var outL: Int = 0
        private set

    /** 上一次 process 写出的右声道。 */
    var outR: Int = 0
        private set

    /** 一阶低通系数（约 110Hz），onConfigure 时按采样率算。两级串联 = 二阶。 */
    private var lowGain: Float = 0f

    /**
     * 低频补偿滤波器的状态（只跟中置分量走）。
     *
     * 为什么是两级：一阶 110Hz 在 440Hz 处只衰减 12dB，而男声基频就在
     * 100–400Hz —— 补回来的那 0.5 倍会把人声的根音又抬回来一大截，
     * 听感是「人声变小了但还在」。两级之后 440Hz 处约 -25dB，只留下真正的低频。
     */
    private var lowMid1: Float = 0f
    private var lowMid2: Float = 0f

    /** 当前的干湿比例：0 = 原样，1 = 全相消。用来抹掉拨开关那一下的爆音。 */
    private var mix: Float = 0f

    /** 目标干湿比例。 */
    private var target: Float = 0f

    /** 每个样本 mix 走多少（由采样率与淡入时长算出）。 */
    private var rampStep: Float = 1f

    fun configure(sampleRate: Int, rampMs: Int = RAMP_MS) {
        val rate = sampleRate.coerceAtLeast(8000)
        /*
         * 采样率变了要重算截止点：写死 44100 的话，48k 源上这个 110Hz
         * 会挪到 120Hz，影响不大但没必要留这个偏差。
         */
        lowGain = 1f - exp(-2.0f * PI.toFloat() * LOW_SHELF_HZ / rate.toFloat())
        rampStep = 1f / (rate * rampMs / 1000f).coerceAtLeast(1f)
        reset()
    }

    /** 换流（seek / 换歌 / 换格式）时清掉滤波器历史，否则接缝处会有一声闷响。 */
    fun reset() {
        lowMid1 = 0f
        lowMid2 = 0f
        mix = 0f
    }

    fun setEnabled(enabled: Boolean) {
        target = if (enabled) 1f else 0f
        if (target > 0f && mix == 0f) {
            /*
             * 从完全旁通直接打开：低通状态还停在上次关掉时的值（可能是几分钟前的
             * 另一个段落），不清掉的话淡入的头十几毫秒会把那段旧低频抖出来。
             * 从 0 起步只是让这十几毫秒的低频补偿偏小，听不出来。
             */
            lowMid1 = 0f
            lowMid2 = 0f
        }
    }

    /**
     * 此刻能不能整段绕过。
     *
     * 关掉且淡出已经走完时返回 true —— 这条路上一个字节都不经过浮点运算，
     * 是「关闭开关时输出必须与输入逐字节相同」的唯一保证。
     */
    fun isBypassed(): Boolean = target == 0f && mix == 0f

    /**
     * 处理一对样本。
     *
     * 参数是 16bit 有符号整数的值域（-32768..32767），不是归一化浮点：
     * 搬运层拿到的就是 Short，多一次除法只会多一次舍入误差。
     */
    fun process(l: Int, r: Int) {
        // 干湿渐变：每样本推进一点，拨开关不会有咔哒声。
        mix = if (target > mix) (mix + rampStep).coerceAtMost(target) else (mix - rampStep).coerceAtLeast(target)

        val lf = l.toFloat()
        val rf = r.toFloat()
        val mid = (lf + rf) * 0.5f

        // 中置相消：只减中置，侧向原样（见文件头的推导）。
        var wl = lf - mid * CANCEL_AMOUNT
        var wr = rf - mid * CANCEL_AMOUNT

        /*
         * 低频补偿：低通只跟中置分量走（不跟相消后的信号），再按比例加回去，
         * 补回被一起减掉的厚度。用中置而不是原信号，是因为补回去的低频
         * 必须还在正中 —— 拿 L 单独补会让低频整体偏左。
         */
        lowMid1 += (mid - lowMid1) * lowGain
        lowMid2 += (lowMid1 - lowMid2) * lowGain
        val restore = lowMid2 * BASS_RESTORE
        wl += restore
        wr += restore

        if (mix < 1f) {
            wl = lf + (wl - lf) * mix
            wr = rf + (wr - rf) * mix
        }

        outL = clamp16(wl)
        outR = clamp16(wr)
    }

    /**
     * 限幅：低于软膝原样通过，高于它按压缩曲线逼近满幅，极端情况才硬夹。
     *
     * 减中置的写法本身**不可能**越界（|L'| ≤ max(|L|,|R|)），所以正常路径上
     * 这个函数一次都不会进软膝。它留着是给低频补偿兜底：补回去的 0.5 倍
     * 低频叠在接近满幅的段落上，理论上能顶出去一点。直接硬切会削成方波，
     * 听感是持续的爆破音（也就是前两版被描述成「滋滋滋」的第二个来源），
     * 所以这里宁可绕一段曲线。
     */
    private fun clamp16(value: Float): Int {
        val magnitude = abs(value)
        if (magnitude <= SOFT_KNEE) return value.toInt()
        val over = magnitude - SOFT_KNEE
        val headroom = Short.MAX_VALUE - SOFT_KNEE
        val limited = sign(value) * (SOFT_KNEE + headroom * over / (over + headroom))
        return when {
            limited >= Short.MAX_VALUE -> Short.MAX_VALUE.toInt()
            limited <= Short.MIN_VALUE -> Short.MIN_VALUE.toInt()
            else -> limited.toInt()
        }
    }

    internal companion object {
        /**
         * 中置相消系数。
         *
         * 1.0 是数学上把居中分量完全减掉（人声没了，居中的贝斯鼓也一起没）。
         * 0.92 已经很接近 1：居中的主唱压到 -22dB，基本听不见；留 8% 是为了
         * 不让「人声一消、整首歌突然塌掉」那种空感太明显，剩下的厚度再由
         * 下面的低频补偿补一部分。
         */
        const val CANCEL_AMOUNT = 0.92f

        /** 低频补回的比例。补的是中置低通，所以补回来的低频仍在正中。 */
        const val BASS_RESTORE = 0.5f

        /** 低频补偿的低通截止点（两级串联，实际斜率约 -12dB/oct）。 */
        const val LOW_SHELF_HZ = 110.0f

        /**
         * 软膝起点：约 -0.2dBFS。
         *
         * 只压最后 2.4% 的幅度。**不能设得更低**：这个函数是按样本独立压的，
         * 一旦把 -1.4dBFS（28000）以上的正常响度也圈进来，每一记鼓点都会被
         * 单独压一下，等于给整首歌加了失真 —— 而且它压的是本来根本不会越界的样本。
         */
        const val SOFT_KNEE = 32_000.0f

        /** 拨开关的淡入淡出时长。太短会有咔哒声，太长会听出「渐变」。 */
        const val RAMP_MS = 12
    }
}
