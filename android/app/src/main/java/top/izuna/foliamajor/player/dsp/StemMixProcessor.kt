package top.izuna.foliamajor.player.dsp

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import top.izuna.foliamajor.automix.ScnetRunner
import java.nio.ByteBuffer

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/StemMixProcessor.kt
// 空间声场的内核：四个分离音轨各自摆位、实时混成一路立体声。
//
// 挂点：FoliaAudioSinkFactory 的 processor 链里**排在 EqAudioProcessor 之前** ——
// 它负责「这首歌的声源是什么」，EQ / 压缩 / 混响那条链再对混好的结果做整体调音。
//
// 为什么在这里而不是再造四台 ExoPlayer：
//   四台播放器各自一个 AudioTrack，混音发生在空气里 —— 摆位、同步、音频焦点、切歌
//   每一样都要自己再写一遍，还做不到样本级对齐。把 ExoPlayer 当**时钟**（它继续播原曲、
//   位置 / 暂停 / 倍速 / 循环全由它管），处理器把同一时间轴上的四个音轨解出来、摆位、
//   相加，输出替换掉原曲 PCM —— 这是「全部音轨一起播放」且能逐轨摆位的唯一稳妥形状。
//
// 数据流（音频渲染线程，逐块）：
//   queueInput 进来的是原曲的 N 帧 16bit PCM（时钟）→ 若空间声场没开、或这首歌的
//   四轨还没生成完，原样直通；否则四个 StemDecoder 各吐出 N 帧 → SpatialStage 摆位 →
//   四轨相加 → 限幅兜底 → 编码成 16bit 输出。频谱与后面的调音链照常工作。
//
// 同步：四个音轨与原曲同采样率、同长度、同一起点，按「块」顺序各解 N 帧即天然对齐。
//   seek 由插件 seek 处理器把目标帧数写进 [StemMixState]，下一个块先 flush 再 seek 到
//   最近关键帧，之后重新对齐。AAC 编码延迟造成的 1~2 ms 恒定偏移听不出来，不计。
//
// ⚠️ 真机验证前不要合并：MediaCodec 的同步解码对具体 ROM 的实现细节敏感
//   （dequeueOutputBuffer 的时序、EOS 行为、SEEK_TO_PREVIOUS_SYNC 的落点）。

