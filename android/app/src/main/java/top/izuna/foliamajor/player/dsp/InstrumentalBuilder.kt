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
// 「关闭人声 / 只留人声」的真身：用 SCNet 把整首歌分离成四轨，播放时按模式实时混音。
//
// 为什么不能再靠 DSP：
//   中置相消只能减掉「左右完全一样」的成分。真实混音里人声带混响、加倍和声、
//   立体声延迟 —— 这些都不在中置，相消之后人声只是变小、整首歌也跟着变薄。
//   要「掐掉」或「只留人声」，唯一的路是把音轨真的分离出来。
//
// 流程（一首歌只跑一次，结果按 LRU 缓存）：
//   1. 按块解码（每块 8 个 11 秒窗口 ≈ 88 秒），解完这一块就丢；
//   2. 每块一次 separate()，四轨全部保留；
//   3. 四轨各自写 16bit AAC（清唱 = 人声轨、伴奏 = 其余三轨，由 StemMixProcessor 实时相加）；
//   4. 写临时文件，成功后原子改名 —— 播放端永远看不到半截文件。
//
// 为什么分块而不是一次分离整首：separate() 的输出是「整段长度 × 2 声道 × 4 字节」，
// 4 分钟的歌一次要 85MB，加上解码出来的原曲 85MB，中端机直接进内存压力区。
// 分块之后常驻只有 30MB 左右，而块边界都落在 11 秒窗口的边界上，与一次跑完全等价。
//
// 为什么写 AAC 而不是 WAV：同样的歌 WAV 是 42MB，AAC 128k 是 3.8MB。
// 用户要的是「缓存占用少」，一百首也就 380MB。
internal object InstrumentalBuilder {

    private const val TAG = "Instrumental"

    /** 伴奏码率。人声已经去掉了，剩下的乐器 128k 足够，再高只是浪费空间。 */
    private const val BIT_RATE = 128_000

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

    /** 一次分离的成品：四轨各一份。清唱 = 人声轨、伴奏 = 其余三轨。 */
    data class BuiltTracks(val stems: Map<StemKind, File>)

    /** 后台时每个块之间歇多久：够狠 —— 整块让出 CPU，内存也已按块释放。 */
    private const val BACKGROUND_BLOCK_SLEEP_MS = 5_000L

    /** 一次 decodeRange 解多少个 11s 窗口。8 个 ≈ 88 秒，常驻内存约 30MB。 */
    private const val CHUNK_WINDOWS = 8

    /**
     * 生成一首歌的四轨分离结果。
     *
     * 只写四轨（drums / bass / other / vocals）：清唱 = 人声轨、伴奏 = 其余三轨，
     * 播放时由 StemMixProcessor 按模式实时混音。不再另写两份派生 m4a，也就不存在
     * 「拆完把派生文件换到别的歌上」这条错源路径。
     *
     * 调用方必须在后台线程跑：解码 + 推理是几十秒的活。
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
        background: () -> Boolean = { false },
    ): BuiltTracks? {
        val started = System.currentTimeMillis()
        if (InstrumentalStore.cacheLimitBytes(context) < MIN_CACHE_BYTES) {
            Log.i(TAG, "剩余空间不足，跳过音轨生成")
            return null
        }
        onProgress(1)
        /*
         * 分块解码：一次只解 CHUNK_WINDOWS 个窗口（约 88 秒），拆完就丢，常驻内存只有
         * 这一块 + 模型。原来把整首歌解成双声道 PCM 再拆，一首 4 分钟 85MB、长歌更大，
         * 后台时系统按内存压力直接回收进程 —— 光降 CPU 压不住。
         */
        val durationSec = TrackPcmDecoder.durationSec(url)
        val totalSamples = if (durationSec > 0) {
            (durationSec * ScnetRunner.SAMPLE_RATE).toLong().coerceAtMost(MAX_SEPARATION_SECONDS * ScnetRunner.SAMPLE_RATE.toLong())
        } else {
            MAX_SEPARATION_SECONDS * ScnetRunner.SAMPLE_RATE.toLong()
        }
        onProgress(3)

        val model = AutomixModels.ensureLocal(
            context,
            AutomixModels.SCNET,
            onProgress = { copied, total ->
                if (total > 0) onProgress(3 + (copied * 3 / total).toInt().coerceIn(0, 3))
            },
        )
        ScnetRunner.ensureLoaded(model)
        onProgress(6)

        val temps = mutableMapOf<StemKind, File>()
        val targets = mutableMapOf<StemKind, File>()
        for (kind in StemKind.ALL) {
            temps[kind] = InstrumentalStore.stemTempFor(context, key, kind)
            targets[kind] = InstrumentalStore.stemTargetFor(context, key, kind)
        }
        temps.values.forEach { it.delete() }

