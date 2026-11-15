package top.izuna.foliamajor.player.dsp

import android.content.Context
import android.media.AudioFormat
import android.os.BatteryManager
import android.os.PowerManager
import android.os.Process
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DecoderReuseEvaluation
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.audio.AudioSink

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/AudioPipelineTelemetry.kt
//
// 原生音频链路的「标尺」。
//
// 为什么需要这一层：这条链上「音质变差」有三个完全不同的位置，肉眼听感却很像——
//
//   ① 解码器交出来的 PCM 就已经是 16bit（高解析度源在这一步丢了精度）；
//   ② 进 AudioTrack 的格式被重采样 / 降位（toInt16 转换、设备只支持 48kHz 等）；
//   ③ 效果器把整条 processor 链摘掉了（非 16bit 输入时 EqAudioProcessor 返回 NOT_SET，
//      于是「有些歌没有 EQ」而且没有任何报错）。
//
// 没有计数就只能靠听，听不出来就改不动。这里把三段的**实际格式**和欠载次数记下来，
// 由开发者选项的 Perf 页直接读 —— 数字对不上，就说明那一段有问题。
//
// 只记录形态，不记录音频地址、账号或任何凭据。
//
// 线程：写入全部发生在 playerLooper（音频渲染线程 / 播放器线程）与主线程，字段一律
// `@Volatile`。这里不用锁——音频线程上一把锁的代价比读错一个统计值大得多，而这些值
// 只服务于诊断，允许读到「上一拍」。

@UnstableApi
object AudioPipelineTelemetry {

    /** 耗时采样窗口：256 个块 × 128 帧 ≈ 0.74 秒（44.1kHz），够看出长尾又不占内存。 */
    private const val DSP_COST_SAMPLES = 256

    /** 平台 AudioFormat.ENCODING_DEFAULT：编码未指定。media3 的 C 里没有对应常量。 */
    private const val ENCODING_DEFAULT = 1

    /**
     * 解码器输出的 PCM 格式，也就是**进 DSP 之前**的格式。
     *
     * 这是判「无损源有没有被降位」的唯一可靠位置：`onAudioInputFormatChanged` 拿到的
     * Format 是解码器的输出，不是容器里写的那个（FLAC 24bit 的容器信息仍是 24bit，
     * 但解码器可能已经交 16bit 出来了）。
     */
    @Volatile
    private var inputSampleRate = 0

    @Volatile
    private var inputChannels = 0

    @Volatile
    private var inputPcmEncoding = C.ENCODING_INVALID

    @Volatile
    private var inputMime: String? = null

    @Volatile
    private var inputBitrate = 0

    @Volatile
    private var inputCodecs: String? = null

    /**
     * AudioTrack 的**实际**配置，也就是真正交给声卡的格式。
     *
     * `onAudioTrackInitialized` 给的是 AudioSink 建出来的那条 track 的参数，不是请求值。
     * 设备不支持 96kHz 时这里会看到 48kHz —— 那说明重采样已经发生了。
     */
    @Volatile
    private var trackSampleRate = 0

    @Volatile
    private var trackEncoding = C.ENCODING_INVALID

    @Volatile
    private var trackChannelCount = 0

    @Volatile
    private var trackBufferBytes = 0

    @Volatile
    private var trackTunneling = false

    @Volatile
    private var trackOffload = false

    /** AudioTrack 喂不上数据（CPU 忙 / 缓冲区太小）的次数。这是「爆音、卡顿」的直接证据。 */
    @Volatile
    private var underrunCount = 0L

    @Volatile
    private var underrunBytes = 0L

    @Volatile
    private var sinkErrorCount = 0L

    @Volatile
    private var lastSinkError: String? = null

    /** 处理器链当前是否真的挂在管线上。false = 这次播放没有 EQ。 */
    @Volatile
    private var dspActive = false

    /** 经过处理器的帧数（不含被摘链的时间段）。 */
    @Volatile
    private var dspFrames = 0L

    /** 效果关 / 全平时的直通帧数：这部分没有做任何运算，但确实走了同一条链。 */
    @Volatile
    private var dspPassthroughFrames = 0L

    /** `onConfigure` 因为编码不是 16bit 而主动摘链的次数。>0 就是「有些歌没有 EQ」的答案。 */
    @Volatile
    private var dspBypassCount = 0

    /** 位置轮询（250ms 一拍）累计跑了多少拍。用来估「息屏时还在空转多少」。 */
    @Volatile
    private var positionTicks = 0L

    @Volatile
    private var playerCount = 0

