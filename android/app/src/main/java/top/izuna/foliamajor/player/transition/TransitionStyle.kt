package top.izuna.foliamajor.player.transition

// android/app/src/main/java/top/izuna/foliamajor/player/transition/TransitionStyle.kt
// 原生过渡效果的唯一 id 表与能力描述。
//
// 设计纪律（沿用 Web 侧 README §5 那条「新增第三种模式 = 新增一个文件」）：
// 执行层只认 EffectId，新增一种接法 = 在 EffectCatalog.ALL 里加一行 +
// 在 engine/effects/ 里加一个 TransitionEffect 实现，规划层与播放器一行不改。
//
// 包体纪律：全部效果都是 Kotlin 算术 + 复用 player/dsp/ 里已有的 BiquadFilter /
// ReverbStage / LookaheadLimiter，不引入模型权重、不引入 .so、不引入新依赖。
// 需要 htdemucs 那类分离能力的效果统一标 needsEnhancer = true，只在可选的
// 按需下载增强包（≤ 18 MB，不进 APK）就绪时才参与选择，否则自动降级。

/** 18 种接法。wire 与 Web 侧设置页的值一一对应，改名要两边一起改。 */
enum class EffectId(val wire: String) {
    PLAIN_BLEND("plainBlend"),
    HARD_CUT("hardCut"),
    FADE_OUT_IN("fadeOutIn"),
    PLATEAU_BLEND("plateauBlend"),

    BASS_SWAP("bassSwap"),
    THREE_BAND_SEAM("threeBandSeam"),
    FILTER_SWEEP_IN("filterSweepIn"),
    VOCAL_RECEDE("vocalRecede"),

    BEAT_CUT("beatCut"),
    BAR_ALIGNED_BLEND("barAlignedBlend"),
    TEMPO_BEND("tempoBend"),

    TAIL_RIDE("tailRide"),
    ECHO_THROW("echoThrow"),
    REVERB_CARRY("reverbCarry"),

    BUILD_UP("buildUp"),
    RISER_DROP("riserDrop"),
    VINYL_BRAKE("vinylBrake"),
    REVERSE_CRESCENDO("reverseCrescendo"),
    ;

    companion object {
        private val BY_WIRE = values().associateBy { it.wire }
        fun fromWire(value: String?): EffectId? = value?.let { BY_WIRE[it] }
    }
}

enum class EffectFamily { CORE, BAND, RHYTHM, SPACE, PERFORMANCE }

/**
 * 一种接法的静态能力描述。规划层用它做「这个效果在当前证据下能不能用」的过滤，
 * 而不是把判断散落在 chooser 的 if 里。
 */
data class EffectSpec(
    val id: EffectId,
    val family: EffectFamily,
    val label: String,
    val summary: String,
    /** 是否需要拍点 / 小节网格。没有就退回不需要它的同类效果。 */
    val needsBeatGrid: Boolean = false,
    /** 是否需要三频段 PCM 处理（会启用 TransitionDspProcessor）。 */
    val needsBandSplit: Boolean = false,
    /** 是否需要可选增强包（音轨分离等）。未就绪时该效果不参与选择。 */
    val needsEnhancer: Boolean = false,
    val minOverlapMs: Int,
    val maxOverlapMs: Int,
    val defaultCurve: CurveId,
    /** 中段平台占整段的比例，见 GainCurve 的 together。 */
    val defaultTogether: Float = 0f,
)

object EffectCatalog {