@UnstableApi
class StemMixProcessor(
    private val state: NativeEqualizerState,
) : BaseAudioProcessor() {

    private var sampleRate = 0
    private var channels = 0

    private val stages = Array(StemKind.ALL.size) { SpatialStage() }
    private val decoders = arrayOfNulls<StemDecoder>(StemKind.ALL.size)
    private val stemFloat = Array(StemKind.ALL.size) { FloatArray(0) }
    private var mix = FloatArray(0)
    private var scratch = FloatArray(0)
    private var raw = ByteArray(0)
    private var carry = ByteArray(0)
    private var carrySize = 0
    private var lastKey: String? = null
    private val pcm = Pcm16Codec()

    override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
        if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT) {
            return AudioProcessor.AudioFormat.NOT_SET
        }
        sampleRate = inputAudioFormat.sampleRate
        channels = inputAudioFormat.channelCount.coerceAtLeast(1)
        carry = ByteArray(2 * channels)
        carrySize = 0
        raw = ByteArray(0)
        mix = FloatArray(0)
        scratch = FloatArray(0)
        releaseDecoders()
        lastKey = null
        return inputAudioFormat
    }

    override fun onFlush(streamMetadata: AudioProcessor.StreamMetadata) {
        carrySize = 0
        // seek 之后旧解码器的时间轴已经作废，等下一个块按 StemMixState 里的目标重开。
        if (StemMixState.hasPendingSeek()) releaseDecoders()
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        val incoming = inputBuffer.remaining()
        if (incoming <= 0) return
        if (channels <= 0 || sampleRate <= 0) {
            val out = replaceOutputBuffer(incoming)
            out.put(inputBuffer)
            out.flip()
            return
        }

        val session = StemMixState.snapshot()
        val stemFiles = session?.stems
        val settings = session?.spatial
        if (session == null || stemFiles == null || settings == null || !settings.enabled || !session.stems.all { it != null && it.isFile }) {
            passthrough(inputBuffer, incoming)
            return
        }
        // 四轨是 44.1k 写的；时钟不是 44.1k 时时间轴对不上，宁可直通也别混出错的声场。
        if (sampleRate != ScnetRunner.SAMPLE_RATE) {
            passthrough(inputBuffer, incoming)
            return
        }
        // 四轨都是立体声；时钟不是双声道时摆位没有意义，直通。
        if (channels != 2) {
            passthrough(inputBuffer, incoming)
            return
        }

        val frameBytes = 2 * channels
        val total = carrySize + incoming
        val frames = total / frameBytes
        if (frames <= 0) {
            inputBuffer.get(carry, carrySize, incoming)
            carrySize = total
            return
        }
        val used = frames * frameBytes
        if (raw.size < used) raw = ByteArray(used)
        if (carrySize > 0) System.arraycopy(carry, 0, raw, 0, carrySize)
        inputBuffer.get(raw, carrySize, used - carrySize)
        carrySize = total - used
        if (carrySize > 0) inputBuffer.get(carry, 0, carrySize)

        ensureMix(frames * channels)
        ensureScratch(frames * channels)
        pcm.decode(raw, frames * channels, scratch)

        if (lastKey != session.songKey || decoders.all { it == null }) {
            openDecoders(session)
            lastKey = session.songKey
        }

        for (index in 0 until mix.size) mix[index] = 0f
        var audible = 0
        for (kind in StemKind.ALL) {
            val stem = settings.resolve(kind)
            if (!stem.audible) continue
            val decoder = decoders[kind.ordinal]
            if (decoder == null) continue
            audible += 1
            val buffer = ensureStem(kind.ordinal, frames * channels)
            val got = decoder.read(buffer, frames, channels)
            // 短了的帧（文件末尾 / 解码还没跟上来）按静音补齐，不把旧数据混进来。
            if (got < frames) {
                for (index in got * channels until frames * channels) buffer[index] = 0f
            }
            stages[kind.ordinal].process(buffer, 0, frames, channels, stem)
            for (index in 0 until frames * channels) mix[index] += buffer[index]
        }
        if (audible > 0) {
            for (index in 0 until frames * channels) scratch[index] = mix[index]
        } else {
            // 四轨全关：静音。用已经清空的 mix 覆盖原曲（用户要的是「全部」里也能全关）。
            for (index in 0 until frames * channels) scratch[index] = 0f
        }

        val out = replaceOutputBuffer(used)
        pcm.encode(scratch, frames * channels, out)
        out.flip()
    }

    private fun passthrough(inputBuffer: ByteBuffer, incoming: Int) {
        val out = replaceOutputBuffer(incoming)
        out.put(inputBuffer)
        out.flip()
    }

    private fun ensureMix(samples: Int) {
        if (mix.size < samples) mix = FloatArray(samples)
    }

    private fun ensureScratch(samples: Int) {
        if (scratch.size < samples) scratch = FloatArray(samples)
    }

    private fun ensureStem(index: Int, samples: Int): FloatArray {
        val current = stemFloat[index]
        if (current.size >= samples) return current
        val next = FloatArray(samples)
        stemFloat[index] = next
        return next
    }

    private fun openDecoders(session: StemMixSession) {
        releaseDecoders()
        StemMixState.consumeSeek()
        for (kind in StemKind.ALL) {
            val file = session.stems[kind.ordinal]
            if (file == null) continue
            decoders[kind.ordinal] = StemDecoder().apply {
                open(file.absolutePath, StemMixState.lastSeekFrames())
            }
        }
    }

    private fun releaseDecoders() {
        decoders.forEach { it?.release() }
        decoders.fill(null)
        stages.forEach { it.reset() }
    }
}

/**
 * 一个音轨的同步解码器：MediaExtractor + MediaCodec，按需吐 PCM。
 *
 * 线程：只在音频渲染线程调用。缓冲复用，不逐块 new。
 */
