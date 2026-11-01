package top.izuna.foliamajor.player.dsp

import org.json.JSONArray
import org.json.JSONObject

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/EqSettings.kt
// 原生播放内核的听感设置快照：Web 推来的那份 JSON 在这里被校验、夹紧、定型。
//
// 为什么要有这一层：Web 的 localStorage 只有 WebView 活着时才算数，而原生播放器
// 在界面冻结、甚至 WebView 已经销毁之后仍然要出声（通知栏 / 锁屏 / 冷启动）。
// 所以设置必须有一份能给播放器线程直接读的、不可变的副本。
//
// 协议 v2（本文件）在 v1 的三项（十段增益 / punch / space）之外，加进了调音台的另外四块：
//   · 前置均衡器的曲线形状（GEQ 定 Q / PEQ 可变 Q）与总增益；
//   · 四段压缩器（Low / Mid / High / Air，每段自己的阈值、比率、启动、释放，
//     外加软拐点宽度与平行压缩混合比）；
//   · 后置均衡器（同一套十段，挂在压缩之后）；
//   · 混响的物理参数（预设 / RT60 / 声压级 / 阻尼 / 预延迟 / 干湿比 / 暂停后余音）；
//   · 声场宽度（M/S 加权，挂在混响之前）。
//
// `kneeDb` / `mix` / `damping` / `preDelayMs` / `stereo` 都是**可缺省的扩展字段**：
// 老包不带它们时按「不改变原来听感」的值兜底，所以版本号仍是 2。
// v1 的字段一个没删、一个没改名：老版本 WebView 推上来的包仍然照 v1 解析，
// 新字段缺席时按「中性」填 —— 冷启动读到的旧设置不会因为升级而变成怪声。

/** 段数：与 Web 的 `AUDIO_EQUALIZER_BANDS` 一一对应（src/utils/audioEqualizer.ts）。 */
const val EQ_BAND_COUNT = 10

/** 中心频率，单位 Hz。首段 lowshelf、末段 highshelf、中间 peaking（同 audioEqualizerBandShape）。 */
val EQ_BAND_FREQUENCIES = floatArrayOf(31f, 62f, 125f, 250f, 500f, 1000f, 2000f, 4000f, 8000f, 16000f)

/** Web 侧 `AUDIO_EQUALIZER_MIN_GAIN_DB` / `MAX_GAIN_DB`。 */
const val EQ_MIN_GAIN_DB = -12f
const val EQ_MAX_GAIN_DB = 12f

/** Web 侧 `connectAudioEqualizerGraph` 里 `filter.Q.value = 1.4`：GEQ 的固定 Q。 */
const val EQ_BAND_Q = 1.4f

/** PEQ 的 Q 范围：0.3 是一整个倍频程以上，8 已经窄到只动一个音。 */
const val EQ_MIN_Q = 0.3f
const val EQ_MAX_Q = 8f

/** 协议版本。Web 侧推上来的 `version` 与这里不一致时只取兼容子集。 */
const val EQ_PROTOCOL_VERSION = 2

/** 前置/后置均衡器的曲线形状。整数而不是枚举：JSON 里省字节，且老包缺席时默认 GEQ。 */
object EqCurveMode {
    const val GEQ = 0
    const val PEQ = 1
}

/** 混响的声学预设。切换预设只改「空间的形状」，RT60 仍由滑杆决定。 */
object ReverbPreset {
    /** 出厂：不额外加长，尾巴最短，最接近 Web 的 space。 */
    const val FACTORY = 0
    /** 音乐厅：中等容积，早期反射清楚。 */
    const val HALL = 1
    /** 空灵大教堂：长预延迟、长尾巴、低频驻留。 */
    const val CATHEDRAL = 2
    /** 板式：没有预延迟，密度高，尾巴亮。 */
    const val PLATE = 3

    fun clamp(value: Int): Int = value.coerceIn(FACTORY, PLATE)

