package top.izuna.foliamajor.player.dsp

import android.content.Context
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.util.Log
import top.izuna.foliamajor.automix.AutomixModels
import top.izuna.foliamajor.automix.ScnetRunner
import top.izuna.foliamajor.automix.TrackPcmDecoder
import java.io.File
import java.nio.ByteBuffer

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/InstrumentalBuilder.kt
// 「关闭人声」的真身：用 SCNet 把整首歌分离一遍，写成一份伴奏文件。
//
// 为什么不能再靠 DSP：
//   中置相消只能减掉「左右完全一样」的成分。真实混音里人声带混响、加倍和声、
//   立体声延迟 —— 这些都不在中置，相消之后人声只是变小、整首歌也跟着变薄。
//   要「掐掉」，唯一的路是把人声轨真的分离出来，再从混音里减掉。
//
// 流程（一首歌只跑一次，结果按 LRU 缓存）：
//   1. 整首解码成 44.1k 双声道浮点（与分轨分析用的是同一个解码器）；
//   2. 每 4 个 11 秒窗口分离一次，只取 vocals 这一轨的 iSTFT（省掉另外三轨 3/4 的逆变换）；
//   3. 原曲 − 人声 → 16bit，边算边喂 AAC 编码器，直接写 m4a；
//   4. 写临时文件，成功后原子改名 —— 播放端永远看不到半截文件。
//
// 为什么分块而不是一次分离整首：separate() 的输出是「整段长度 × 2 声道 × 4 字节」，
// 4 分钟的歌一次要 85MB，加上解码出来的原曲 85MB，中端机直接进内存压力区。
// 分块之后常驻只有 16MB，而块边界都落在 11 秒窗口的边界上，与一次跑完全等价。
//
// 为什么写 AAC 而不是 WAV：同样的歌 WAV 是 42MB，AAC 128k 是 3.8MB。
// 用户要的是「缓存占用少」，一百首也就 380MB。
internal object InstrumentalBuilder {

    private const val TAG = "Instrumental"

    /** 一次 separate() 跑几个窗口。4 个 ≈ 44 秒，输出缓冲约 16MB。 */
    private const val BLOCK_WINDOWS = 4

    /** 伴奏码率。人声已经去掉了，剩下的乐器 128k 足够，再高只是浪费空间。 */
    private const val BIT_RATE = 128_000

    /** ScnetRunner.STEMS 里 vocals 的下标。 */
    private const val STEM_VOCALS = 3

    /** 低于这个缓存上限就干脆不生成（约四首的量）。 */
    private const val MIN_CACHE_BYTES = 16L * 1024 * 1024

    /**
     * 分离时最多解多长的音轨（秒）。
     *
     * `TrackPcmDecoder.decode` 默认只解 8 分钟 —— 那是给「分析」用的省内存上限。
     * 分离出来的伴奏要当整条音轨播放，截断就成了「时间轴变短」，所以这里放宽。
     * 30 分钟覆盖所有正常投稿，再长的（整场直播回放）本来也不该做分离。
     */
    private const val MAX_SEPARATION_SECONDS = 30 * 60

    /**
     * 分离阶段的窗口数换算成整条进度。
     *
     * 分离占 6–99%：前面留给解码和模型加载，100 留给「文件写完」。
     * 单独抽出来是因为它最容易被改错 —— 算重了进度条会倒退，算漏了会越界回 0，
     * 两种都让用户以为出错了。单测锁在 InstrumentalBuilderTest。
     */
    internal fun percentForWindow(windowsDone: Int, totalWindows: Int): Int {
        val total = totalWindows.coerceAtLeast(1)
        val done = windowsDone.coerceIn(0, total)
        return (6 + done * 93 / total).coerceIn(6, 99)
    }

    /** 一次分离的两份成品。 */
    data class BuiltTracks(val instrumental: File, val vocal: File)

