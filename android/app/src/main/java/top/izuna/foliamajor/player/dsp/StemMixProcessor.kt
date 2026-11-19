package top.izuna.foliamajor.player.dsp

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import top.izuna.foliamajor.automix.ScnetRunner
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/StemMixProcessor.kt
// 四轨混音内核：四个分离音轨各自摆位、实时混成一路立体声。
//
// 挂点：FoliaAudioSinkFactory 的 processor 链里**排在 EqAudioProcessor 之前** ——
// 它负责「这首歌的声源是什么」，EQ / 压缩 / 混响那条链再对混好的结果做整体调音。
//
// 为什么在这里而不是再造四台 ExoPlayer：
//   四台播放器各自一个 AudioTrack，混音发生在空气里 —— 摆位、同步、音频焦点、切歌
//   每一样都要自己再写一遍，还做不到样本级对齐。把 ExoPlayer 当**时钟**（它继续播原曲、
//   位置 / 暂停 / 倍速 / 循环全由它管），处理器把同一时间轴上的四个音轨解出来、摆位、
//   相加，输出替换掉原曲 PCM。
//
// 数据流（音频渲染线程，逐块）：
//   queueInput 进来的是原曲的 N 帧 16bit PCM（时钟）→ 若这一块不该走四轨混音，原样直通；
//   否则四个 StemDecoder 各吐出 N 帧 → SpatialStage 摆位 → 四轨相加 → 编码成 16bit 输出。
//   频谱与后面的调音链照常工作。哪些情况直通由 [resolve] 决定（纯函数，单测直接锁它）。
//
// 时钟与同步：
//   [masterFrames] 累计 queueInput 进来的帧数 —— 直通期间也累加，因为原曲 PCM 流
//   本身就是 ExoPlayer 的时间轴。seek（onFlush + pendingSeek）时校准到目标帧，
//   换歌时由 StemMixState.publishSong 重置。每轨记 [stemFrames]；轨从「不参与」
//   （被模式过滤 / 用户关掉）转回「参与」时若落后超过容差，重开该轨解码器对齐，
//   不再出现「切出去几十秒再切回来，乐器回到过去」。
//
// 解码器创建：
//   MediaCodec 的 create/configure/start 耗时可达数十毫秒，绝不能发生在音频渲染
//   线程的一个块里（直接 AudioTrack underrun）。所有 open 都提交到单条后台预热线程，
//   完成后经无锁队列交接给音频线程；交接后的一次性追赶（discard）只花几毫秒。
//   预热期间保持直通原曲 —— 用户听感上只是「关闭人声 / 只留人声晚几百毫秒生效」，
//   而不是一次爆音或卡顿。
//
// 音频线程上的循环一律有轮数上限（[readAttemptBudget] / [discardAttemptBudget]）：
// 解码器不吐数据时在渲染线程死等，就是 AudioTrack 断供 —— 用户看到的是「自动暂停」
// 或「无法自动下一首」。超限按「本块少解 / 少追赶」处理，落后由 resync 容差兜底。
//
// 同步：四个音轨与原曲同采样率、同长度、同一起点。AAC 编码延迟造成的 1~2 ms
//   恒定偏移听不出来，不计。
//
// ⚠️ 真机验证：MediaCodec 的同步解码对具体 ROM 的实现细节敏感
//   （dequeueOutputBuffer 的时序、EOS 行为、SEEK_TO_PREVIOUS_SYNC 的落点）。