    /**
     * 预设自带的高频阻尼。
     *
     * 只用作两个地方的默认值：Web 推来的包缺 `damping` 字段时，以及旧存档回读时。
     * 正常情况下阻尼由用户滑杆决定，预设不再是它的主人 —— 换预设只把这两个值
     * 写进设置当作起点，之后各调各的。
     */
    fun defaultDamping(preset: Int): Float = when (clamp(preset)) {
        FACTORY -> 0.2f
        HALL -> 0.28f
        CATHEDRAL -> 0.34f
        else -> 0.1f
    }

    /** 预设自带的预延迟（毫秒），用途同上。 */
    fun defaultPreDelayMs(preset: Int): Float = when (clamp(preset)) {
        HALL -> 18f
        CATHEDRAL -> 42f
        else -> 0f
    }
}

/** 压缩器的整体性格：温和（慢启动、带补偿增益）与平直（快、不做补偿）。 */
object CompressorProfile {
    const val GENTLE = 0
    const val FLAT = 1
}

/**
 * 一段压缩的参数。
 *
 * 四段的名字沿用 Web 界面上的 Low / Mid / High / Air，分频点也一致
 * （250 / 2000 / 8000 Hz），见 [MultibandCompressor]。
 */
class CompressorBand(
    val enabled: Boolean = true,
    val thresholdDb: Float = -16f,
    val ratio: Float = 1.5f,
    val attackMs: Float = 5f,
    val releaseMs: Float = 60f,
    val makeupDb: Float = 0f,
    /** 软拐点宽度（dB）：2 进得干脆，18 听不出接缝。 */
    val kneeDb: Float = 6f,
    /** 平行压缩：1 全压；小于 1 时把压过的信号按比例混回干声。 */
    val mix: Float = 1f,
)

/** 四段压缩器的一份完整参数。 */
class CompressorSettings(
    val enabled: Boolean = false,
    /** 2 或 4：2 段只分 Low / High，分频点 250 Hz。 */
    val bandCount: Int = 4,
    val profile: Int = CompressorProfile.GENTLE,
    val bands: Array<CompressorBand> = Array(COMPRESSOR_BAND_COUNT) { CompressorBand() },
) {
    companion object {
        const val COMPRESSOR_BAND_COUNT = 4
        val NEUTRAL = CompressorSettings()

        fun bandDefaults(index: Int): CompressorBand = when (index) {
            0 -> CompressorBand(thresholdDb = -16f, ratio = 1.5f, attackMs = 5f, releaseMs = 60f)
            1 -> CompressorBand(thresholdDb = -18f, ratio = 1.6f, attackMs = 8f, releaseMs = 80f)
            2 -> CompressorBand(thresholdDb = -20f, ratio = 1.8f, attackMs = 3f, releaseMs = 50f)
            else -> CompressorBand(thresholdDb = -22f, ratio = 2f, attackMs = 2f, releaseMs = 40f)
        }
    }
}

/** 混响的一份完整参数。 */
class ReverbSettings(
    val enabled: Boolean = false,
    val preset: Int = ReverbPreset.FACTORY,
    /** RT60：尾巴从直达声衰减 60 dB 所需的时间，0.3 ~ 10 秒。 */
    val rt60Seconds: Float = 2.2f,
    /** 湿声相对干声的电平，-24 ~ +6 dB。0 表示与直达声同响。 */
    val roomLevelDb: Float = -2f,
    /** 高频阻尼 0.02 ~ 0.9：越大尾巴越暗。 */
    val damping: Float = 0.2f,
    /** 预延迟 0 ~ 120 ms。 */
    val preDelayMs: Float = 0f,
    /** 干湿比 0 ~ 1（等功率）：0 全干，1 全湿。 */
    val mix: Float = 0.4f,
    /** 暂停时让余音自然衰减（而不是随播放器一起停）。 */
    val tailOnPause: Boolean = true,
) {
    companion object {
        val NEUTRAL = ReverbSettings()
    }
}

/** 声场宽度：M/S 加权，挂在混响之前，只影响干声。 */
class StereoSettings(
    val enabled: Boolean = false,
    /** 0 单声道 ~ 2 侧向加倍；1 是原样。 */
    val width: Float = 1f,
) {
    companion object {
        val NEUTRAL = StereoSettings()
    }
}

