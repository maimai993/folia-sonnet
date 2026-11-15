package top.izuna.foliamajor.player.transition.analysis

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.min

// android/app/src/main/java/top/izuna/foliamajor/player/transition/analysis/PcmWindowExtractor.kt
// 用 MediaCodec 解出一首歌首 / 尾各一段 PCM 供分析。
//
// 为什么不是整曲解码：Web 侧靠 OfflineAudioContext 整曲 decode，那是它最吃内存的一步；
// 原生侧只需要首尾各约 20 秒（开场形状 + 结尾形状 + 拍点估计），用 MediaExtractor 定位 +
// MediaCodec 解一小段即可，内存常驻 < 2 MB，也不需要把整首歌下载两遍。
//
// 输出统一降采样成单声道 11 025 Hz 的 FloatArray —— 分析只需到 4 kHz 以上的三频段与
// 12 音级色度，这个采样率够用，且让 FFT / 自相关的开销与文件长度解耦。
//
// 失败一律返回 null：规划层据此判「无证据」并降级到 crossfade，绝不让分析失败挡住播放。

data class PcmWindow(
    val samples: FloatArray,
    val sampleRate: Int,
    val startMs: Long,
    val durationMs: Long,
) {
    val isEmpty: Boolean get() = samples.isEmpty()
}

class PcmWindowExtractor(private val context: Context) {

    companion object {
        private const val TIMEOUT_US = 10_000L
        const val DEFAULT_WINDOW_MS = 20_000L
        const val TARGET_RATE = SignalMath.ANALYSIS_RATE
    }

    fun extract(
        url: String,
        startMs: Long,
        windowMs: Long = DEFAULT_WINDOW_MS,
        headers: Map<String, String>? = null,
    ): PcmWindow? {
        if (url.isBlank()) return null
        var extractor: MediaExtractor? = null
        var codec: MediaCodec? = null
        try {
            extractor = MediaExtractor()
            if (url.contains("://")) {
                extractor.setDataSource(context, Uri.parse(url), headers)
            } else {
                extractor.setDataSource(url)
            }

            var audioTrack = -1
            var format: MediaFormat? = null
            for (i in 0 until extractor.trackCount) {
                val f = extractor.getTrackFormat(i)
                val mime = f.getString(MediaFormat.KEY_MIME) ?: ""
                if (mime.startsWith("audio/")) { audioTrack = i; format = f; break }
            }
            val mediaFormat = format ?: return null
            extractor.selectTrack(audioTrack)

            val mime = mediaFormat.getString(MediaFormat.KEY_MIME) ?: return null
            val srcRate = mediaFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            val channels = mediaFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT).coerceAtLeast(1)
            val pcmEncoding = if (mediaFormat.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
                mediaFormat.getInteger(MediaFormat.KEY_PCM_ENCODING)
            } else AudioFormat.ENCODING_PCM_16BIT

            val fromUs = startMs * 1_000L
            if (fromUs > 0L) {
                extractor.seekTo(fromUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
            }

            codec = MediaCodec.createDecoderByType(mime)
            codec.configure(mediaFormat, null, null, 0)
            codec.start()

            val sink = Resampler(srcRate, channels)
            val info = MediaCodec.BufferInfo()
            var inputDone = false
            var outputDone = false
            var firstPtsUs = Long.MIN_VALUE
            var producedMs = 0L
            val limitMs = windowMs.coerceAtLeast(1_000L)

            while (!outputDone) {
                if (!inputDone) {
                    val inIndex = codec.dequeueInputBuffer(TIMEOUT_US)
                    if (inIndex >= 0) {
                        val input = codec.getInputBuffer(inIndex)
                        if (input == null) {
                            codec.queueInputBuffer(inIndex, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputDone = true
                        } else {
                            input.clear()
                            val size = extractor.readSampleData(input, 0)
                            if (size < 0) {
                                codec.queueInputBuffer(inIndex, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                inputDone = true
                            } else {
                                val pts = extractor.sampleTime
                                codec.queueInputBuffer(inIndex, 0, size, pts, 0)
                                extractor.advance()
                            }
                        }
                    }
                }

                val outIndex = codec.dequeueOutputBuffer(info, TIMEOUT_US)
                if (outIndex >= 0) {
                    if ((info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && info.size > 0) {
                        val output = codec.getOutputBuffer(outIndex)
                        if (output != null) {
                            if (firstPtsUs == Long.MIN_VALUE) firstPtsUs = info.presentationTimeUs
                            producedMs = (info.presentationTimeUs - firstPtsUs) / 1_000L
                            output.position(info.offset)
                            output.limit(info.offset + info.size)
                            when (pcmEncoding) {
                                AudioFormat.ENCODING_PCM_FLOAT -> sink.pushFloat(output)
                                else -> sink.pushShort(output)
                            }
                        }
                    }
                    codec.releaseOutputBuffer(outIndex, false)
                    if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true
                    if (producedMs >= limitMs) outputDone = true
                } else if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    // 采样率 / 声道数可能在这里才定下来；保守起见按 configure 时的值继续。
                }
                if (inputDone && producedMs >= limitMs) outputDone = true
                if (inputDone && outIndex == MediaCodec.INFO_TRY_AGAIN_LATER && sink.isEmpty) outputDone = true
            }

            val samples = sink.finish()
            if (samples.isEmpty()) return null
            val durationMs = (samples.size * 1_000L) / TARGET_RATE
            return PcmWindow(samples, TARGET_RATE, startMs, durationMs)
        } catch (error: Throwable) {
            // 取流失败 / 编码不支持 / DRM：都不是致命错误，交给降级路径。
            android.util.Log.w("FoliaTransition", "PCM 窗口提取失败，按无证据降级", error)
            return null
        } finally {
            runCatching { codec?.stop(); codec?.release() }
            runCatching { extractor?.release() }
        }
    }

    /** 逐帧把多声道 PCM 折成单声道，并按均值降采样到 TARGET_RATE。 */
    private class Resampler(srcRate: Int, private val channels: Int) {
        private val step = (srcRate.toDouble() / TARGET_RATE.toDouble()).coerceAtLeast(1.0)
        private val out = ArrayList<Float>(TARGET_RATE * 20)
        private var acc = 0.0
        private var sum = 0.0
        private var count = 0

        val isEmpty: Boolean get() = out.isEmpty()

        private fun push(mono: Float) {
            // 简易低通：整段输入求均值，等价于一个宽度可变的 box filter，够挡住降采样混叠。
            sum += mono.toDouble()
            count++
            acc += 1.0
            if (acc >= step) {
                out.add((sum / count).toFloat())
                acc -= step
                sum = 0.0
                count = 0
            }
        }

        fun pushShort(buffer: ByteBuffer) {
            val shortView = buffer.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
            val frames = shortView.remaining() / channels
            for (f in 0 until frames) {
                var mono = 0f
                for (c in 0 until channels) mono += shortView.get(f * channels + c) / 32768f
                push(mono / channels)
            }
        }

        fun pushFloat(buffer: ByteBuffer) {
            val floatView = buffer.order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
            val frames = floatView.remaining() / channels
            for (f in 0 until frames) {
                var mono = 0f
                for (c in 0 until channels) mono += floatView.get(f * channels + c)
                push(mono / channels)
            }
        }

        fun finish(): FloatArray = FloatArray(out.size) { out[it] }
    }
}