@UnstableApi
class StemMixProcessor(
    private val state: NativeEqualizerState,
) : BaseAudioProcessor() {

    private var sampleRate = 0
    private var channels = 0

    private val stages = Array(StemKind.ALL.size) { SpatialStage() }
    private val decoders = arrayOfNulls<StemDecoder>(StemKind.ALL.size)
    /** 每轨解码器自己的时间轴位置（44.1k 帧数）。 */
    private val stemFrames = LongArray(StemKind.ALL.size)
    private val stemFloat = Array(StemKind.ALL.size) { FloatArray(0) }
    private var mix = FloatArray(0)
    private var scratch = FloatArray(0)
    private var raw = ByteArray(0)
    private var carry = ByteArray(0)
    private var carrySize = 0
    private var lastKey: String? = null
    private val pcm = Pcm16Codec()

    /** 原曲 PCM 流的累计帧数：这就是 ExoPlayer 时钟。seek / 换歌时校准。 */
    private var masterFrames = 0L

    /** 轨时间轴落后多少帧就要重开对齐（2048 帧 ≈ 46ms @44.1k）。 */
    private val resyncToleranceFrames = 2048L

    /**
     * 音频线程每块的解码轮数预算（每轮一次 dequeueOutputBuffer，超时 10ms）。
     *
     * 真机上 ROM 的 MediaCodec 偶发慢供给 / 卡死：没有预算的话 read() 会在
     * 音频线程里无限轮 —— AudioTrack 长时间无数据，用户看到的就是「自动暂停」。
     * 超预算时本块少解的那部分按静音补，轨时间轴落后由 resync 容差兜底对齐。
     */
    private val readAttemptBudget = 4

    /** seek 追赶（discard）一次最多追多少帧（≈2s @44.1k），超出交给 resync 重开。 */
    private val discardBudgetFrames = 88_200L

    /** seek 追赶一次最多走几轮解码：与 [readAttemptBudget] 同一个道理，不许在音频线程上等。 */
    private val discardAttemptBudget = 8

    // —— 后台预热：解码器的 open（MediaExtractor + MediaCodec 创建）不在音频线程做 —

    /** 每次换歌 / 全量重开 +1，旧预热任务完成后发现对不上号就自弃。 */
    private val openGeneration = AtomicLong(0)

    /**
     * 已提交预热、还没交接回来的轨。只在音频线程访问；防止逐块重复提交。
     *
     * ⚠️ 它必须与 [openGeneration] 一起维护：只要 generation 抬了一截（[releaseDecoders]），
     * 在飞的预热就全部作废，这本账也要同时清空；每一轨交接回来（不论装上、过期、歌不符、
     * 已有解码器还是 open 失败）都要 remove。只加不减的话，第一首拆完集合就永不清空，
     * 切到第二首时 [requestWarm] 过滤出空集合直接 return，四轨混音从此永久失效。
     * StemWarmPendingTest 锁这两条。
     */
    internal val warmPending = HashSet<StemKind>()

    /** 后台 open 完成、等待音频线程接手的解码器（无锁交接）。 */
    private val handoffQueue = ConcurrentLinkedQueue<StemHandoff>()

    private val warmWorker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "folia-stem-warm").apply {
            isDaemon = true
            // 比普通线程低一格：预热是几十毫秒的杂活，不能抢正在放歌的核。
            priority = Thread.NORM_PRIORITY - 1
        }
    }

    /**
     * 一次预热的结果。[decoder] 为 null 表示这一轨 open 失败：交回来只为让音频线程
     * 把这一轨从 [warmPending] 里摘掉，让以后的块还能再试。
     */
    internal class StemHandoff(
        val generation: Long,
        val songKey: String,
        val kind: StemKind,
        val decoder: StemDecoder?,
        val baseFrames: Long,
    )

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
        masterFrames = 0L
        lastKey = null
        return inputAudioFormat
    }

    override fun onFlush(streamMetadata: AudioProcessor.StreamMetadata) {
        carrySize = 0
        // seek 之后旧解码器的时间轴已经作废；同时把时钟校准到 seek 目标。
        if (StemMixState.hasPendingSeek()) {
            StemMixState.consumeSeek()
            masterFrames = StemMixState.lastSeekFrames()
            releaseDecoders()
        }
    }

    override fun onQueueEndOfStream() {
        // 播放结束：让悬着的预热任务自弃（generation 已在 releaseDecoders 里递增）。
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
        if (session == null || resolve(state.activeMode(), sampleRate, channels) != MIX) {
            // 直通也要推时钟：原曲 PCM 流就是 ExoPlayer 时间轴（时钟基准）。
            masterFrames += incoming / (2L * channels)
            passthrough(inputBuffer, incoming)
            return
        }
        state.stemMixActive = true

        // 接手后台预热完成的解码器：装上、一次性追赶、时间轴对齐到此刻。
        installHandedOffDecoders(session)

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

        // 换歌 / seek 后首次（全部解码器为空）：提交后台预热，本块输出原曲直通。
        // 注意 scratch 已经解好了本块的原曲 PCM，直接编码输出，不再碰 inputBuffer。
        if (lastKey != session.songKey || decoders.all { it == null }) {
            if (lastKey != session.songKey) {
                releaseDecoders()
                lastKey = session.songKey
                /*
                 * ★ 换歌时上一首的 lastSeekFrames 不能继承（那是上一首的时间轴）：
                 * 只有带 pendingSeek（换歌同时用户已 seek 到新位置）才用目标帧，
                 * 否则从 0 起 —— 不然新歌四轨从上一首的 seek 位置开始解码，
                 * 整首错位，听感就是「被换成了另一段音频」。
                 */
                masterFrames = if (StemMixState.hasPendingSeek()) {
                    StemMixState.consumeSeek()
                    StemMixState.lastSeekFrames()
                } else {
                    0L
                }
            }
            requestWarm(session, StemKind.ALL.toSet())
            masterFrames += frames
            val out = replaceOutputBuffer(used)
            pcm.encode(scratch, frames * channels, out)
            out.flip()
            state.stemMixActive = false
            return
        }

        val mode = state.activeMode()
        val settings = StemMixState.settings()
        for (index in 0 until mix.size) mix[index] = 0f
        var audible = 0
        // 播放模式决定哪些音轨参与：伴奏 = 鼓/贝斯/其他；清唱 = 人声。
        // 在此基础上再叠加用户对每轨的 audible 开关。
        for (kind in StemKind.ALL) {
            val wantedByMode = when (mode) {
                VocalTrackMode.INSTRUMENTAL -> kind != StemKind.VOCALS
                VocalTrackMode.VOCAL -> kind == StemKind.VOCALS
                // 上面已用 resolve() 挡掉「没有模式」，这里只是让 when 穷尽。
                null -> false
            }
            if (!wantedByMode) continue
            val stem = settings.resolve(kind)
            if (!stem.audible) continue
            val decoder = decoders[kind.ordinal] ?: continue
            /*
             * 时间轴对齐：轨被模式 / audible 过滤的期间位置冻结，
             * 重新参与时若落后时钟超过容差，后台重开该轨（期间该轨静音），
             * 不把「几十秒前的旧数据」混进正在播的位置。
             */
            if (stemFrames[kind.ordinal] + resyncToleranceFrames < masterFrames) {
                decoders[kind.ordinal] = null
                decoder.release()
                requestWarm(session, setOf(kind))
                continue
            }
            audible += 1
            val buffer = ensureStem(kind.ordinal, frames * channels)
            for (index in 0 until frames * channels) buffer[index] = 0f
            val got = decoder.read(buffer, frames, channels, readAttemptBudget)
            // 短了的帧（文件末尾 / 本块解码预算用完）按静音补齐，不把旧数据混进来。
            if (got < frames) {
                for (index in got * channels until frames * channels) buffer[index] = 0f
            }
            stemFrames[kind.ordinal] += frames
            stages[kind.ordinal].process(buffer, 0, frames, channels, stem)
            for (index in 0 until frames * channels) mix[index] += buffer[index]
        }
        if (audible > 0) {
            for (index in 0 until frames * channels) scratch[index] = mix[index]
        } else {
            // 四轨全关：静音。用已经清空的 mix 覆盖原曲（用户要的是「全部」里也能全关）。
            for (index in 0 until frames * channels) scratch[index] = 0f
        }

        masterFrames += frames

        val out = replaceOutputBuffer(used)
        pcm.encode(scratch, frames * channels, out)
        out.flip()
    }

    private fun passthrough(inputBuffer: ByteBuffer, incoming: Int) {
        state.stemMixActive = false
        val out = replaceOutputBuffer(incoming)
        out.put(inputBuffer)
        out.flip()
    }

    // ——— 后台预热与交接 ————————————————————————————————————————

    /**
     * 提交后台 open：把 [kinds] 的解码器在 warm 线程上创建好，再交回音频线程。
     * baseFrames 取当前时钟；交接时一次性追赶（discard）到最新时钟。
     */
    internal fun requestWarm(session: StemMixSession, kinds: Set<StemKind>) {
        /*
         * 去重：解码器还没交接回来的轨不许重复提交。没有这一道的话，seek /
         * 换歌后「解码器全空」的每个块都会再排一轮 4 个 open —— warm 线程被
         * 成百上千个重复 open 压垮，MediaCodec 实例限额被占满，全链越来越卡。
         */
        val pending = kinds.filterNot { warmPending.contains(it) }
        if (pending.isEmpty()) return
        warmPending.addAll(pending)
        val generation = openGeneration.get()
        val baseFrames = masterFrames
        val songKey = session.songKey
        warmWorker.execute {
            for (kind in pending) {
                if (openGeneration.get() != generation) return@execute
                /*
                 * 每一轨、每一种结局都要交一条回去（包括「文件没了」）：账本只由音频线程
                 * 在 installHandedOffDecoders 里摘，交不回去这一轨就永远挂着。
                 */
                val file = session.stems[kind.ordinal]
                if (file == null) {
                    handoffQueue.add(StemHandoff(generation, songKey, kind, null, baseFrames))
                    continue
                }
                val decoder = StemDecoder()
                val handoff = try {
                    decoder.open(file.absolutePath, baseFrames)
                    // 打开耗时里 generation 可能已经抬了（换歌 / seek）：这一下没人会接手，
                    // 交一个 null 回去只为让音频线程把这一轨从 warmPending 摘掉。
                    if (openGeneration.get() != generation) {
                        decoder.release()
                        StemHandoff(generation, songKey, kind, null, baseFrames)
                    } else {
                        StemHandoff(generation, songKey, kind, decoder, baseFrames)
                    }
                } catch (error: Throwable) {
                    // 单轨打开失败（文件被清理 / ROM 不认编码）：整轨静音，别炸整条链。
                    Log.w(TAG, "四轨预热失败: ${file.name}", error)
                    decoder.release()
                    StemHandoff(generation, songKey, kind, null, baseFrames)
                }
                handoffQueue.add(handoff)
            }
        }
    }

    /**
     * 音频线程每块开头调：接手预热完成的解码器，并追赶到现在。
     *
     * ⚠️ 每一个交接**都**要把这一轨从 [warmPending] 摘掉，而且要在 finally 里摘：
     * 成功装上、generation 过期、歌不符、已有解码器、open 失败这五种结局都要摘。
     * 漏掉任何一种，这一轨就永远停在「已提交预热」里，这首歌之后的 open 全被挡住
     * （requestWarm 过滤出空集合直接 return）—— 表现就是四轨混音永久失效。
     */
    internal fun installHandedOffDecoders(session: StemMixSession) {
        while (true) {
            val handoff = handoffQueue.poll() ?: break
            try {
                // 过期任务（换歌 / seek 已让位，generation 对不上）：直接丢掉，别装错时间轴的轨。
                if (handoff.generation != openGeneration.get()) continue
                // open 失败 / 打开期间让位：没有解码器可装，这一轨下次再说。
                val decoder = handoff.decoder ?: continue
                // 交接回来的已经是别的歌：装上去就是「用上一首的数据播这一首」。
                if (handoff.songKey != session.songKey) {
                    decoder.release()
                    continue
                }
                val kind = handoff.kind
                if (decoders[kind.ordinal] != null) {
                    // 已有同轨解码器在位：丢弃后来者（resync 与全量预热撞车）。
                    decoder.release()
                    continue
                }
                // 追赶：open 期间时钟又走了 behind 帧，解码快进丢掉（预算内做完，超出交给 resync）。
                val behind = masterFrames - handoff.baseFrames
                if (behind > 0) decoder.discard(behind, discardBudgetFrames, discardAttemptBudget)
                decoders[kind.ordinal] = decoder
                stemFrames[kind.ordinal] = masterFrames
                stages[kind.ordinal].reset()
            } finally {
                warmPending.remove(handoff.kind)
            }
        }
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

    internal fun releaseDecoders() {
        openGeneration.incrementAndGet()
        handoffQueue.clear()
        // 与 generation 递增配对：在飞的预热全部作废，这本账也跟着作废。
        warmPending.clear()
        decoders.forEach { it?.release() }
        decoders.fill(null)
        stages.forEach { it.reset() }
        stemFrames.fill(0L)
        state.stemMixActive = false
    }

    // ——— 测试钩子（只读 / 只写队列） ——————————————————————————

    internal fun installedDecoderCount(): Int = decoders.count { it != null }

    internal fun hasDecoder(kind: StemKind): Boolean = decoders[kind.ordinal] != null

    internal fun queuedHandoffCount(): Int = handoffQueue.size

    /**
     * 测试用：把一条交接直接塞进队列，等下一次 [installHandedOffDecoders] 处理。
     *
     * 真机上这件事只由预热线程做（open 完把解码器交回来）；JVM 单测里没有可用的
     * MediaCodec，用它覆盖「交接回来之后账本怎么变」这一半逻辑。
     */
    internal fun enqueueHandoffForTest(handoff: StemHandoff) {
        warmPending.add(handoff.kind)
        handoffQueue.add(handoff)
    }

    /** 测试用：把某几轨标记成「已提交预热、还没回来」，不算真的提交。 */
    internal fun markWarmPendingForTest(kinds: Set<StemKind>) {
        warmPending.addAll(kinds)
    }

    /** 测试用：当前 generation，用于构造过期交接。 */
    internal fun openGenerationForTest(): Long = openGeneration.get()

    companion object {
        private const val TAG = "FoliaStem"

        /** [resolve] 的返回值：这一块走四轨混音。 */
        const val MIX = 0

        /** 没有「四轨齐了」的会话：这首歌没拆过，或者拆完的文件已经不在。 */
        const val PASSTHROUGH_NO_SESSION = 1

        /** 时钟不是 44.1k：四轨是 44.1k 写的，时间轴对不上，宁可直通。 */
        const val PASSTHROUGH_RATE = 2

        /** 时钟不是双声道：四轨都是立体声，摆位没有意义。 */
        const val PASSTHROUGH_CHANNELS = 3

        /** 没有显式模式（既没开「关闭人声」也没开「只留人声」）：原曲就是四轨的和。 */
        const val PASSTHROUGH_ORIGINAL = 4

        /**
         * 这一块该不该走四轨混音，以及不该走的原因。
         *
         * 纯函数，原因用常量返回：单测直接锁判据，不需要造 MediaCodec。
         *
         * 「全部」走原曲而不是四轨相加，是刻意的：原曲自己就是四轨的和，再混一遍
         * 只是拿四份 AAC 转码后的近似值去替换一条原始流 —— 白开四个解码器、多耗
         * 一份 CPU，音质还更差。四轨只在需要「少一轨 / 只留一轨」时才有意义。
         */
        fun resolve(
            mode: VocalTrackMode?,
            sampleRate: Int,
            channels: Int,
        ): Int = when {
            mode == null -> PASSTHROUGH_ORIGINAL
            sampleRate != ScnetRunner.SAMPLE_RATE -> PASSTHROUGH_RATE
            channels != 2 -> PASSTHROUGH_CHANNELS
            else -> MIX
        }
    }
}