    /**
     * 最近 [DSP_COST_SAMPLES] 个块的**处理器耗时**（纳秒）。
     *
     * 为什么记这个：整机 CPU 占用（下面的 cpuMs）分不清「音频处理重」还是「WebView 在烧」，
     * 而这两个的解法完全相反 —— 前者要减处理器，后者要去掉后台动画。把 DSP 这一段的
     * 耗时单独量出来，再和「一个块本来该占多长时间」比，就是这条链的实时负载。
     */
    private val dspCostNs = LongArray(DSP_COST_SAMPLES)

    /** 与 [dspCostNs] 同下标的负载（千分之一，1000 = 一个块的时间全花在 DSP 上）。 */
    private val dspLoadPermille = IntArray(DSP_COST_SAMPLES)

    @Volatile
    private var dspCostCursor = 0

    @Volatile
    private var dspCostFilled = 0

    /** 累计处理块数（诊断用：除以秒数就是实际块率）。 */
    @Volatile
    private var dspBlockCount = 0L

    // ---- 写入端（全部在音频 / 播放器线程） ----

    fun notePlayerCreated() {
        playerCount += 1
    }

    fun notePlayerReleased() {
        if (playerCount > 0) playerCount -= 1
    }

    /**
     * 记一个块的处理器耗时。
     *
     * `frames` 是这个块包含的帧数，`sampleRate` 是当前采样率 —— 两者一起决定「这个块
     * 本来要播多久」。负载 = 耗时 / 块时长：超过 1000‰ 就意味着处理器跑不过实时。
     */
    fun noteDspCost(costNs: Long, frames: Int, sampleRate: Int) {
        if (costNs <= 0 || frames <= 0 || sampleRate <= 0) return
        val blockNs = frames.toLong() * 1_000_000_000L / sampleRate
        if (blockNs <= 0) return
        val index = dspCostCursor
        dspCostNs[index] = costNs
        dspLoadPermille[index] = ((costNs * 1000L) / blockNs).toInt()
        dspCostCursor = (index + 1) % DSP_COST_SAMPLES
        if (dspCostFilled < DSP_COST_SAMPLES) dspCostFilled += 1
        dspBlockCount += 1
    }

    fun noteDspConfigured(active: Boolean) {
        dspActive = active
    }

    fun noteDspBypassed() {
        dspBypassCount += 1
    }

    fun noteDspFrames(frames: Int) {
        if (frames > 0) dspFrames += frames.toLong()
    }

    fun noteDspPassthroughFrames(frames: Int) {
        if (frames > 0) dspPassthroughFrames += frames.toLong()
    }

    fun notePositionTick() {
        positionTicks += 1
    }

    // ---- 读取端（开发者面板，主线程） ----

    val listener: AnalyticsListener = object : AnalyticsListener {

        override fun onAudioInputFormatChanged(
            eventTime: AnalyticsListener.EventTime,
            format: Format,
            decoderReuseEvaluation: DecoderReuseEvaluation?,
        ) {
            inputSampleRate = format.sampleRate
            inputChannels = format.channelCount
            inputPcmEncoding = format.pcmEncoding
            inputMime = format.sampleMimeType
            inputBitrate = format.bitrate
            inputCodecs = format.codecs
        }

        override fun onAudioTrackInitialized(
            eventTime: AnalyticsListener.EventTime,
            audioTrackConfig: AudioSink.AudioTrackConfig,
        ) {
            trackSampleRate = audioTrackConfig.sampleRate
            trackEncoding = audioTrackConfig.encoding
            trackChannelCount = channelCountOf(audioTrackConfig.channelConfig)
            trackBufferBytes = audioTrackConfig.bufferSize
            trackTunneling = audioTrackConfig.tunneling
            trackOffload = audioTrackConfig.offload
        }

        override fun onAudioUnderrun(
            eventTime: AnalyticsListener.EventTime,
            bufferSize: Int,
            bufferSizeMs: Long,
            elapsedSinceLastFeedMs: Long,
        ) {
            underrunCount += 1
            underrunBytes += bufferSize.toLong()
        }

        override fun onAudioSinkError(
            eventTime: AnalyticsListener.EventTime,
            audioSinkError: Exception,
        ) {
            sinkErrorCount += 1
            lastSinkError = audioSinkError.message ?: audioSinkError.javaClass.simpleName
        }
    }

