package top.izuna.foliamajor.player.transition

import org.json.JSONObject
import java.util.UUID

// android/app/src/main/java/top/izuna/foliamajor/player/transition/TransitionPlan.kt
// 规划层与执行层之间唯一的契约。字段名刻意与 Web 侧 automix/transitionPlanner.ts 的
// TransitionPlan 保持一致 —— 设置页 / cue 动画 / Remote 快照那几个 UI 组件因此不用改数据结构，
// 只需要把数据来源从本地 TS 规划器换成原生插件返回值（本次「保留 UI 只换内核」的前提）。

enum class PlanKind(val wire: String) { HARD_CUT("hardCut"), FADE("fade") }

data class TransitionPlan(
    val cueId: String = UUID.randomUUID().toString(),
    val kind: PlanKind = PlanKind.FADE,
    val style: EffectId = EffectId.PLAIN_BLEND,
    val relation: KeyRelation = KeyRelation.UNKNOWN,
    val tempo: TempoRelation = TempoRelation.UNKNOWN,
    /** 出场曲的 playbackRate，1 表示不变速。 */
    val stretch: Float = 1f,
    val tiltDb: Float = 0f,
    val echoThrow: Boolean = false,
    /** 出场曲第几毫秒开始过渡。 */
    val outStartMs: Long = 0L,
    /** 进场曲从第几毫秒起播。 */
    val inStartMs: Long = 0L,
    val overlapMs: Int = 4_000,
    val minOverlapMs: Int = 1_500,
    /** 长度是怎么定的。会打进诊断面板，非装饰性。 */
    val reason: String = "",
    /** 表现模式强度 0.25 / 0.5 / 0.75 / 1，关闭时 null。 */
    val expansion: Float? = null,
    val curve: CurveId = CurveId.EQUAL_POWER,
    val together: Float = 0f,
    val intensity: Float = 1f,
    val needsDsp: Boolean = false,
    /** 是否使用了可选增强包。 */
    val enhanced: Boolean = false,
    val createdAtMs: Long = System.currentTimeMillis(),
) {
    val needsBeatGrid: Boolean get() = EffectCatalog.spec(style).needsBeatGrid

    fun toJson(): JSONObject = JSONObject().apply {
        put("cueId", cueId)
        put("kind", kind.wire)
        put("style", style.wire)
        put("relation", relation.wire)
        put("tempo", tempo.wire)
        put("stretch", stretch.toDouble())
        put("tiltDb", tiltDb.toDouble())
        put("echoThrow", echoThrow)
        put("outStartMs", outStartMs)
        put("inStartMs", inStartMs)
        put("overlapMs", overlapMs)
        put("minOverlapMs", minOverlapMs)
        put("reason", reason)
        if (expansion != null) put("expansion", expansion.toDouble())
        put("curve", curve.wire)
        put("together", together.toDouble())
        put("intensity", intensity.toDouble())
        put("needsDsp", needsDsp)
        put("enhanced", enhanced)
        put("needsBeatGrid", needsBeatGrid)
        put("createdAtMs", createdAtMs)
    }

    companion object {
        fun fromJson(o: JSONObject): TransitionPlan = TransitionPlan(
            cueId = o.optString("cueId", UUID.randomUUID().toString()),
            kind = PlanKind.values().firstOrNull { it.wire == o.optString("kind") } ?: PlanKind.FADE,
            style = EffectId.fromWire(o.optString("style")) ?: EffectId.PLAIN_BLEND,
            relation = KeyRelation.values().firstOrNull { it.wire == o.optString("relation") }
                ?: KeyRelation.UNKNOWN,
            tempo = TempoRelation.values().firstOrNull { it.wire == o.optString("tempo") }
                ?: TempoRelation.UNKNOWN,
            stretch = o.optDouble("stretch", 1.0).toFloat(),
            tiltDb = o.optDouble("tiltDb", 0.0).toFloat(),
            echoThrow = o.optBoolean("echoThrow", false),
            outStartMs = o.optLong("outStartMs", 0L),
            inStartMs = o.optLong("inStartMs", 0L),
            overlapMs = o.optInt("overlapMs", 4_000),
            minOverlapMs = o.optInt("minOverlapMs", 1_500),
            reason = o.optString("reason", ""),
            expansion = if (o.has("expansion")) o.optDouble("expansion", 0.0).toFloat() else null,
            curve = CurveId.fromWire(o.optString("curve")),
            together = o.optDouble("together", 0.0).toFloat(),
            intensity = o.optDouble("intensity", 1.0).toFloat(),
            needsDsp = o.optBoolean("needsDsp", false),
            enhanced = o.optBoolean("enhanced", false),
            createdAtMs = o.optLong("createdAtMs", 0L),
        )
    }
}
