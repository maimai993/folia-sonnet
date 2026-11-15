package top.izuna.foliamajor.player.dsp

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.sign

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/VocalCancelProcessor.kt
// 实时关闭人声：中置声道相消（center-channel cancellation）。
//
// ⚠️ 当前**没有挂在 AudioSink 的处理链上**（见 FoliaAudioSinkFactory 的说明）。
//
// 它连续两版在真机上都是「开不开都滋滋滋」。两次的成因分别是：
//   1. 按 Java 默认的大端 getShort/putShort 读写小端 PCM —— 每个样本高低字节对调；
//   2. 透传分支用绝对 get 读、相对 put 写，一旦输入缓冲 position 不在 0 就整体错位。
// 两次都不是崩溃，只是把样本写坏了，logcat 里一句异常都没有 —— 所以很难在
// 开发机上发现，每次都要用户听一遍噪声才知道。
//
// 恢复这个功能之前必须做到：在设备上用一首真实的歌，把「关掉开关」这一路
// 的输出与输入逐字节比对完全相等，再去验证相消效果。做不到就不要挂回链上。

/*
 * 原理很短：混音里人声几乎总在最中间，也就是左右声道**幅相同、相位相同**。
 * 把 L 和 R 相减，这部分就被减没了；而真正的立体声内容（铺底、混响、
 * 两侧的乐器）左右不同，差值保留了它们。
 *
 *   L' = L - k·R
 *   R' = R - k·L
 *
 * k=1 时居中的人声被完全消掉，但居中的贝斯和底鼓也会一起没 ——
 * 所以 k 默认取 0.82，留一点余量；并且低频段补回去（见下面的 lowGain），
 * 否则整首歌会听起来又薄又空。
 *
 * ⚠️ 字节序是这里最容易踩的坑，已经踩过一次：
 *   AudioProcessor 交进来的是一块**裸字节**，PCM 本身是小端（Android / AudioTrack
 *   的原生格式）。如果按 Java 默认的大端去 getShort()/putShort()，每个样本的
 *   高低字节被对调 —— 数学上算得完全对，听感上却是满幅噪声，也就是
 *   「打开关闭人声之后只有滋滋滋」。所以下面显式按字节组装，不依赖任何
 *   ByteBuffer 的 order 状态（duplicate() / replaceOutputBuffer() 都可能把它换掉）。
 *
 * 为什么做成实时 DSP 而不是离线分离：
 *   离线跑 Demucs 更干净，但一首歌要几十秒，还得缓存几十 MB 的伴奏。
 *   这里要的是「拨了立刻生效」，那就只能走这条。代价是：
 *     · 同样居中的乐器（贝斯、底鼓）会被削弱
 *     · 带混响 / 立体声处理的人声会残留
 *     · 原本不是「人声居中」混音的曲子基本无效
 *   这些是这类算法的固有代价，不是 bug。
 *
 * 只在双声道 16bit 输入上工作：单声道没有左右差可减，原样通过。
 */
