package top.izuna.foliamajor.player.dsp

import android.util.Log
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import java.nio.ByteOrder

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/GuardedAudioProcessor.kt
//
// 音频处理器的崩溃护栏：任何处理器在 queueInput / getOutput / flush 里抛出异常
// （MediaCodec 状态异常、数组越界、ROM 差异……）时，**当块直通原曲**，不让异常
// 顺着管线炸成 ExoPlaybackException —— 那个的表现是「播放出错 → 停住/跳歌」，
// 用户在拖进度条时最容易被它击中。
//
// 代价：崩溃的那个块听不到该处理器的效果（降级不致命）；下一次 flush（seek /
// 换歌）时处理器照常 onFlush 重置状态，效果自然恢复。崩溃本身记进 logcat（带
// 处理器名），方便真机定位是哪一环炸的。

@UnstableApi
class GuardedAudioProcessor(
    private val tag: String,
    private val delegate: AudioProcessor,
) : AudioProcessor {

    companion object {
        private const val TAG = "FoliaDspGuard"
    }

    /** 崩溃兜底块：下一轮 getOutput 时交出去（管线每轮只取一次输出）。 */
    private var fallbackOutput: ByteBuffer = AudioProcessor.EMPTY_BUFFER

    override fun configure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat =
        delegate.configure(inputAudioFormat)

    override fun isActive(): Boolean = delegate.isActive()

    override fun queueInput(inputBuffer: ByteBuffer) {
        try {
            delegate.queueInput(inputBuffer)
            return
        } catch (error: Throwable) {
            Log.w(TAG, "[$tag] processor crashed, passthrough this block", error)
        }
        // 兜底直通：消费剩余输入、原样吐出。管线对「输入必须被吃干净」有硬要求，
        // 这里必须兜住，否则下一块直接 IllegalStateException。
        val remaining = inputBuffer.remaining()
        if (remaining <= 0) return
        val out = ByteBuffer.allocateDirect(remaining).order(ByteOrder.nativeOrder())
        out.put(inputBuffer)
        out.flip()
        fallbackOutput = out
    }

    override fun getOutput(): ByteBuffer {
        val fallback = fallbackOutput
        if (fallback !== AudioProcessor.EMPTY_BUFFER) {
            fallbackOutput = AudioProcessor.EMPTY_BUFFER
            return fallback
        }
        return try {
            delegate.getOutput()
        } catch (error: Throwable) {
            Log.w(TAG, "[$tag] getOutput crashed, emit silence", error)
            AudioProcessor.EMPTY_BUFFER
        }
    }

    override fun queueEndOfStream() {
        try {
            delegate.queueEndOfStream()
        } catch (error: Throwable) {
            Log.w(TAG, "[$tag] queueEndOfStream crashed (ignored)", error)
        }
    }

    override fun isEnded(): Boolean = delegate.isEnded()

    override fun flush() {
        try {
            delegate.flush()
        } catch (error: Throwable) {
            Log.w(TAG, "[$tag] flush crashed (ignored)", error)
        }
    }

    override fun flush(streamMetadata: AudioProcessor.StreamMetadata) {
        try {
            delegate.flush(streamMetadata)
        } catch (error: Throwable) {
            Log.w(TAG, "[$tag] flush(streamMetadata) crashed (ignored)", error)
        }
    }

    override fun reset() {
        try {
            delegate.reset()
        } catch (error: Throwable) {
            Log.w(TAG, "[$tag] reset crashed (ignored)", error)
        }
    }
}