/**
 * 一个音轨的同步解码器：MediaExtractor + MediaCodec，按需吐 PCM。
 *
 * 线程：open 在 warm 预热线程完成后交给音频渲染线程独占使用（MediaCodec 的
 * 单线程使用纪律：configure/start 之后只由一个线程驱动）。缓冲复用，不逐块 new。
 *
 * 解码轮数一律有上限（[read] / [discard] 的 budget 参数）：这是音频渲染线程，
 * 解码器不吐数据时在这里无限循环就是 AudioTrack 断供 —— 用户看到的是「自动暂停」
 * 或「无法自动下一首」。超预算时本块少解，落后由调用方的 resync 容差兜底。
 */
internal class StemDecoder {

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

    /**
     * 预热交接后的一次性追赶：解码并丢弃 [frames] 帧。
     *
     * 两个上限都要有：[maxFrames] 按帧数（≈2 秒）截断，[attemptBudget] 按解码轮数截断 ——
     * 只限帧数的话，解码器一直 INFO_TRY_AGAIN_LATER 时每轮 10ms 超时、循环照样转，
     * 追不上就一直转在音频线程上。超出预算的部分交给调用方的 resync 重开。
     */
    fun discard(frames: Long, maxFrames: Long, attemptBudget: Int) {
        if (frames <= 0L || codec == null) return
        var remaining = minOf(frames, maxFrames)
        var attempts = 0
        val sink = FloatArray(2048)
        while (remaining > 0 && !inputDone && attempts < attemptBudget) {
            attempts += 1
            val chunk = minOf(remaining, 2048L).toInt()
            val got = read(sink, chunk, channels, attemptBudget = DISCARDS_PER_READ_BUDGET)
            if (got <= 0) break
            remaining -= got
        }
    }

    /**
     * 解出 [frames] 帧交织 16bit → 浮点，写进 [out]；返回实际帧数（文件末尾会少）。
     *
     * @param attemptBudget 这一块最多走几轮 dequeue。到上限就带着已经解出来的帧返回，
     *        调用方把缺的那几帧当静音 —— 绝不能在这里死等。
     */
    fun read(out: FloatArray, frames: Int, outChannels: Int, attemptBudget: Int): Int {
        if (frames <= 0 || channels <= 0) return 0
        val wantedBytes = frames * channels * 2
        var attempts = 0
        while (pendingSize < wantedBytes && !inputDone && attempts < attemptBudget) {
            attempts += 1
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
        val index = codec.dequeueInputBuffer(TIMEOUT_US)
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
            val index = codec.dequeueOutputBuffer(info, TIMEOUT_US)
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

    private companion object {
        /** 单次 dequeue 的超时：10ms 是 media3 自己同步解码时的量级。 */
        const val TIMEOUT_US = 10_000L

        /** 追赶时每一次 [read] 内部的轮数：很小，因为真正的上限在外层 [discard]。 */
        const val DISCARDS_PER_READ_BUDGET = 2
    }
}