    /**
     * 一次快照。
     *
     * `verdict` 是给人看的一句话结论：把「源 → 解码 → 声卡」三段的位深/采样率摆在一起，
     * 降位发生在哪一段就不用再猜了。
     */
    fun snapshot(context: Context): Snapshot {
        val inputDepth = depthOf(inputPcmEncoding)
        val trackDepth = depthOf(trackEncoding)
        val resampled = inputSampleRate > 0 && trackSampleRate > 0 && inputSampleRate != trackSampleRate
        val downBit = inputDepth > 0 && trackDepth > 0 && trackDepth < inputDepth
        val trackBufferMs = bufferMs(trackBufferBytes, trackSampleRate, trackChannelCount, trackEncoding)
        val cost = dspCostSummary()

        val verdict = buildString {
            if (inputSampleRate == 0 && trackSampleRate == 0) {
                append("还没有播放过（没有解码器/声卡格式）。")
            } else {
                append("解码 ${describe(inputSampleRate, inputDepth)} → 声卡 ${describe(trackSampleRate, trackDepth)}")
                if (downBit) append(" · 位深下降")
                if (resampled) append(" · 重采样")
                if (trackOffload) append(" · offload 开启（processor 会被绕过）")
                if (trackTunneling) append(" · tunneling 开启")
            }
            if (dspBypassCount > 0) {
                append(" · EQ 摘链 ${dspBypassCount} 次（输入不是 16bit）")
            }
            if (underrunCount > 0) {
                append(" · 欠载 ${underrunCount} 次")
            }
        }

        return Snapshot(
            players = playerCount,
            inputSampleRate = inputSampleRate,
            inputChannels = inputChannels,
            inputPcm = pcmLabel(inputPcmEncoding),
            inputMime = inputMime ?: "",
            inputBitrateKbps = if (inputBitrate > 0) inputBitrate / 1000 else 0,
            inputCodecs = inputCodecs ?: "",
            trackSampleRate = trackSampleRate,
            trackChannels = trackChannelCount,
            trackPcm = pcmLabel(trackEncoding),
            trackBufferMs = trackBufferMs,
            trackTunneling = trackTunneling,
            trackOffload = trackOffload,
            underrunCount = underrunCount,
            underrunBytes = underrunBytes,
            sinkErrorCount = sinkErrorCount,
            lastSinkError = lastSinkError ?: "",
            dspActive = dspActive,
            dspFrames = dspFrames,
            dspPassthroughFrames = dspPassthroughFrames,
            dspBypassCount = dspBypassCount,
            dspBlockCount = dspBlockCount,
            dspCostP50Us = cost.p50Us,
            dspCostP99Us = cost.p99Us,
            dspLoadPercent = cost.loadPercent,
            positionTicks = positionTicks,
            cpuMs = Process.getElapsedCpuTime(),
            cpuCores = Runtime.getRuntime().availableProcessors(),
            batteryPercent = batteryPercent(context),
            batteryCurrentMa = batteryCurrentMa(context),
            interactive = isInteractive(context),
            verdict = verdict,
        )
    }

    /** 换源时不清零：欠载与摘链次数是「这次会话」的累计，清掉就看不出问题了。 */
    data class Snapshot(
        val players: Int,
        val inputSampleRate: Int,
        val inputChannels: Int,
        val inputPcm: String,
        val inputMime: String,
        val inputBitrateKbps: Int,
        val inputCodecs: String,
        val trackSampleRate: Int,
        val trackChannels: Int,
        val trackPcm: String,
        val trackBufferMs: Double,
        val trackTunneling: Boolean,
        val trackOffload: Boolean,
        val underrunCount: Long,
        val underrunBytes: Long,
        val sinkErrorCount: Long,
        val lastSinkError: String,
        val dspActive: Boolean,
        val dspFrames: Long,
        val dspPassthroughFrames: Long,
        val dspBypassCount: Int,
        val dspBlockCount: Long,
        /** 每个块的处理耗时（微秒），近 [DSP_COST_SAMPLES] 块的中位数。 */
        val dspCostP50Us: Double,
        /** 同上，99 分位：这一项高说明偶发卡顿来自长尾，而不是整体太慢。 */
        val dspCostP99Us: Double,
        /** 处理器占用单核的比例（%）。到 100 就是「刚好跑得及」，再高必然欠载。 */
        val dspLoadPercent: Double,
        val positionTicks: Long,
        val cpuMs: Long,
        val cpuCores: Int,
        val batteryPercent: Int,
        val batteryCurrentMa: Int,
        val interactive: Boolean,
        val verdict: String,
    )

    // ---- 小工具 ----

    private class CostSummary(val p50Us: Double, val p99Us: Double, val loadPercent: Double)

