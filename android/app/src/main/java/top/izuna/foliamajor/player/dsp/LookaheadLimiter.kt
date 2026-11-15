package top.izuna.foliamajor.player.dsp

import kotlin.math.exp
import kotlin.math.roundToInt

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/LookaheadLimiter.kt
// 真·前瞻限幅器，替换掉早期那条逐样本 tanh 整形。
//
// 为什么 tanh 不行：它是「波形整形器」，瞬时增益随每一个样本变化，本质是把信号过一遍
// 非线性函数。旧实现在 0.891（-1 dBFS）就开始弯，而现代母带的峰值本来就贴在 -0.1 dBFS，
// 于是几乎每个鼓点都会穿过那段曲线 —— 换来的是持续存在的互调失真，听感是低频发糊、
// 高频发毛。tanh 只在「偶尔削一下」时才是安全的。
//
// 这里改成「增益包络 + 延迟线」，波形形状一个样本都不动，只乘一个缓慢变化的增益：
//   1. 环形延迟线把信号推迟 5 ms；
//   2. 检测器看的是「延迟线 + 当前块」的峰值，也就是未来 5 ms 的内容；
//   3. 所以增益在峰值到达之前就已经降下来，有整整 5 ms 做过渡，不会出现台阶；
//   4. 峰值过后按 120 ms 释放，避免泵动。
//
// 峰值窗口比理论需要多算一块（2.7 ms），属于保守取值：宁可早降一点，也不让输出碰到 1.0。

/** 释放时间的出厂值。慢到听不出「抽气」，快到不会把两拍之间的间隔拖成静音。 */
private const val DEFAULT_RELEASE_SECONDS = 0.12f

/** 最后一道硬夹。设计上永远不该触发，只用来兜住浮点异常（NaN / 极端输入）。 */
private const val ABSOLUTE_CEILING = 0.9999f

class LookaheadLimiter {

    private var sampleRate = 0
    private var channels = 0
    private var delayFrames = 0
    private var ring = FloatArray(0)
    private var writeIndex = 0
    private var gain = 1f

    /**
     * 输出上限，默认 -0.26 dBFS。
     *
     * 留出的这点余量不是给「削波」的，是给攻击平滑的残余过冲：一阶平滑到不了目标值，
     * 会留下百分之一点几的差距，0.97 × 1.01 ≈ 0.98，仍然远在 1.0 以内 ——
     * 也就是说最后的硬夹永远不参与工作。
     */
    var ceiling = 0.97f
        set(value) {
            field = value.coerceIn(0.5f, 1f)
        }

    /**
     * 峰值过后的回落时间，40 ~ 500 ms。
     *
     * 短了会在鼓点之间「抽气」（gain 快速弹回 1，下一拍又被压下去）；
     * 长了会把两拍之间的空隙一直压着，听起来像被掐住。
     * 120 ms 是出厂值，也是原来写死的那个数。
     */
    var releaseSeconds = DEFAULT_RELEASE_SECONDS
        set(value) {
            field = value.coerceIn(0.04f, 0.5f)
        }

    fun configure(sampleRate: Int, channels: Int, lookaheadMs: Float = 5f) {
        this.sampleRate = sampleRate.coerceAtLeast(8000)
        this.channels = channels.coerceIn(1, 8)
        // 下限 256 帧：必须大于最大块长，否则当前块会覆盖还没输出的数据。
        delayFrames = (lookaheadMs / 1000f * this.sampleRate).roundToInt().coerceAtLeast(256)
        ring = FloatArray(delayFrames * this.channels)
        writeIndex = 0
        gain = 1f
    }

    fun reset() {
        ring.fill(0f)
        writeIndex = 0
        gain = 1f
    }

    /**
     * 就地限幅。长度不变（延迟由内部环形缓冲承担），所以调用方不用管输出字节数。
     *
     * @param offset 起始下标（交错样本）
     * @param frames 帧数；超过块长时内部切开逐个处理（ExoPlayer 偶尔一次塞很大一块）
     */
    fun process(buffer: FloatArray, offset: Int, frames: Int, channels: Int) {
        if (frames <= 0 || delayFrames <= 0) return
        if (channels != this.channels) return

        val chunkLimit = minOf(DSP_BLOCK_FRAMES, delayFrames)
        var position = offset
        var remaining = frames
        while (remaining > 0) {
            val chunk = minOf(remaining, chunkLimit)
            processChunk(buffer, position, chunk)
            position += chunk * channels
            remaining -= chunk
        }
    }

    private fun processChunk(buffer: FloatArray, offset: Int, frames: Int) {
        val channels = this.channels

        // ① 峰值：延迟线里攒着的最近 5 ms（其中包含马上要输出的这部分）+ 当前块（未来）。
        val blockCount = frames * channels
        val peak = maxOf(peakOf(ring, 0, ring.size), peakOf(buffer, offset, blockCount))
        val desired = if (peak > ceiling) ceiling / peak else 1f

        // ② 攻击时间常数：上限由「前瞻减一块」决定。
        //
        //    峰值在块内任意位置都可能出现，而我们要等到整块读完才知道它存在；从那一刻到该样本
        //    真正输出，只剩 delayFrames - frames 帧的余量。攻击必须在这段里完成，否则就是过冲。
        //    取这段的 1/4 做时间常数，一阶平滑一步就能衰减 e^-4 ≈ 98%，残余由 ceiling 吸收。
        //    释放则慢得多（120 ms），避免在鼓点之间抽出呼吸感。
        val available = (delayFrames - frames).coerceAtLeast(frames / 2)
        val attackTau = available.toFloat() / sampleRate / 4f
        val tau = if (desired < gain) attackTau else releaseSeconds
        val coefficient = 1f - exp((-frames / (tau * sampleRate)).toDouble()).toFloat()
        val target = gain + (desired - gain) * coefficient

        val start = gain
        gain = target
        val step = if (frames > 1) (target - start) / (frames - 1) else 0f

        // ③ 边写边读：写入的是当前块，读出的是 delayFrames 帧之前的样本。
        var frameGain = start
        var write = writeIndex
        for (frame in 0 until frames) {
            val base = offset + frame * channels
            val ringBase = write * channels
            for (channel in 0 until channels) {
                val incoming = buffer[base + channel]
                val delayed = ring[ringBase + channel]
                ring[ringBase + channel] = incoming
                var out = delayed * frameGain
                if (out > ABSOLUTE_CEILING) {
                    out = ABSOLUTE_CEILING
                } else if (out < -ABSOLUTE_CEILING) {
                    out = -ABSOLUTE_CEILING
                }
                buffer[base + channel] = out
            }
            frameGain += step
            write += 1
            if (write >= delayFrames) write = 0
        }
        writeIndex = write
    }
}