    /**
     * 生成一首歌的伴奏**和**清唱，一次解码、一次推理、两路 AAC。
     *
     * 调用方必须在后台线程跑：解码 + 推理是几十秒的活。
     * 只产出一份也要跑同一遍模型，所以干脆两份一起写 —— 用户拨「只留人声」
     * 时不用再等第二遍。
     *
     * @param eager 用户正拨着开关等这份音轨（reconcile 那条路）：播放中的让路
     *              比例降一档，尽量快出结果；预生成走默认值，优先保证播放顺滑。
     */
    fun build(
        context: Context,
        url: String,
        key: String,
        onProgress: (Int) -> Unit,
        cancelled: () -> Boolean,
        eager: Boolean = false,
    ): BuiltTracks? {
        val started = System.currentTimeMillis()
        /*
         * 空间不够就别开工。
         *
         * 一首伴奏 3.8MB，但分离要跑几十秒 —— 跑到一半磁盘写满，用户等了一场空。
         * 上限跟着剩余空间走（见 InstrumentalStore.cacheLimitBytes），这里问的是
         * 「还能不能再放一首」：小于一首的余量就没意义了。
         */
        if (InstrumentalStore.cacheLimitBytes(context) < MIN_CACHE_BYTES) {
            Log.i(TAG, "剩余空间不足，跳过伴奏生成")
            return null
        }
        /*
         * 进度分成三段报，别让用户盯着一个 0%。
         *
         *   0–3%    解码（整首 44.1k 双声道，几秒）
         *   3–6%    模型加载
         *   6–99%   分离（按 11 秒窗口推进，每窗口一次）
         *
         * 之前只在「4 个窗口跑完」时报一次，也就是第一声进度要等 44 秒音频推理完 ——
         * 手机上那是半分钟往上，看起来就是卡死。
         */
        onProgress(1)
        val decoded = TrackPcmDecoder.decode(
            context,
            url,
            /*
             * 分离要**整条**音轨，不按默认的 8 分钟截断。
             *
             * 视频站的一条投稿常常长于 8 分钟（一首歌的 MV 加上前奏、访谈、合集），
             * 而分离出来的伴奏会被当作这首歌的整条音轨来放 —— 一旦截断，播放到
             * 第 8 分钟就静音了，用户看到的正是「音轨分离之后时间轴变短」。
             * 长到这个地步的曲子本来就少见，内存按实际长度算（见 TrackPcmDecoder
             * 里的预估），所以放宽到 30 分钟就够覆盖所有正常投稿了。
             */
            maxSeconds = MAX_SEPARATION_SECONDS,
            onProgress = { fraction -> onProgress(1 + (fraction * 2).toInt()) },
        ) ?: run {
            Log.w(TAG, "解码失败: $url")
            return null
        }
        if (decoded.samples <= 0) return null
        onProgress(3)

        val model = AutomixModels.ensureLocal(
            context,
            AutomixModels.SCNET,
            // 首次要把 13MB 模型从 assets 拷出来；命中时这个回调一次都不会被调。
            onProgress = { copied, total ->
                if (total > 0) onProgress(3 + (copied * 3 / total).toInt().coerceIn(0, 3))
            },
        )
        ScnetRunner.ensureLoaded(model)
        onProgress(6)

        val tempInstrumental = InstrumentalStore.tempFor(context, key, VocalTrackMode.INSTRUMENTAL)
        val tempVocal = InstrumentalStore.tempFor(context, key, VocalTrackMode.VOCAL)
        tempInstrumental.delete()
        tempVocal.delete()
        val writerInstrumental = AacWriter(tempInstrumental.absolutePath, ScnetRunner.SAMPLE_RATE, 2, BIT_RATE)
        val writerVocal = AacWriter(tempVocal.absolutePath, ScnetRunner.SAMPLE_RATE, 2, BIT_RATE)
        val totalWindows = (decoded.samples + ScnetRunner.SEGMENT - 1) / ScnetRunner.SEGMENT
        var finished = false
        try {
            var cursor = 0
            while (cursor < decoded.samples) {
                if (cancelled()) {
                    Log.i(TAG, "生成被取消，已到 ${cursor * 100L / decoded.samples}%")
                    return null
                }
                val end = minOf(cursor + BLOCK_WINDOWS * ScnetRunner.SEGMENT, decoded.samples)
                val windowsBefore = cursor / ScnetRunner.SEGMENT
                val stems = ScnetRunner.separate(
                    decoded.left,
                    decoded.right,
                    stems = listOf(STEM_VOCALS),
                    fromSample = cursor,
                    toSample = end,
                    /*
                     * 窗口级进度：一块 4 个窗口，每跑完一个窗口就报一次。
                     * 这是「进度条会动」和「进度条卡住」的分界线 ——
                     * 一个窗口十几秒，比一整块四十多秒好等得多。
                     */
                    onProgress = { done, _ ->
                        onProgress(percentForWindow(windowsBefore + done, totalWindows))
                    },
                    cancelled = cancelled,
                    eager = eager,
                ).stems
                val vocals = stems["vocals"] ?: return null
                val frames = end - cursor
                writerInstrumental.write(mixMinusVocals(decoded.left, decoded.right, vocals, cursor, frames), frames)
                writerVocal.write(vocalsOnly(vocals, frames), frames)
                cursor = end
            }
            writerInstrumental.finish()
            writerVocal.finish()
            finished = true
            onProgress(100)
        } catch (error: Throwable) {
            Log.w(TAG, "生成伴奏失败", error)
        } finally {
            try { writerInstrumental.close() } catch (_: Throwable) {}
            try { writerVocal.close() } catch (_: Throwable) {}
        }
        if (!finished) {
            // 取消或失败：半截文件留着只会占地方，下次启动虽然也会扫，但没必要等那么久。
            tempInstrumental.delete()
            tempVocal.delete()
            return null
        }

        val targetInstrumental = InstrumentalStore.targetFor(context, key, VocalTrackMode.INSTRUMENTAL)
        val targetVocal = InstrumentalStore.targetFor(context, key, VocalTrackMode.VOCAL)
        val okInstrumental = InstrumentalStore.commit(tempInstrumental, targetInstrumental)
        val okVocal = InstrumentalStore.commit(tempVocal, targetVocal)
        if (!okInstrumental || !okVocal) {
            Log.w(TAG, "音轨落盘失败: ${targetInstrumental.absolutePath}")
            tempInstrumental.delete()
            tempVocal.delete()
            targetInstrumental.delete()
            targetVocal.delete()
            return null
        }
        Log.i(
            TAG,
            "音轨完成：${decoded.samples * 1000L / decoded.sampleRate}ms, " +
                "伴奏 ${targetInstrumental.length() / 1024}KB / 清唱 ${targetVocal.length() / 1024}KB, " +
                "耗时 ${System.currentTimeMillis() - started}ms",
        )
        return BuiltTracks(targetInstrumental, targetVocal)
    }