    val ALL: List<EffectSpec> = listOf(
        EffectSpec(
            EffectId.PLAIN_BLEND, EffectFamily.CORE, "等功率交叉",
            "两条 sin/cos 曲线，合成功率恒为 1；什么都测不出来时的兜底。",
            minOverlapMs = 1_500, maxOverlapMs = 12_000,
            defaultCurve = CurveId.EQUAL_POWER,
        ),
        EffectSpec(
            EffectId.HARD_CUT, EffectFamily.CORE, "硬切",
            "40 ms 切口直接换源，不重叠；进场曲满电平开头或两曲速度差过大时用。",
            minOverlapMs = 40, maxOverlapMs = 40,
            defaultCurve = CurveId.LINEAR,
        ),
        EffectSpec(
            EffectId.FADE_OUT_IN, EffectFamily.CORE, "先出后进",
            "出场曲先淡到静音，留一小段呼吸，进场曲再起；抒情 / 古典适用。",
            minOverlapMs = 600, maxOverlapMs = 4_000,
            defaultCurve = CurveId.SLOW_START,
        ),
        EffectSpec(
            EffectId.PLATEAU_BLEND, EffectFamily.CORE, "平台混音",
            "中段两曲各停在 0.707 不动、低频在此换手 —— DJ 动作，不是淡入淡出。",
            needsBandSplit = true,
            minOverlapMs = 2_000, maxOverlapMs = 14_000,
            defaultCurve = CurveId.PLATEAU, defaultTogether = 0.5f,
        ),

        EffectSpec(
            EffectId.BASS_SWAP, EffectFamily.BAND, "低频换手",
            "重叠，但低频同一时刻只属于一方；两曲可重叠时的默认选择。",
            needsBandSplit = true,
            minOverlapMs = 2_000, maxOverlapMs = 14_000,
            defaultCurve = CurveId.PLATEAU, defaultTogether = 0.45f,
        ),
        EffectSpec(
            EffectId.THREE_BAND_SEAM, EffectFamily.BAND, "三频段接缝",
            "高 / 中 / 低分三段错时交接，音色差大的两曲不糊在一起。",
            needsBandSplit = true,
            minOverlapMs = 2_500, maxOverlapMs = 16_000,
            defaultCurve = CurveId.S_CURVE, defaultTogether = 0.3f,
        ),
        EffectSpec(
            EffectId.FILTER_SWEEP_IN, EffectFamily.BAND, "滤波扫入",
            "进场曲从低通闷住一路扫到全频，出场曲反向退场；电子 / 舞曲。",
            needsBandSplit = true,
            minOverlapMs = 2_000, maxOverlapMs = 12_000,
            defaultCurve = CurveId.EQUAL_POWER,
        ),
        EffectSpec(
            EffectId.VOCAL_RECEDE, EffectFamily.BAND, "人声退场",
            "出场曲中频凹陷让人声先走，尾音留在两侧继续垫着进场曲。",
            needsBandSplit = true, needsEnhancer = true,
            minOverlapMs = 3_000, maxOverlapMs = 16_000,
            defaultCurve = CurveId.SLOW_START, defaultTogether = 0.25f,
        ),

        EffectSpec(
            EffectId.BEAT_CUT, EffectFamily.RHYTHM, "拍点切",
            "对齐小节线切断，切口 40 ms；需要拍点网格。",
            needsBeatGrid = true,
            minOverlapMs = 40, maxOverlapMs = 40,
            defaultCurve = CurveId.LINEAR,
        ),
        EffectSpec(
            EffectId.BAR_ALIGNED_BLEND, EffectFamily.RHYTHM, "小节对齐",
            "过渡长度按 4 / 8 / 16 小节取整，而不是按秒；BPM 接近时用。",
            needsBeatGrid = true,
            minOverlapMs = 2_000, maxOverlapMs = 24_000,
            defaultCurve = CurveId.PLATEAU, defaultTogether = 0.4f,
        ),
        EffectSpec(
            EffectId.TEMPO_BEND, EffectFamily.RHYTHM, "变速对齐",
            "只弯出场曲的 playbackRate（上限 ±12%），对齐后再按小节交接；绝不弯进场曲。",
            needsBeatGrid = true,
            minOverlapMs = 2_000, maxOverlapMs = 20_000,
            defaultCurve = CurveId.PLATEAU, defaultTogether = 0.35f,
        ),

        EffectSpec(
            EffectId.TAIL_RIDE, EffectFamily.SPACE, "尾巴骑行",
            "出场曲有衰减尾巴、进场曲有前奏时长重叠，进场曲从尾巴底下浮上来。",
            minOverlapMs = 4_000, maxOverlapMs = 24_000,
            defaultCurve = CurveId.LOGARITHMIC, defaultTogether = 0.2f,
        ),
        EffectSpec(
            EffectId.ECHO_THROW, EffectFamily.SPACE, "回声抛掷",
            "出场曲不直接停止，抛进延迟反馈里衰减，给进场曲让出空间。",
            needsBandSplit = true,
            minOverlapMs = 1_000, maxOverlapMs = 10_000,
            defaultCurve = CurveId.FAST_CUT,
        ),
        EffectSpec(
            EffectId.REVERB_CARRY, EffectFamily.SPACE, "混响尾延续",
            "复用已有 ReverbStage 的尾巴，出场曲断开时把空间感带过交接点。",
            minOverlapMs = 1_200, maxOverlapMs = 12_000,
            defaultCurve = CurveId.EXPONENTIAL,
        ),

        EffectSpec(
            EffectId.BUILD_UP, EffectFamily.PERFORMANCE, "Build-up 手势",
            "在交接点前按拍叠加抽拉 / 升调 / 甩盘样本，强度由首尾电平差决定。",
            needsBeatGrid = true,
            minOverlapMs = 3_000, maxOverlapMs = 20_000,
            defaultCurve = CurveId.FAST_CUT,
        ),
        EffectSpec(
            EffectId.RISER_DROP, EffectFamily.PERFORMANCE, "升调跌落",
            "riser 一路爬升，到进场曲第一拍 drop；进场曲 hot start 时最有效。",
            needsBeatGrid = true,
            minOverlapMs = 2_500, maxOverlapMs = 16_000,
            defaultCurve = CurveId.EXPONENTIAL,
        ),
        EffectSpec(
            EffectId.VINYL_BRAKE, EffectFamily.PERFORMANCE, "甩盘刹车",
            "出场曲速度下行 + 低通下扫，像把唱片按住；强节奏曲目专用。",
            needsBandSplit = true,
            minOverlapMs = 900, maxOverlapMs = 6_000,
            defaultCurve = CurveId.FAST_CUT,
        ),
        EffectSpec(
            EffectId.REVERSE_CRESCENDO, EffectFamily.PERFORMANCE, "反向渐显",
            "进场曲用反向包络渐显，出场曲留一条渐弱的镜像；氛围 / ambient。",
            minOverlapMs = 2_000, maxOverlapMs = 14_000,
            defaultCurve = CurveId.ASYMMETRIC,
        ),
    )

    private val BY_ID = ALL.associateBy { it.id }

    fun spec(id: EffectId): EffectSpec = BY_ID.getValue(id)

    fun fromWire(value: String?): EffectSpec? = EffectId.fromWire(value)?.let { BY_ID[it] }

    /** 设置页 / 诊断面板用的清单。 */
    fun wireIds(): List<String> = ALL.map { it.id.wire }

    /** 当前能力下可用的效果（证据不足或增强包未就绪时过滤掉）。 */
    fun available(
        beatGrid: Boolean,
        enhancer: Boolean,
        dspChain: Boolean,
    ): List<EffectSpec> = ALL.filter { spec ->
        (!spec.needsBeatGrid || beatGrid)
            && (!spec.needsEnhancer || enhancer)
            && (!spec.needsBandSplit || dspChain)
    }
}
