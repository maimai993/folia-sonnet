package top.izuna.foliamajor.player.transition

import org.json.JSONObject

// android/app/src/main/java/top/izuna/foliamajor/player/transition/TrackProfile.kt
// 证据层输出：一首歌被测量出来的客观事实。
//
// 与 Web 侧 automix/trackProfile.ts 的字段一一对应，但全部由原生 PCM 解码 + 算术得到，
// 不依赖 OfflineAudioContext、不加载 Beat This! / htdemucs 权重。
// 这一条是包体控制的关键：整套分析是 Kotlin，dex 增量不到 1 MB。

enum class KeyRelation(val wire: String) {
    COMPATIBLE("compatible"),
    ADJACENT("adjacent"),
    NEUTRAL("neutral"),
    CLASHING("clashing"),
    UNKNOWN("unknown"),
}

enum class EndingShape(val wire: String) {
    /** 自然收束 / 衰减尾巴。 */
    RESOLVE("resolve"),
    /** 硬断开（尾音被剪掉）。 */
    CUT("cut"),
    /** 满电平到底，没有尾巴。 */
    FULL_LEVEL("fullLevel"),
    UNKNOWN("unknown"),
}

/** 分析档位：DSP 是内置算术，ENHANCED 是可选的按需下载增强包就绪后重算的结果。 */
enum class AnalysisTier(val wire: String) {
    NONE("none"), DSP("dsp"), ENHANCED("enhanced"),
}

data class BeatGrid(
    val bpm: Float,
    val phaseMs: Long,
    val beatsPerBar: Int = MusicalTime.DEFAULT_BEATS_PER_BAR,
    val confidence: Float = 0f,
) {
    val valid: Boolean get() = bpm in 40f..240f && confidence >= 0.35f
}

data class BandBalance(val low: Float, val mid: Float, val high: Float) {
    companion object {
        val FLAT = BandBalance(1f / 3f, 1f / 3f, 1f / 3f)
    }
}

/**
 * 一首歌的档案。字段允许为 null / UNKNOWN —— 那正是「有没有证据」这个判断的输入，
 * 规划层会据此降级，而不是假装测出来了。
 */