    /**
     * 原曲 − 人声。
     *
     * 直接逐样本相减，不做任何压缩或限幅：两边都来自同一份解码结果，
     * 对齐是样本级的，减完的峰值不会超过原曲（最多到 2 倍的情况出现在
     * 模型估计反相的地方，所以还是要夹一下）。
     */
    private fun mixMinusVocals(
        left: FloatArray,
        right: FloatArray,
        vocals: Array<FloatArray>,
        from: Int,
        frames: Int,
    ): ByteArray {
        val bytes = ByteArray(frames * 4)
        val vocalL = vocals[0]
        val vocalR = if (vocals.size > 1) vocals[1] else vocals[0]
        var at = 0
        for (index in 0 until frames) {
            val source = from + index
            val l = ((left[source] - vocalL[index]) * 32767f).toInt().coerceIn(-32768, 32767)
            val r = ((right[source] - vocalR[index]) * 32767f).toInt().coerceIn(-32768, 32767)
            bytes[at] = (l and 0xFF).toByte()
            bytes[at + 1] = ((l shr 8) and 0xFF).toByte()
            bytes[at + 2] = (r and 0xFF).toByte()
            bytes[at + 3] = ((r shr 8) and 0xFF).toByte()
            at += 4
        }
        return bytes
    }

    /** 只留人声：直接用模型估出来的 vocals 轨，不混任何原曲。 */
    private fun vocalsOnly(vocals: Array<FloatArray>, frames: Int): ByteArray {
        val bytes = ByteArray(frames * 4)
        val vocalL = vocals[0]
        val vocalR = if (vocals.size > 1) vocals[1] else vocals[0]
        var at = 0
        for (index in 0 until frames) {
            val l = (vocalL[index] * 32767f).toInt().coerceIn(-32768, 32767)
            val r = (vocalR[index] * 32767f).toInt().coerceIn(-32768, 32767)
            bytes[at] = (l and 0xFF).toByte()
            bytes[at + 1] = ((l shr 8) and 0xFF).toByte()
            bytes[at + 2] = (r and 0xFF).toByte()
            bytes[at + 3] = ((r shr 8) and 0xFF).toByte()
            at += 4
        }
        return bytes
    }

