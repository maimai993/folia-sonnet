package top.izuna.foliamajor.player.transition.analysis

import kotlin.math.abs
import kotlin.math.max
import top.izuna.foliamajor.player.transition.AnalysisTier
import top.izuna.foliamajor.player.transition.BandBalance
import top.izuna.foliamajor.player.transition.BeatGrid
import top.izuna.foliamajor.player.transition.EndingShape
import top.izuna.foliamajor.player.transition.TrackProfile

// android/app/src/main/java/top/izuna/foliamajor/player/transition/analysis/TrackAnalyser.kt
// 把首尾两段 PCM 汇总成 TrackProfile。纯 Kotlin 算术，零模型权重。
//
// 与 Web 侧的差别（也是「强力」的来源）：WebView 里没有本地解码与神经网络推理时，
// 拍点 / 分离 / 表现模式全部降级关闭；原生侧这份分析永远可用，且跑在后台线程上，
// 不占 WebView 主线程，结果还会落盘缓存 —— 同一首歌第二次过渡不再重算。

class TrackAnalyser(private val extractor: PcmWindowExtractor) {

    companion object {
        private const val WINDOW_MS = 20_000L
        private const val HEAD_DB_WINDOW_MS = 2_000
        private const val HOT_START_DB = -14f
        private const val TAIL_DECAY_DB = -10f
    }

    fun analyse(
        key: String,
        url: String,
        durationMs: Long,
        headers: Map<String, String>? = null,
        enhancer: EnhancerPack? = null,
    ): TrackProfile? {
        val head = extractor.extract(url, 0L, WINDOW_MS, headers) ?: return null
        val tailStart = max(0L, durationMs - WINDOW_MS)
        val tail = if (durationMs > WINDOW_MS + 2_000L) {
            extractor.extract(url, tailStart, WINDOW_MS, headers)
        } else null
        val tailSamples = tail?.samples ?: head.samples
        val rate = head.sampleRate

        val headEnd = minOf(head.samples.size, (HEAD_DB_WINDOW_MS * rate) / 1_000)
        val tailBegin = maxOf(0, tailSamples.size - (HEAD_DB_WINDOW_MS * rate) / 1_000)

        val headDb = SignalMath.rmsDb(head.samples, 0, headEnd)
        val tailDb = SignalMath.rmsDb(tailSamples, tailBegin, tailSamples.size)
        val (silenceHead, silenceTail) = SignalMath.silenceEdges(head.samples, rate)
        val tailEdges = if (tail != null) SignalMath.silenceEdges(tail.samples, rate) else Pair(silenceHead, silenceTail)

        val bandHead = SignalMath.bandBalance(head.samples, rate, 0, head.samples.size)
        val bandTail = SignalMath.bandBalance(tailSamples, rate, 0, tailSamples.size)
        val keyHead = SignalMath.dominantChroma(head.samples, rate, 0, head.samples.size)
        val keyTail = SignalMath.dominantChroma(tailSamples, rate, 0, tailSamples.size)

        // 拍点：把首尾两段的 onset 包络拼起来做自相关。够长才有意义。
        val envHead = SignalMath.onsetEnvelope(head.samples)
        val envTail = if (tail != null) SignalMath.onsetEnvelope(tail.samples) else FloatArray(0)
        val envelope = FloatArray(envHead.size + envTail.size).also {
            System.arraycopy(envHead, 0, it, 0, envHead.size)
            System.arraycopy(envTail, 0, it, envHead.size, envTail.size)
        }
        val tempo = SignalMath.estimateTempo(envelope, rate, 256)
        val grid = tempo?.let { (bpm, confidence) ->
            BeatGrid(bpm = bpm, phaseMs = silenceHead, confidence = confidence)
        }

        val endingShape = when {
            tailDb <= SignalMath.SILENCE_DB + 2f || tailEdges.second > 3_000L -> EndingShape.RESOLVE
            tailDb - headDb > TAIL_DECAY_DB * -1 && abs(tailDb - headDb) < 4f -> EndingShape.FULL_LEVEL
            tailDb < headDb + TAIL_DECAY_DB -> EndingShape.RESOLVE
            else -> EndingShape.CUT
        }

        val base = TrackProfile(
            key = key,
            durationMs = durationMs,
            sampleRate = rate,
            bpm = tempo?.first,
            beatGrid = grid,
            loudnessLufs = SignalMath.loudnessLufs(head.samples, rate),
            headDb = headDb,
            tailDb = tailDb,
            silenceHeadMs = silenceHead,
            silenceTailMs = tailEdges.second,
            introEndMs = if (grid?.valid == true) {
                silenceHead + (240_000f / grid.bpm).toLong() // 4 拍前奏
            } else silenceHead + 8_000L,
            keyHead = keyHead,
            keyTail = keyTail,
            bandHead = bandHead,
            bandTail = bandTail,
            endingShape = endingShape,
            startsHot = headDb > HOT_START_DB && silenceHead < 300L,
            hasVocalTail = false,
            tier = AnalysisTier.DSP,
            analysedAtMs = System.currentTimeMillis(),
        )

        // 可选增强包：只在已安装且大小合规时接管，用于补 hasVocalTail / 更准的拍点。
        return enhancer?.enhance(base)?.copy(tier = AnalysisTier.ENHANCED) ?: base
    }
}