data class TrackProfile(
    val key: String,
    val durationMs: Long,
    val sampleRate: Int,
    val bpm: Float? = null,
    val beatGrid: BeatGrid? = null,
    val loudnessLufs: Float? = null,
    val headDb: Float = -60f,
    val tailDb: Float = -60f,
    val silenceHeadMs: Long = 0L,
    val silenceTailMs: Long = 0L,
    val introEndMs: Long = 0L,
    val keyHead: Int = -1,
    val keyTail: Int = -1,
    val bandHead: BandBalance = BandBalance.FLAT,
    val bandTail: BandBalance = BandBalance.FLAT,
    val endingShape: EndingShape = EndingShape.UNKNOWN,
    val startsHot: Boolean = false,
    val hasVocalTail: Boolean = false,
    val tier: AnalysisTier = AnalysisTier.DSP,
    val analysedAtMs: Long = 0L,
) {
    val hasBeatGrid: Boolean get() = beatGrid?.valid == true
    /**
     * 「有档案」本身就是证据，对齐 Web 侧 hasEvidence 里 `from.profile || to.profile` 那条：
     * 分析成功过就说明首尾窗口是可测的，哪怕某个具体字段（调性 / 拍点）没测出来。
     * 只在 tier = NONE（没分析过 / 分析失败）时才判无证据。
     */
    val hasEvidence: Boolean get() = tier != AnalysisTier.NONE

    fun toJson(): JSONObject = JSONObject().apply {
        put("key", key)
        put("durationMs", durationMs)
        put("sampleRate", sampleRate)
        if (bpm != null) put("bpm", bpm.toDouble())
        beatGrid?.let {
            put("beatGrid", JSONObject().apply {
                put("bpm", it.bpm.toDouble())
                put("phaseMs", it.phaseMs)
                put("beatsPerBar", it.beatsPerBar)
                put("confidence", it.confidence.toDouble())
            })
        }
        if (loudnessLufs != null) put("loudnessLufs", loudnessLufs.toDouble())
        put("headDb", headDb.toDouble())
        put("tailDb", tailDb.toDouble())
        put("silenceHeadMs", silenceHeadMs)
        put("silenceTailMs", silenceTailMs)
        put("introEndMs", introEndMs)
        put("keyHead", keyHead)
        put("keyTail", keyTail)
        put("bandHead", JSONObject().apply {
            put("low", bandHead.low.toDouble()); put("mid", bandHead.mid.toDouble()); put("high", bandHead.high.toDouble())
        })
        put("bandTail", JSONObject().apply {
            put("low", bandTail.low.toDouble()); put("mid", bandTail.mid.toDouble()); put("high", bandTail.high.toDouble())
        })
        put("endingShape", endingShape.wire)
        put("startsHot", startsHot)
        put("hasVocalTail", hasVocalTail)
        put("tier", tier.wire)
        put("analysedAtMs", analysedAtMs)
    }

    companion object {
        fun empty(key: String, durationMs: Long = 0L): TrackProfile = TrackProfile(
            key = key, durationMs = durationMs, sampleRate = 0, tier = AnalysisTier.NONE,
        )

        fun fromJson(o: JSONObject): TrackProfile {
            val grid = o.optJSONObject("beatGrid")?.let {
                BeatGrid(
                    it.optDouble("bpm", 0.0).toFloat(),
                    it.optLong("phaseMs", 0L),
                    it.optInt("beatsPerBar", 4),
                    it.optDouble("confidence", 0.0).toFloat(),
                )
            }
            fun band(name: String): BandBalance = o.optJSONObject(name)?.let {
                BandBalance(
                    it.optDouble("low", 1.0 / 3).toFloat(),
                    it.optDouble("mid", 1.0 / 3).toFloat(),
                    it.optDouble("high", 1.0 / 3).toFloat(),
                )
            } ?: BandBalance.FLAT
            return TrackProfile(
                key = o.optString("key", ""),
                durationMs = o.optLong("durationMs", 0L),
                sampleRate = o.optInt("sampleRate", 0),
                bpm = if (o.has("bpm")) o.optDouble("bpm", 0.0).toFloat() else null,
                beatGrid = grid,
                loudnessLufs = if (o.has("loudnessLufs")) o.optDouble("loudnessLufs", 0.0).toFloat() else null,
                headDb = o.optDouble("headDb", -60.0).toFloat(),
                tailDb = o.optDouble("tailDb", -60.0).toFloat(),
                silenceHeadMs = o.optLong("silenceHeadMs", 0L),
                silenceTailMs = o.optLong("silenceTailMs", 0L),
                introEndMs = o.optLong("introEndMs", 0L),
                keyHead = o.optInt("keyHead", -1),
                keyTail = o.optInt("keyTail", -1),
                bandHead = band("bandHead"),
                bandTail = band("bandTail"),
                endingShape = EndingShape.values().firstOrNull { it.wire == o.optString("endingShape") }
                    ?: EndingShape.UNKNOWN,
                startsHot = o.optBoolean("startsHot", false),
                hasVocalTail = o.optBoolean("hasVocalTail", false),
                tier = AnalysisTier.values().firstOrNull { it.wire == o.optString("tier") }
                    ?: AnalysisTier.DSP,
                analysedAtMs = o.optLong("analysedAtMs", 0L),
            )
        }
    }
}

/** 首尾调性关系：五度圈相邻 / 同调 / 中性 / 冲突。 */
object KeyRelations {
    fun between(fromTail: Int, toHead: Int): KeyRelation {
        if (fromTail < 0 || toHead < 0) return KeyRelation.UNKNOWN
        val d = ((toHead - fromTail) % 12 + 12) % 12
        return when (d) {
            0 -> KeyRelation.COMPATIBLE
            5, 7, 2, 10 -> KeyRelation.ADJACENT
            1, 11, 6 -> KeyRelation.CLASHING
            else -> KeyRelation.NEUTRAL
        }
    }

    /** 进场曲的中 / 高频修正，使其以出场曲的音色到达（单位 dB）。 */
    fun tiltDb(relation: KeyRelation, from: BandBalance, to: BandBalance): Float {
        val tonalDelta = (from.high - to.high) * 6f
        val relationTrim = when (relation) {
            KeyRelation.CLASHING -> -1.5f
            KeyRelation.ADJACENT -> 0.5f
            else -> 0f
        }
        return (tonalDelta + relationTrim).coerceIn(-6f, 6f)
    }
}