    /**
     * 极简 AAC 编码器：PCM 16bit 交织 → m4a。
     *
     * 同步模式（dequeue 轮询），只在生成伴奏这一条后台线程上跑，不涉及实时性。
     */
    private class AacWriter(
        path: String,
        private val sampleRate: Int,
        private val channels: Int,
        bitRate: Int,
    ) {

        private val codec: MediaCodec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
        private val muxer = MediaMuxer(path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        private val info = MediaCodec.BufferInfo()
        private var trackIndex = -1
        private var muxerStarted = false
        private var fedFrames = 0L

        init {
            val format = MediaFormat.createAudioFormat(
                MediaFormat.MIMETYPE_AUDIO_AAC,
                sampleRate,
                channels,
            ).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setInteger(MediaFormat.KEY_BIT_RATE, bitRate)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16 * 1024)
            }
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
        }

        /** 喂一批交织的 16bit 小端 PCM。 */
        fun write(pcm: ByteArray, frames: Int) {
            var offset = 0
            val end = frames * channels * 2
            while (offset < end) {
                val index = codec.dequeueInputBuffer(TIMEOUT_US)
                if (index < 0) {
                    drain(endOfStream = false)
                    continue
                }
                val buffer = codec.getInputBuffer(index) ?: continue
                buffer.clear()
                val take = minOf(buffer.remaining(), end - offset)
                buffer.put(pcm, offset, take)
                codec.queueInputBuffer(index, 0, take, presentationTimeUs(), 0)
                fedFrames += take / (channels * 2)
                offset += take
                drain(endOfStream = false)
            }
        }

        fun finish() {
            val index = codec.dequeueInputBuffer(TIMEOUT_US)
            if (index >= 0) {
                codec.queueInputBuffer(
                    index,
                    0,
                    0,
                    presentationTimeUs(),
                    MediaCodec.BUFFER_FLAG_END_OF_STREAM,
                )
            }
            drain(endOfStream = true)
        }

        fun close() {
            try {
                codec.stop()
            } catch (_: Throwable) {
                // 已经在 finish 里结束，停不掉不该拖垮上层。
            }
            try {
                codec.release()
            } catch (_: Throwable) {
            }
            try {
                if (muxerStarted) muxer.stop()
            } catch (_: Throwable) {
            }
            try {
                muxer.release()
            } catch (_: Throwable) {
            }
        }

        private fun presentationTimeUs(): Long = fedFrames * 1_000_000L / sampleRate

        private fun drain(endOfStream: Boolean) {
            /*
             * 等 EOS 的那几轮要有个上限：真遇到不吐 EOS 的编码器实现，
             * 这里死循环就是「生成伴奏永远卡在 99%」——宁可失败，不能卡死。
             */
            var idle = 0
            while (true) {
                if (idle > 500) return
                idle += 1
                val index = codec.dequeueOutputBuffer(info, if (endOfStream) TIMEOUT_US else 0L)
                when {
                    index == MediaCodec.INFO_TRY_AGAIN_LATER -> return
                    index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        if (!muxerStarted) {
                            /*
                             * 写 mvhd 的时长。
                             *
                             * MediaMuxer 自己不知道总长度（它只见到一个个采样），mp4 的
                             * 时长字段因此常常是 0 或者很短一截；播放器读到的就是
                             * 「这条音轨只有几十秒」—— 用户看到的是进度条突然到头、
                             * 后半段没声音，也就是报的那句「音轨分离之后时间轴变短」。
                             *
                             * 已经在喂的帧数能算出准确长度（总帧数 / 采样率），
                             * 趁建轨的时候写进格式里。
                             */
                            val trackFormat = codec.outputFormat
                            if (fedFrames > 0 && sampleRate > 0) {
                                trackFormat.setLong(
                                    MediaFormat.KEY_DURATION,
                                    fedFrames * 1_000_000L / sampleRate,
                                )
                            }
                            trackIndex = muxer.addTrack(trackFormat)
                            muxer.start()
                            muxerStarted = true
                        }
                    }
                    index >= 0 -> {
                        val buffer: ByteBuffer = codec.getOutputBuffer(index) ?: continue
                        // 编码器配置（AudioSpecificConfig）由 muxer 从 outputFormat 里取，
                        // 这一帧本身没有音频数据，直接丢掉。
                        if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
                        if (info.size > 0 && muxerStarted) {
                            buffer.position(info.offset)
                            buffer.limit(info.offset + info.size)
                            muxer.writeSampleData(trackIndex, buffer, info)
                        }
                        codec.releaseOutputBuffer(index, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
                    }
                }
            }
        }

        private companion object {
            const val TIMEOUT_US = 10_000L
        }
    }
}