@UnstableApi
class VocalCancelProcessor(
    private val state: NativeEqualizerState,
) : BaseAudioProcessor() {

    /** 一阶低通系数，约 120Hz。在 onConfigure 里按采样率算好。 */
    private var lowGain = 0.02f

    /** 低通滤波器的状态，左右各一。 */
    private var lowL = 0f
    private var lowR = 0f

    /** 这一份流能不能处理：要 16bit 双声道。 */
    private var supported = false

    override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
        supported = inputAudioFormat.encoding == C.ENCODING_PCM_16BIT
            && inputAudioFormat.channelCount == 2
        /*
         * 约 120Hz 的一阶低通系数。
         *
         * 采样率变了要重算：写死 44100 的话在 48k 源上这个截止点会挪到 130Hz，
         * 影响不大但没必要留这个偏差。
         */
        val rate = inputAudioFormat.sampleRate.coerceAtLeast(8000)
        lowGain = 1f - exp(-2.0f * PI.toFloat() * LOW_SHELF_HZ / rate.toFloat())
        // 格式不变，处理在原地做 —— 返回输入格式即可，不需要换输出格式。
        return inputAudioFormat
    }

    override fun onFlush(streamMetadata: AudioProcessor.StreamMetadata) {
        // 换了流，低通的历史不该带过去（否则接缝处会有一声闷响）。
        lowL = 0f
        lowR = 0f
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        /*
         * ★ 只处理「从当前位置到 limit」这一段，而且要用 absolute get。
         *
         * 早先写的 duplicate() + 相对读取有个隐患：duplicate 的 position 跟随
         * 原 buffer（不一定在 0），而循环用 remaining 计数，两边口径不一致时
         * 会读到上一段残留、或者越界。这里全部改成按绝对下标读，把区间
         * 算清楚再动。
         */
        val start = inputBuffer.position()
        val end = inputBuffer.limit()
        val size = end - start
        if (size <= 0) return

        /*
         * 关着、或这份流处理不了：原样交出去。
         *
         * ★ 这里必须字节级无损，而且是「整段搬运」。
         *
         * 曾经出一版「开不开都滋滋滋」。原因就是这个分支的写法：
         * 一边用绝对下标 `get(i)` 从输入缓冲取字节，一边用相对 `put()` 往
         * 输出缓冲写。这样写看起来等价，但只要 inputBuffer 的 position
         * 不在 0（EqAudioProcessor 的 carry 机制会推进它），或者 limit 与
         * 「我能写的容量」有任何一字节的出入，整段音频就会错位 —— 样本的
         * 高低字节被跨样本拼接，听感是全程滋滋响，且和开关无关。
         *
         * 现在用 `out.put(inputBuffer)`：一次把 [position, limit) 整段搬过去，
         * 顺序、长度都由 ByteBuffer 自己保证，不可能错位。
         */
        if (!state.vocalCancelEnabled || !supported) {
            val out = replaceOutputBuffer(size)
            out.put(inputBuffer)
            out.flip()
            return
        }

        val out = replaceOutputBuffer(size)
        var index = start
        // 一次吃 4 字节（左右各一个 16bit 小端样本）。
        while (index + BYTES_PER_FRAME <= end) {
            val l = readLittleEndianShort(inputBuffer, index).toFloat()
            val r = readLittleEndianShort(inputBuffer, index + 2).toFloat()

            // 相消：把对面的声道减一部分过来。
            var nl = l - r * CANCEL_AMOUNT
            var nr = r - l * CANCEL_AMOUNT

            // 低频补偿：低通只跟原信号走，再按比例加回一点，补回被一起吃掉的厚度。
            lowL += (l - lowL) * lowGain
            lowR += (r - lowR) * lowGain
            nl += lowL * BASS_RESTORE
            nr += lowR * BASS_RESTORE

            writeLittleEndianShort(out, clamp16(nl))
            writeLittleEndianShort(out, clamp16(nr))
            index += BYTES_PER_FRAME
        }
        // 尾部不足一帧的字节（理论上不该有）照抄，避免丢样本。
        while (index < end) {
            out.put(inputBuffer.get(index))
            index += 1
        }
        out.flip()
    }

    /** 小端读一个 16bit 有符号样本。 */
    private fun readLittleEndianShort(buffer: ByteBuffer, index: Int): Short {
        val low = buffer.get(index).toInt() and 0xFF
        val high = buffer.get(index + 1).toInt()
        return ((high shl 8) or low).toShort()
    }

    /** 小端写一个 16bit 有符号样本。 */
    private fun writeLittleEndianShort(buffer: ByteBuffer, value: Short) {
        val bits = value.toInt()
        buffer.put((bits and 0xFF).toByte())
        buffer.put(((bits shr 8) and 0xFF).toByte())
    }

    /**
     * 限幅：先软膝、再硬夹。
     *
     * ★ 硬夹（直接 clamp16）就是「滋滋滋」的第二个来源。
     *
     * 相消运算 `l - r*0.82` 会让幅度**变大**：左右声道反相的内容（大部分
     * 立体声混响、铺底）原来各占半幅，减完之后接近满幅；再叠上低频补偿的
     * 0.55 倍，很容易越过 32767。越过之后如果只是硬切平，波形被削成方波，
     * 听感就是持续的爆破音 —— 用户描述成「滋滋滋」。
     *
     * 这里做一个软膝：超过 0.85 满幅的部分按压缩曲线走，逼近 1.0 但不越界，
     * 波形保持圆滑。超过满幅的极端情况再硬夹作为兜底。
     */
    private fun clamp16(value: Float): Short {
        val knee = SOFT_KNEE
        val magnitude = abs(value)
        val limited = if (magnitude <= knee) {
            value
        } else {
            val over = magnitude - knee
            val headroom = Short.MAX_VALUE - knee
            sign(value) * (knee + headroom * over / (over + headroom))
        }
        return when {
            limited > Short.MAX_VALUE -> Short.MAX_VALUE
            limited < Short.MIN_VALUE -> Short.MIN_VALUE
            else -> limited.toInt().toShort()
        }
    }

    private companion object {
        const val BYTES_PER_FRAME = 4

        /** 软膝起点：低于它原样通过，高于它开始压缩。约 -1.4dBFS。 */
        const val SOFT_KNEE = 28_000.0f

        /**
         * 相消系数。
         *
         * 1.0 是「数学上完全减掉居中分量」，但那样居中的贝斯鼓也会消失，
         * 整首歌变得很空。0.72 是留一点残留换厚度（原来 0.82 太高，反相成分被放大到削波） —— 听感上人声已经明显退到后面，
         * 但歌的骨架还在。
         */
        const val CANCEL_AMOUNT = 0.72f

        /** 低频补回的比例。太多会把刚消掉的声音又带回来。 */
        const val BASS_RESTORE = 0.55f

        /** 低频补偿的低通截止点。 */
        const val LOW_SHELF_HZ = 120.0f
    }
}