        val writers = mutableMapOf<StemKind, AacWriter>()
        for (kind in StemKind.ALL) {
            writers[kind] = AacWriter(temps.getValue(kind).absolutePath, ScnetRunner.SAMPLE_RATE, 2, BIT_RATE)
        }
        val chunkSamples = CHUNK_WINDOWS * ScnetRunner.SEGMENT
        val totalWindows = ((totalSamples + ScnetRunner.SEGMENT - 1) / ScnetRunner.SEGMENT).toInt()
        var finished = false
        var writtenSamples = 0L
        try {
            var cursorSec = 0.0
            var decodedAny = false
            while (writtenSamples < totalSamples) {
                if (cancelled()) {
                    Log.i(TAG, "生成被取消，已到 ${writtenSamples * 100L / totalSamples}%")
                    return null
                }
                val remainSec = (totalSamples - writtenSamples).toDouble() / ScnetRunner.SAMPLE_RATE
                val chunkSec = minOf(chunkSamples.toDouble() / ScnetRunner.SAMPLE_RATE, remainSec)
                val decoded = TrackPcmDecoder.decodeRange(context, url, cursorSec, chunkSec)
                if (decoded == null || decoded.samples <= 0) {
                    if (!decodedAny) {
                        Log.w(TAG, "解码失败: $url")
                        return null
                    }
                    break
                }
                decodedAny = true
                val windowsBefore = (writtenSamples / ScnetRunner.SEGMENT).toInt()
                val stems = ScnetRunner.separate(
                    decoded.left,
                    decoded.right,
                    stems = StemKind.ALL.indices.toList(),
                    fromSample = 0,
                    toSample = decoded.samples,
                    onProgress = { done, _ ->
                        onProgress(percentForWindow(windowsBefore + done, totalWindows))
                    },
                    cancelled = cancelled,
                    eager = eager,
                ).stems
                val frames = decoded.samples
                val drums = stems["drums"] ?: return null
                val bass = stems["bass"] ?: return null
                val other = stems["other"] ?: return null
                val vocals = stems["vocals"] ?: return null
                writers.getValue(StemKind.DRUMS).write(interleave16(drums, frames), frames)
                writers.getValue(StemKind.BASS).write(interleave16(bass, frames), frames)
                writers.getValue(StemKind.OTHER).write(interleave16(other, frames), frames)
                writers.getValue(StemKind.VOCALS).write(interleave16(vocals, frames), frames)
                writtenSamples += decoded.samples
                cursorSec += chunkSec
                // 后台狠限：整块让出 CPU；内存这边已经按块释放，进程不再因为大 PCM 被杀。
                if (background()) {
                    Thread.sleep(BACKGROUND_BLOCK_SLEEP_MS)
                }
            }
            writers.values.forEach { it.finish() }
            finished = true
            onProgress(100)
        } catch (error: Throwable) {
            Log.w(TAG, "生成音轨失败", error)
        } finally {
            writers.values.forEach { try { it.close() } catch (_: Throwable) {} }
        }
        if (!finished) {
            temps.values.forEach { it.delete() }
            return null
        }

        for (kind in StemKind.ALL) {
            if (!InstrumentalStore.commit(temps.getValue(kind), targets.getValue(kind))) {
                Log.w(TAG, "音轨落盘失败: ${targets.getValue(kind).absolutePath}")
                (temps.values + targets.values).forEach { it.delete() }
                return null
            }
        }
        Log.i(
            TAG,
            "音轨完成：${writtenSamples * 1000L / ScnetRunner.SAMPLE_RATE}ms, " +
                "四轨 ${targets.values.sumOf { it.length() } / 1024}KB, " +
                "耗时 ${System.currentTimeMillis() - started}ms",
        )
        return BuiltTracks(targets.toMap())
    }

    /**
     * 一条音轨（stereo 浮点，两条样本级对齐）→ 16bit 交织 PCM。
     *
     * 峰值用夹紧兜底 —— 分轨模型的估计可能让个别样本超过 1.0，夹一下比限幅更便宜也够用。
     * 四轨相加不再在这里做：每条轨各写一份文件，相加由 StemMixProcessor 实时完成
     * （这样才能按模式只要其中几轨）。
     */
    private fun interleave16(pair: Array<FloatArray>, frames: Int): ByteArray {
        val bytes = ByteArray(frames * 4)
        val left = pair[0]
        val right = if (pair.size > 1) pair[1] else pair[0]
        var at = 0
        for (index in 0 until frames) {
            val l = (left[index] * 32767f).toInt().coerceIn(-32768, 32767)
            val r = (right[index] * 32767f).toInt().coerceIn(-32768, 32767)
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