    /**
     * 把环形缓冲里的耗时采样整理成三个数。
     *
     * 读的时候音频线程可能正在写同一个槽：这里先拷一份再排序，读到半个旧值最多让分位数
     * 差一点点 —— 诊断读数不值得为它上一把锁（那会直接卡住音频线程）。
     */
    private fun dspCostSummary(): CostSummary {
        val count = dspCostFilled
        if (count <= 0) return CostSummary(0.0, 0.0, 0.0)
        val costs = LongArray(count)
        var loadSum = 0L
        for (index in 0 until count) {
            costs[index] = dspCostNs[index]
            loadSum += dspLoadPermille[index]
        }
        costs.sort()
        val p50 = costs[(count * 50 / 100).coerceAtMost(count - 1)] / 1_000.0
        val p99Index = ((count * 99 + 99) / 100 - 1).coerceIn(0, count - 1)
        val p99 = costs[p99Index] / 1_000.0
        return CostSummary(p50, p99, loadSum.toDouble() / count / 10.0)
    }

    private fun describe(sampleRate: Int, depth: Int): String {
        val rate = if (sampleRate > 0) "${sampleRate}Hz" else "?"
        val bits = if (depth > 0) "${depth}bit" else "?"
        return "$rate/$bits"
    }

    private fun depthOf(encoding: Int): Int = when (encoding) {
        C.ENCODING_PCM_8BIT -> 8
        C.ENCODING_PCM_16BIT, C.ENCODING_PCM_16BIT_BIG_ENDIAN -> 16
        C.ENCODING_PCM_24BIT, C.ENCODING_PCM_24BIT_BIG_ENDIAN -> 24
        C.ENCODING_PCM_32BIT, C.ENCODING_PCM_32BIT_BIG_ENDIAN, C.ENCODING_PCM_FLOAT,
        C.ENCODING_PCM_FLOAT_BIG_ENDIAN -> 32
        else -> 0
    }

    private fun pcmLabel(encoding: Int): String = when (encoding) {
        // media3 的 C 里没有公开这个常量（平台侧 AudioFormat.ENCODING_DEFAULT = 1，
        // 表示「编码未指定」）。Format 里没写 pcmEncoding 时就是它。
        ENCODING_DEFAULT -> "auto"
        C.ENCODING_PCM_8BIT -> "8-bit"
        C.ENCODING_PCM_16BIT -> "16-bit"
        C.ENCODING_PCM_24BIT -> "24-bit"
        C.ENCODING_PCM_32BIT -> "32-bit"
        C.ENCODING_PCM_FLOAT -> "32-bit float"
        C.ENCODING_INVALID -> "unknown"
        else -> "enc$encoding"
    }

    private fun channelCountOf(channelConfig: Int): Int = when (channelConfig) {
        AudioFormat.CHANNEL_OUT_MONO -> 1
        AudioFormat.CHANNEL_OUT_STEREO -> 2
        AudioFormat.CHANNEL_OUT_QUAD -> 4
        AudioFormat.CHANNEL_OUT_5POINT1 -> 6
        AudioFormat.CHANNEL_OUT_7POINT1_SURROUND -> 8
        else -> 0
    }

    private fun bufferMs(bytes: Int, sampleRate: Int, channels: Int, encoding: Int): Double {
        if (bytes <= 0 || sampleRate <= 0 || channels <= 0) return 0.0
        val bytesPerSample = when (depthOf(encoding)) {
            8 -> 1
            16 -> 2
            24 -> 3
            32 -> 4
            else -> 2
        }
        val bytesPerFrame = bytesPerSample * channels
        if (bytesPerFrame <= 0) return 0.0
        return bytes.toDouble() / bytesPerFrame / sampleRate * 1000.0
    }

    private fun batteryPercent(context: Context): Int {
        val manager = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager ?: return -1
        return manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    }

    /**
     * 当前电流（mA，放电为负）。
     *
     * 各厂商的 `BATTERY_PROPERTY_CURRENT_NOW` 单位并不统一（多数是 µA，个别直接给 mA），
     * 所以这里只做一个数量级归一，绝对值不当真 —— 它的用途是「同一台机器上改前改后对比」。
     */
    private fun batteryCurrentMa(context: Context): Int {
        val manager = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager ?: return 0
        val raw = manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW)
        if (raw == 0 || raw == Int.MIN_VALUE) return 0
        val abs = kotlin.math.abs(raw)
        val ma = if (abs > 20_000) raw / 1000 else raw
        return ma
    }

    private fun isInteractive(context: Context): Boolean {
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return true
        return power.isInteractive
    }
}