/** 后置均衡器：挂在压缩之后、混响之前的那一套十段。 */
class PostEqSettings(
    val enabled: Boolean = false,
    val gains: FloatArray = FloatArray(EQ_BAND_COUNT),
    val mode: Int = EqCurveMode.GEQ,
    val q: Float = 0.85f,
    val globalGainDb: Float = 0f,
) {
    companion object {
        val NEUTRAL = PostEqSettings()
    }
}

/**
 * 一次听感设置的不可变快照。
 *
 * [seq] 是**进程内**的变更序号，只用来让音频线程判断「这份快照是不是新的」；
 * 它与协议版本 [version] 是两件事：前者每推一次加一，后者只在协议形状变化时改。
 */
class EqSettings(
    val version: Int,
    val enabled: Boolean,
    val gains: FloatArray,
    /** 前置均衡器的曲线形状，[EqCurveMode]。 */
    val mode: Int = EqCurveMode.GEQ,
    /** PEQ 的 Q；GEQ 时忽略（固定 [EQ_BAND_Q]）。 */
    val q: Float = 0.85f,
    /** 前置均衡器的总增益，-24 ~ +12 dB，挂在十段之外。 */
    val globalGainDb: Float = 0f,
    val punch: Float = 0f,
    val space: Float = 0f,
    val highpassHz: Float = 20f,
    val lowpassHz: Float = 20000f,
    val glideMs: Int = 15,
    val reverb: ReverbSettings = ReverbSettings.NEUTRAL,
    val compressor: CompressorSettings = CompressorSettings.NEUTRAL,
    val postEq: PostEqSettings = PostEqSettings.NEUTRAL,
    val stereo: StereoSettings = StereoSettings.NEUTRAL,
    val seq: Long = 0L,
) {

    fun withSeq(next: Long): EqSettings = EqSettings(
        version = version,
        enabled = enabled,
        gains = gains,
        mode = mode,
        q = q,
        globalGainDb = globalGainDb,
        punch = punch,
        space = space,
        highpassHz = highpassHz,
        lowpassHz = lowpassHz,
        glideMs = glideMs,
        reverb = reverb,
        compressor = compressor,
        postEq = postEq,
        stereo = stereo,
        seq = next,
    )

    /** 十段全 0 且音效全中性：此时整条链是恒等变换，调用方可以按字节直通。 */
    fun isFlat(): Boolean = gains.all { kotlin.math.abs(it) < 0.01f }
        && kotlin.math.abs(globalGainDb) < 0.01f
        && punch < 0.001f
        && space < 0.001f
        && highpassHz <= 21f
        && lowpassHz >= 19000f
        && !reverb.enabled
        && !compressor.enabled
        && !postEq.enabled
        && !stereo.enabled

    /**
     * 回写成 Web 推上来的那种 JSON。
     *
     * 冷启动恢复要存整份设置（不只是 P1 那四项），否则重新打开时压缩器与混响会静默丢掉。
     * 形状与 `NativeEqualizerPayload` 一致，这样「读回来」与「刚推来」走的是同一个解析器。
     */
    fun toJson(): JSONObject {
        val eqJson = JSONObject().apply {
            put("mode", modeName(mode))
            put("q", q.toDouble())
            put("globalGainDb", globalGainDb.toDouble())
        }
        val effectsJson = JSONObject().apply {
            put("punch", punch.toDouble())
            put("space", space.toDouble())
            put("highpass", highpassHz.toDouble())
            put("lowpass", lowpassHz.toDouble())
        }
        val reverbJson = JSONObject().apply {
            put("enabled", reverb.enabled)
            put("preset", reverb.preset)
            put("rt60", reverb.rt60Seconds.toDouble())
            put("roomLevelDb", reverb.roomLevelDb.toDouble())
            put("damping", reverb.damping.toDouble())
            put("preDelayMs", reverb.preDelayMs.toDouble())
            put("mix", reverb.mix.toDouble())
            put("tailOnPause", reverb.tailOnPause)
        }
        val stereoJson = JSONObject().apply {
            put("enabled", stereo.enabled)
            put("width", stereo.width.toDouble())
        }
        val compressorJson = JSONObject().apply {
            put("enabled", compressor.enabled)
            put("bandCount", compressor.bandCount)
            put("profile", compressor.profile)
            put("bands", JSONArray().apply { compressor.bands.forEach { put(it.toJson()) } })
        }
        val postEqJson = JSONObject().apply {
            put("enabled", postEq.enabled)
            put("gains", JSONArray().putAll(postEq.gains))
            put("mode", modeName(postEq.mode))
            put("q", postEq.q.toDouble())
            put("globalGainDb", postEq.globalGainDb.toDouble())
        }
        return JSONObject().apply {
            put("version", version)
            put("enabled", enabled)
            put("gains", JSONArray().putAll(gains))
            put("eq", eqJson)
            put("effects", effectsJson)
            put("reverb", reverbJson)
            put("compressor", compressorJson)
            put("postEq", postEqJson)
            put("stereo", stereoJson)
            put("glideMs", glideMs)
        }
    }

    companion object {

        /** 出厂值：关、全平、音效全中性。 */
        val NEUTRAL = EqSettings(
            version = EQ_PROTOCOL_VERSION,
            enabled = false,
            gains = FloatArray(EQ_BAND_COUNT),
        )

        /**
         * 读一个夹紧到 [min, max] 的数值字段。
         *
         * 用可空 receiver 是为了让调用点不写 `?:`：字段所在的段整个缺席（老版本 WebView
         * 推上来的包）时直接用默认值。值非有限时原样交给 `coerceIn` —— 这里不额外兜底，
         * 免得把「上游发了个 NaN」变成「上游发了个 0.85」而没人发现。
         */
        private fun JSONObject?.number(key: String, fallback: Double, min: Float, max: Float): Float {
            val value = this?.optDouble(key, fallback) ?: fallback
            return value.coerceIn(min.toDouble(), max.toDouble()).toFloat()
        }

        private fun modeName(mode: Int): String =
            if (mode == EqCurveMode.PEQ) "peq" else "geq"

        private fun readMode(json: JSONObject?): Int =
            if (json?.optString("mode", "geq") == "peq") EqCurveMode.PEQ else EqCurveMode.GEQ

        private fun JSONArray.putAll(values: FloatArray): JSONArray {
            values.forEach { put(it.toDouble()) }
            return this
        }

        private fun CompressorBand.toJson(): JSONObject = JSONObject().apply {
            put("enabled", enabled)
            put("thresholdDb", thresholdDb.toDouble())
            put("ratio", ratio.toDouble())
            put("attackMs", attackMs.toDouble())
            put("releaseMs", releaseMs.toDouble())
            put("makeupDb", makeupDb.toDouble())
            put("kneeDb", kneeDb.toDouble())
            put("mix", mix.toDouble())
        }

        private fun readGains(raw: JSONArray?): FloatArray = FloatArray(EQ_BAND_COUNT) { index ->
            val value = raw?.optDouble(index, 0.0) ?: 0.0
            if (value.isFinite()) {
                value.coerceIn(EQ_MIN_GAIN_DB.toDouble(), EQ_MAX_GAIN_DB.toDouble()).toFloat()
            } else {
                0f
            }
        }

        /**
         * 从 Web 的 `NativeEqualizerPayload` 解析。
         *
         * 校验从宽到严都只有一个方向：**宁可把值夹到合法区间，也不要抛异常** ——
         * 一条格式不对的推送不该让播放失败，最坏结果是这一版 EQ 不生效。
         */
        fun fromJson(json: JSONObject): EqSettings {
            val effects = json.optJSONObject("effects")
            val eq = json.optJSONObject("eq")
            return EqSettings(
                version = json.optInt("version", EQ_PROTOCOL_VERSION),
                enabled = json.optBoolean("enabled", false),
                gains = readGains(json.optJSONArray("gains")),
                mode = readMode(eq),
                q = eq.number("q", 0.85, EQ_MIN_Q, EQ_MAX_Q),
                globalGainDb = eq.number("globalGainDb", 0.0, -24f, 12f),
                punch = effects.number("punch", 0.0, 0f, 1f),
                space = effects.number("space", 0.0, 0f, 1f),
                highpassHz = effects.number("highpass", 20.0, 20f, 2000f),
                lowpassHz = effects.number("lowpass", 20000.0, 500f, 20000f),
                glideMs = json.optInt("glideMs", 15).coerceIn(5, 1000),
                reverb = readReverb(json.optJSONObject("reverb")),
                compressor = readCompressor(json.optJSONObject("compressor")),
                postEq = readPostEq(json.optJSONObject("postEq")),
                stereo = readStereo(json.optJSONObject("stereo")),
            )
        }

        private fun readReverb(json: JSONObject?): ReverbSettings {
            if (json == null) return ReverbSettings.NEUTRAL
            val preset = ReverbPreset.clamp(json.optInt("preset", ReverbPreset.FACTORY))
            return ReverbSettings(
                enabled = json.optBoolean("enabled", false),
                preset = preset,
                rt60Seconds = json.number("rt60", 2.2, 0.3f, 10f),
                roomLevelDb = json.number("roomLevelDb", -2.0, -24f, 6f),
                // 缺席时按预设兜底：旧存档里没有这两个字段，而「大教堂」该有的阻尼
                // 本来就和「出厂」不一样，用统一默认值会把它悄悄换成出厂的听感。
                damping = json.number("damping", ReverbPreset.defaultDamping(preset).toDouble(), 0.02f, 0.9f),
                preDelayMs = json.number("preDelayMs", ReverbPreset.defaultPreDelayMs(preset).toDouble(), 0f, 120f),
                mix = json.number("mix", 0.4, 0f, 1f),
                tailOnPause = json.optBoolean("tailOnPause", true),
            )
        }

        private fun readStereo(json: JSONObject?): StereoSettings {
            if (json == null) return StereoSettings.NEUTRAL
            return StereoSettings(
                enabled = json.optBoolean("enabled", false),
                width = json.number("width", 1.0, 0f, 2f),
            )
        }

        private fun readCompressor(json: JSONObject?): CompressorSettings {
            if (json == null) return CompressorSettings.NEUTRAL
            val rawBands = json.optJSONArray("bands")
            val bands = Array(CompressorSettings.COMPRESSOR_BAND_COUNT) { index ->
                val fallback = CompressorSettings.bandDefaults(index)
                val item = rawBands?.optJSONObject(index) ?: return@Array fallback
                CompressorBand(
                    enabled = item.optBoolean("enabled", fallback.enabled),
                    thresholdDb = item.number("thresholdDb", fallback.thresholdDb.toDouble(), -48f, 0f),
                    ratio = item.number("ratio", fallback.ratio.toDouble(), 1f, 20f),
                    attackMs = item.number("attackMs", fallback.attackMs.toDouble(), 0.5f, 100f),
                    releaseMs = item.number("releaseMs", fallback.releaseMs.toDouble(), 10f, 1000f),
                    makeupDb = item.number("makeupDb", 0.0, 0f, 12f),
                    kneeDb = item.number("kneeDb", 6.0, 2f, 18f),
                    mix = item.number("mix", 1.0, 0f, 1f),
                )
            }
            return CompressorSettings(
                enabled = json.optBoolean("enabled", false),
                bandCount = if (json.optInt("bandCount", 4) == 2) 2 else 4,
                profile = if (json.optInt("profile", CompressorProfile.GENTLE) == CompressorProfile.FLAT) {
                    CompressorProfile.FLAT
                } else {
                    CompressorProfile.GENTLE
                },
                bands = bands,
            )
        }

        private fun readPostEq(json: JSONObject?): PostEqSettings {
            if (json == null) return PostEqSettings.NEUTRAL
            return PostEqSettings(
                enabled = json.optBoolean("enabled", false),
                gains = readGains(json.optJSONArray("gains")),
                mode = readMode(json),
                q = json.number("q", 0.85, EQ_MIN_Q, EQ_MAX_Q),
                globalGainDb = json.number("globalGainDb", 0.0, -24f, 12f),
            )
        }
    }
}
