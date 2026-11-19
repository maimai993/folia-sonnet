package top.izuna.foliamajor.player.dsp

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import java.nio.ByteOrder

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/VocalCancelProcessor.kt
// 关闭人声：挂在 AudioSink 处理链上的那一层**薄壳**。
//
// 算法全在 VocalCancelCore.kt（纯 Kotlin，有单测）；这里只负责
// 从 ByteBuffer 里按小端读出 16bit 立体声样本、交给核心、再写回去。
//
// ⚠️ 这个功能历史上连续几版真机都不对，而且都不是崩溃，只是把样本写坏或流水线卡住，
// logcat 里一句异常都没有。四次成因分别是：
//   1. 按 Java 默认的大端读写小端 PCM —— 每个样本高低字节对调；
//   2. 透传分支用绝对下标读、相对位置写，输入缓冲 position 不在 0 时整体错位；
//   3. 处理分支只写输出、**不推进输入缓冲的 position** —— AudioProcessingPipeline
//      认为这块输入还没消费完，下一趟又把同一块交进来，同一段样本被反复送进
//      AudioTrack。听感是「打开后伴奏人声全没了，只剩滋滋的电流声」，而且永远卡在那儿；
//   4. 相消写成「减对面声道」，侧向被放大到 1+k 倍，满幅内容过载后被限幅器压成方波。
// 所以下面这几件事是硬约束，改动时必须保持：
//   · 透传分支永远是 `out.put(inputBuffer)` 整段搬运，不碰样本；
//   · 读样本用 duplicate() 出来的视图并**显式** setOrder(LITTLE_ENDIAN)，
//     不改调用方缓冲的 order（下游 TransitionDspProcessor 也在读它）；
//   · 无论走哪条分支，函数返回时 `inputBuffer.position()` 必须已经到 limit；
//   · 开关关掉且淡出走完时，输出与输入逐字节相同 —— 这几条都有单测锁着。
//
// 为什么做成实时 DSP 而不是离线分离：
//   项目里的 SCNet 是**整首离线**跑的（分析包络用），拿不到「拨了立刻生效」。
//   这里要的是开关即时，只能走零延迟的相消。代价写在下面对用户的说明里：
//   同样居中的贝斯与底鼓会被削弱、带混响的人声会残留、本身不是居中混音的曲子基本无效。
//   这些是这类算法的固有代价，不是 bug。
//
// 只在双声道 16bit 输入上工作：单声道没有中置与侧向之分，原样通过。
@UnstableApi
class VocalCancelProcessor(
    private val state: NativeEqualizerState,
) : BaseAudioProcessor() {

    private val core = VocalCancelCore()

    /** 这一份流能不能处理：要 16bit 双声道。 */
    private var supported = false

    override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
        supported = inputAudioFormat.encoding == C.ENCODING_PCM_16BIT
            && inputAudioFormat.channelCount == 2
        core.configure(inputAudioFormat.sampleRate)
        // 格式不变，处理在原地做 —— 返回输入格式即可，不需要换输出格式。
        return inputAudioFormat
    }

    override fun onFlush(streamMetadata: AudioProcessor.StreamMetadata) {
        // 换了流，低通的历史不该带过去（否则接缝处会有一声闷响）。
        core.reset()
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        /*
         * 只处理 [position, limit) 这一段，下标一律绝对。
         *
         * 早先写的 duplicate() + 相对读取有个隐患：duplicate 的 position 跟随
         * 原 buffer（不一定在 0），而循环用 remaining 计数，两边口径不一致时
         * 会读到上一段残留、或者越界。
         */
        val start = inputBuffer.position()
        val end = inputBuffer.limit()
        val size = end - start
        if (size <= 0) return

        core.setEnabled(state.vocalCancelEnabled && !state.instrumentalActive && !state.stemMixActive)
        val out = replaceOutputBuffer(size)

        /*
         * 关着（且淡出走完）、或这份流处理不了：原样交出去。
         *
         * 一次 put(inputBuffer) 把整段搬过去：顺序、长度都由 ByteBuffer 自己保证，
         * 不可能错位。这条分支是「开关关掉必须完全听不出差别」的唯一保障，
         * 不要为了省一次拷贝改成逐样本循环。
         */
        if (!supported || core.isBypassed()) {
            out.put(inputBuffer)
            out.flip()
            return
        }

        /*
         * 读样本走 duplicate() 的副本：setOrder 只改副本，
         * 不动调用方那个缓冲 —— 它后面还要交给过渡处理器。
         */
        val source = inputBuffer.duplicate().order(ByteOrder.LITTLE_ENDIAN)
        out.order(ByteOrder.LITTLE_ENDIAN)

        var index = start
        val lastFrame = end - BYTES_PER_FRAME
        // 一次吃 4 字节（左右各一个 16bit 小端样本）。
        while (index <= lastFrame) {
            core.process(source.getShort(index).toInt(), source.getShort(index + 2).toInt())
            out.putShort(core.outL.toShort())
            out.putShort(core.outR.toShort())
            index += BYTES_PER_FRAME
        }
        // 尾部不足一帧的字节（理论上不该有）照抄，避免丢样本。
        while (index < end) {
            out.put(source.get(index))
            index += 1
        }
        out.flip()
        /*
         * ★ 必须把输入缓冲标记为「已消费」。
         *
         * AudioProcessingPipeline.processData() 靠 `inputBytes - input.remaining()`
         * 判断这一趟有没有前进，并且**只要输入还有剩，下一趟还会把它交进来**。
         * 只写输出、不推进 position 的话，同一块 PCM 会被反复处理、反复送给
         * AudioTrack —— 听感就是「伴奏和人声都没了，只剩滋滋的电流声」，
         * 而且这一块永远放不完。旁通分支里的 put(inputBuffer) 自带这一步，
         * 所以只有打开开关才会出问题。
         */
        inputBuffer.position(end)
    }

    private companion object {
        const val BYTES_PER_FRAME = 4
    }
}
