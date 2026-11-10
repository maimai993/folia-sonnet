package top.izuna.foliamajor.automix

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.Log
import java.nio.ByteOrder

/**
 * 整首歌的 PCM 解码，给 htdemucs / beat_this 用。
 *
 * 为什么要放在原生侧：
 *   Web 层原来是把线上地址 fetch 成整段 ArrayBuffer，再解码、再以 base64 过桥交给推理。
 *   这条路在安卓上必死 —— FoliaNativePlugin.httpRequest 的响应体上限是 8MiB
 *   （DEFAULT_MAX_RESPONSE_BYTES），而一首 PRC 音频动辄 5~15MB；就算放宽，
 *   过桥时 byte[] → base64 → 整份 JSON 会放大近 8 倍，20MB 就能把 256MB 堆撞穿（#261/#262）。
 *
 *   所以音频根本不该过桥：由原生自己按 URL 拉流、MediaCodec 解码成 PCM，
 *   直接把样本数组交给推理。整个过程 Web 层一个字节都拿不到，也就不存在上限问题。
 *
 * 输出约定（与 HtdemucsRunner / BeatThisRunner 要求一致）：
 *   · sampleRate 44100（htdemucs 训练时的采样率）
 *   · 双声道 FloatArray，左右分开，样本值 [-1, 1]
 *   · 源是单声道时复制到两路（分离仍有意义：人声在中间，两路相同会被判成居中分量）
 */
internal object TrackPcmDecoder {

    private const val TAG = "TrackPcmDecoder"
    private const val TIMEOUT_US = 10_000L

    /** htdemucs 训练用的采样率。 */
    const val TARGET_RATE = 44_100

    data class Result(
        val left: FloatArray,
        val right: FloatArray,
        val sampleRate: Int,
    ) {
        val samples: Int get() = left.size
    }