private class StemDecoder {

    private val extractor = MediaExtractor()
    private var codec: MediaCodec? = null
    private var sampleRate = 0
    private var channels = 0
    private var inputDone = false
    private var pending = ByteArray(0)
    private var pendingSize = 0
    private val info = MediaCodec.BufferInfo()

    fun open(path: String, seekFrames: Long) {
        extractor.setDataSource(path)
        val track = (0 until extractor.trackCount).firstOrNull {
            extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
        } ?: return
        extractor.selectTrack(track)
        val format = extractor.getTrackFormat(track)
        sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        val name = format.getString(MediaFormat.KEY_MIME) ?: return
        codec = MediaCodec.createDecoderByType(name).also { it.configure(format, null, null, 0) }
        if (seekFrames > 0) {
            extractor.seekTo(seekFrames * 1_000_000L / sampleRate, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
        }
        codec?.start()
    }

    /** 解出 [frames] 帧交织 16bit → 浮点，写进 [out]；返回实际帧数（文件末尾会少）。 */
    fun read(out: FloatArray, frames: Int, outChannels: Int): Int {
        val wantedBytes = frames * channels * 2
        while (pendingSize < wantedBytes && !inputDone) {
            if (!drainOutput()) break
            if (!feedInput()) {
                inputDone = true
            }
        }
        val haveFrames = minOf(frames, pendingSize / (channels * 2))
        if (haveFrames > 0) {
            val bytes = haveFrames * channels * 2
            decodePending(bytes, out, outChannels)
            pendingSize -= bytes
            if (pendingSize > 0) {
                System.arraycopy(pending, bytes, pending, 0, pendingSize)
            }
        }
        return haveFrames
    }

    private fun feedInput(): Boolean {
        val codec = codec ?: return false
        val index = codec.dequeueInputBuffer(10_000L)
        if (index < 0) return true
        val buffer = codec.getInputBuffer(index) ?: return true
        val size = extractor.readSampleData(buffer, 0)
        if (size < 0) {
            codec.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            return false
        }
        codec.queueInputBuffer(index, 0, size, extractor.sampleTime, 0)
        extractor.advance()
        return true
    }

    private fun drainOutput(): Boolean {
        val codec = codec ?: return false
        while (true) {
            val index = codec.dequeueOutputBuffer(info, 10_000L)
            when {
                index == MediaCodec.INFO_TRY_AGAIN_LATER -> return true
                index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> continue
                index >= 0 -> {
                    val buffer = codec.getOutputBuffer(index) ?: continue
                    if (info.size > 0) {
                        append(buffer, info.offset, info.size)
                    }
                    codec.releaseOutputBuffer(index, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
                        inputDone = true
                        return false
                    }
                    return true
                }
            }
        }
    }

    private fun append(buffer: ByteBuffer, offset: Int, size: Int) {
        if (pending.size < pendingSize + size) {
            pending = pending.copyOf(maxOf(pending.size * 2, pendingSize + size, 4096))
        }
        buffer.position(offset)
        buffer.limit(offset + size)
        buffer.get(pending, pendingSize, size)
        pendingSize += size
    }

    private fun decodePending(bytes: Int, out: FloatArray, outChannels: Int) {
        val srcChannels = channels
        var at = 0
        val frames = bytes / (srcChannels * 2)
        for (frame in 0 until frames) {
            for (channel in 0 until srcChannels) {
                val low = pending[at].toInt() and 0xFF
                val high = pending[at + 1].toInt()
                val value = ((high shl 8) or low).toShort() / 32768f
                val target = frame * outChannels + channel
                if (target < out.size) out[target] = value
                at += 2
            }
        }
    }

    fun release() {
        try { codec?.stop() } catch (_: Throwable) {}
        try { codec?.release() } catch (_: Throwable) {}
        codec = null
        try { extractor.release() } catch (_: Throwable) {}
        pending = ByteArray(0)
        pendingSize = 0
        inputDone = false
    }
}