    /**
     * 从本地文件或 URL 解出整首歌的双声道 PCM。
     *
     * @param pathOrUrl 本地绝对路径，或 http(s) 地址（交给 MediaExtractor 直连）。
     * @param maxSeconds 最多解这么久（默认 8 分钟）。超长的现场版截断，避免内存爆掉。
     */
    fun decode(context: Context, pathOrUrl: String, maxSeconds: Int = 480): Result? {
        if (pathOrUrl.isBlank()) return null
        var extractor: MediaExtractor? = null
        var codec: MediaCodec? = null
        try {
            extractor = MediaExtractor()
            if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
                extractor.setDataSource(pathOrUrl, emptyMap())
            } else {
                extractor.setDataSource(pathOrUrl)
            }

            // 找第一条音频轨。
            var trackIndex = -1
            var mime: String? = null
            for (i in 0 until extractor.trackCount) {
                val format = extractor.getTrackFormat(i)
                val trackMime = format.getString(MediaFormat.KEY_MIME) ?: continue
                if (trackMime.startsWith("audio/")) {
                    trackIndex = i
                    mime = trackMime
                    extractor.selectTrack(i)
                    break
                }
            }
            if (trackIndex < 0 || mime == null) {
                Log.w(TAG, "没有音频轨: $pathOrUrl")
                return null
            }

            val format = extractor.getTrackFormat(trackIndex)
            val sourceRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            var channels = if (format.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            } else {
                2
            }.coerceAtLeast(1)
            val durationUs = if (format.containsKey(MediaFormat.KEY_DURATION)) {
                format.getLong(MediaFormat.KEY_DURATION)
            } else {
                maxSeconds * 1_000_000L
            }
            val limitUs = minOf(durationUs, maxSeconds * 1_000_000L)

            codec = MediaCodec.createDecoderByType(mime)
            codec.configure(format, null, null, 0)
            codec.start()

            /*
             * 输出容量按「目标采样率 × 时长 × 声道」预留。
             * 留 5% 余量给编码器 padding；上限 8 分钟，最坏约 44100*480*2*4B ≈ 169MB，
             * 但那已经是极端情况（且推理本身要 500MB）；常规 4 分钟歌约 85MB。
             */
            val estimate = (TARGET_RATE.toLong() * minOf(limitUs / 1_000_000.0, maxSeconds.toDouble())).toInt() + TARGET_RATE
            var left = FloatArray(estimate)
            var right = FloatArray(estimate)
            var written = 0

            val info = MediaCodec.BufferInfo()
            var inputDone = false
            var outputDone = false
            var resampleRemainderL = 0.0
            var resampleRemainderR = 0.0
            /*
             * 连续空转的次数。
             *
             * 解码器在输入耗尽、输出还没到时，两个 dequeue 都会返回 TRY_AGAIN_LATER。
             * 不给一个上限，这个 while 就会一直转下去（某个 ROM 的 codec 不吐
             * END_OF_STREAM 时会直接卡死，用户看到的是「一直转圈」）。
             * 连续 2000 次、每次 10ms 的等待约 20 秒，足够任何正常解码出结果。
             */
            var idleSpins = 0
            val idleLimit = 2000

            /*
             * 重采样比例：源采样率 / 目标 44100。
             *
             * 用线性插值，不做高保真重采样 —— 分析/分离只关心频段与时序。
             * 但必须做：htdemucs 的输入固定 44100，喂错采样率整首歌的音高就变了。
             */
            var ratio = sourceRate.toDouble() / TARGET_RATE

            while (!outputDone) {
                if (!inputDone) {
                    val inIndex = codec.dequeueInputBuffer(TIMEOUT_US)
                    if (inIndex >= 0) {
                        val inBuf = codec.getInputBuffer(inIndex) ?: continue
                        val sampleSize = extractor.sampleTime
                        val size = extractor.readSampleData(inBuf, 0)
                        if (size < 0 || (sampleSize >= 0 && sampleSize > limitUs)) {
                            codec.queueInputBuffer(inIndex, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputDone = true
                        } else {
                            codec.queueInputBuffer(inIndex, 0, size, extractor.sampleTime, 0)
                            extractor.advance()
                        }
                    }
                }

                val outIndex = codec.dequeueOutputBuffer(info, TIMEOUT_US)
                when {
                    outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        /*
                         * 真实采样率 / 声道数以这里为准。
                         *
                         * MediaExtractor 报的是**容器头**里的值，有些编码器写的是
                         * 占位（0 或 2），真正解码后才知道。用错会让声道错位 ——
                         * 左右交错被当成单声道帧读，出来就是一片噪音。
                         */
                        val outFormat = codec.outputFormat
                        if (outFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
                            channels = outFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                        }
                        if (outFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                            val realRate = outFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                            if (realRate > 0) {
                                ratio = realRate.toDouble() / TARGET_RATE
                            }
                        }
                        idleSpins = 0
                    }
                    outIndex == MediaCodec.INFO_TRY_AGAIN_LATER -> {
                        idleSpins += 1
                        if (idleSpins > idleLimit) {
                            Log.w(TAG, "解码长时间无输出，放弃: $pathOrUrl")
                            outputDone = true
                        }
                    }
                    outIndex >= 0 -> {
                        idleSpins = 0
                        if (info.size > 0) {
                            val outBuf = codec.getOutputBuffer(outIndex)
                            if (outBuf != null) {
                                outBuf.position(info.offset)
                                outBuf.limit(info.offset + info.size)
                                val shorts = outBuf.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                                val frames = shorts.remaining() / channels
                                /*
                                 * 逐帧取源样本，再按 ratio 线性插值到目标采样率。
                                 * 累加器跨 buffer 保留（resampleRemainder*），否则每个 buffer
                                 * 的接缝处都会掉/重一个样本，长歌会累积成可听的偏移。
                                 */
                                for (f in 0 until frames) {
                                    val l = shorts.get(f * channels).toFloat() / 32768f
                                    val r = if (channels > 1) {
                                        shorts.get(f * channels + 1).toFloat() / 32768f
                                    } else {
                                        l
                                    }
                                    resampleRemainderL += 1.0
                                    resampleRemainderR += 1.0
                                    while (resampleRemainderL >= ratio) {
                                        resampleRemainderL -= ratio
                                        if (written >= left.size) {
                                            val grownL = left.copyOf(left.size + estimate)
                                            val grownR = right.copyOf(right.size + estimate)
                                            left = grownL
                                            right = grownR
                                        }
                                        left[written] = l
                                        right[written] = r
                                        written += 1
                                    }
                                }
                            }
                        }
                        codec.releaseOutputBuffer(outIndex, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputDone = true
                    }
                }
            }

            if (written <= 0) {
                Log.w(TAG, "解码结果为空: $pathOrUrl")
                return null
            }
            Log.i(TAG, "解码完成: ${sourceRate}Hz/${channels}ch -> 44100Hz, $written 样本")
            return Result(
                left = left.copyOf(written),
                right = right.copyOf(written),
                sampleRate = TARGET_RATE,
            )
        } catch (error: Exception) {
            Log.w(TAG, "解码失败: ${error.message}")
            return null
        } finally {
            try {
                codec?.stop()
            } catch (_: Exception) {
            }
            try {
                codec?.release()
            } catch (_: Exception) {
            }
            try {
                extractor?.release()
            } catch (_: Exception) {
            }
        }
    }

    /** 补齐到 [frames] 帧（不足补零），供模型的固定长度输入用。 */
    fun padTo(channel: FloatArray, frames: Int): FloatArray {
        if (channel.size >= frames) return channel
        val out = FloatArray(frames)
        channel.copyInto(out)
        return out
    }
}
