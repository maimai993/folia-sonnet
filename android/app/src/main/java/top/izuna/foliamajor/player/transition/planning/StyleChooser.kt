package top.izuna.foliamajor.player.transition.planning

import top.izuna.foliamajor.player.transition.EffectCatalog
import top.izuna.foliamajor.player.transition.EffectId
import top.izuna.foliamajor.player.transition.EffectSpec
import top.izuna.foliamajor.player.transition.KeyRelation
import top.izuna.foliamajor.player.transition.KeyRelations
import top.izuna.foliamajor.player.transition.MusicalTime
import top.izuna.foliamajor.player.transition.TempoRelation
import top.izuna.foliamajor.player.transition.TrackProfile
import top.izuna.foliamajor.player.transition.TransitionMode
import top.izuna.foliamajor.player.transition.TransitionSettings
import kotlin.math.abs

// android/app/src/main/java/top/izuna/foliamajor/player/transition/planning/StyleChooser.kt
// 18 种接法的选择器。纯函数，可 JVM 单测。
//
// 规则顺序沿用 Web 侧 transitionChooser.ts 的四条基线（beatCut / bassSwap / tailRide /
// plainBlend），再往上下各扩一层：
//   · 上面加「空间 / 节奏 / 表现」三类更抢耳的接法；
//   · 下面加「滤波 / 三频段 / 反向」等原生 DSP 才做得出来的接法。
// 每条规则都写明触发条件，诊断面板能把 reason 原样显示出来 —— 不是黑盒打分。

/** 当前构建实际具备的能力。规划层只挑能力够得着的效果。 */
data class Capabilities(
    val beatGrid: Boolean = true,
    val dspChain: Boolean = true,
    val enhancer: Boolean = false,
) {
    companion object {
        fun from(map: Map<String, Any>): Capabilities = Capabilities(
            beatGrid = map["beatGrid"] as? Boolean ?: true,
            dspChain = map["dspChain"] as? Boolean ?: true,
            enhancer = map["stems"] as? Boolean ?: false,
        )
    }
}

data class ChoiceContext(
    val from: TrackProfile?,
    val to: TrackProfile?,
    /** 正在播放那一路自测的速度：没有离线档案时它也是证据。 */
    val bpmLive: Float? = null,
    /** 出场曲歌词行数：>0 表示有人声时间轴，handover 可以放在唱完的地方。 */
    val fromLyricLines: Int = 0,
    val settings: TransitionSettings = TransitionSettings(),
    val capabilities: Capabilities = Capabilities(),
)

data class Choice(
    val spec: EffectSpec,
    val relation: KeyRelation,
    val tempo: TempoRelation,
    val reason: String,
)

object StyleChooser {

    fun choose(ctx: ChoiceContext): Choice {
        val from = ctx.from
        val to = ctx.to
        val fromBpm = from?.bpm ?: ctx.bpmLive
        val toBpm = to?.bpm
        val tempo = MusicalTime.relation(fromBpm, toBpm)
        val relation = KeyRelations.between(from?.keyTail ?: -1, to?.keyHead ?: -1)
        val grid = from?.hasBeatGrid == true || to?.hasBeatGrid == true || ctx.bpmLive != null
        val available = EffectCatalog.available(
            beatGrid = grid && ctx.capabilities.beatGrid,
            enhancer = ctx.capabilities.enhancer,
            dspChain = ctx.capabilities.dspChain,
        )
        val ids = available.map { it.id }.toSet()

        fun pick(id: EffectId, why: String): Choice {
            val fallback = EffectCatalog.spec(EffectId.PLAIN_BLEND)
            val spec = if (id in ids) EffectCatalog.spec(id) else fallback
            return Choice(spec, relation, tempo, why)
        }

        // 0) 用户手动指定：只要当前能力够得着就照办，够不着就明确降级并写进 reason。
        ctx.settings.effectOverride?.let { wanted ->
            val spec = EffectCatalog.spec(wanted)
            val usable = wanted in ids
            return Choice(
                if (usable) spec else EffectCatalog.spec(EffectId.PLAIN_BLEND),
                relation, tempo,
                if (usable) "用户指定 ${spec.label}" else "用户指定 ${spec.label}，但当前能力不足，退回等功率交叉",
            )
        }

        // 1) 固定长度模式：可预测的一半，不看速度 / 调性 / 段落。
        if (ctx.settings.mode == TransitionMode.CROSSFADE) {
            return pick(EffectId.PLAIN_BLEND, "固定长度交叉淡化模式，只按用户设定的秒数")
        }

        // 2) 没有证据：automix 不是「谨慎」，是无从推理，直接走 crossfade 规划器。
        val hasEvidence = (from?.hasEvidence == true || to?.hasEvidence == true
            || ctx.bpmLive != null || ctx.fromLyricLines > 0)
        if (!hasEvidence) {
            return pick(EffectId.PLAIN_BLEND, "两首都没有可测量的证据，退回等功率交叉")
        }

        // 3) 进场曲一开头就是满电平，或两曲速度差到会打架：切口比硬叠干净。
        if (to?.startsHot == true || tempo == TempoRelation.FAR) {
            return pick(
                if (grid && ctx.capabilities.beatGrid) EffectId.BEAT_CUT else EffectId.HARD_CUT,
                if (to?.startsHot == true) "进场曲满电平开头，重叠会糊，走拍点硬切"
                else "两曲速度差超过 ${(MusicalTime.DRIFT_LIMIT * 100).toInt()}%，不重叠",
            )
        }

        // 4) 调性冲突：宁可留一点呼吸，也不要把两个不兼容的调叠在一起。
        if (relation == KeyRelation.CLASHING) {
            return pick(EffectId.FADE_OUT_IN, "首尾调性冲突（${relation.wire}），先出后进留呼吸")
        }

        // 5) 表现模式：在交接点前加一段手势，落点由执行层按真实 swap 决定。
        if (ctx.settings.performance && grid && ctx.capabilities.beatGrid) {
            val gesture = if (to?.startsHot == true) EffectId.RISER_DROP else EffectId.BUILD_UP
            return pick(gesture, "表现模式开启，按拍叠加 ${EffectCatalog.spec(gesture).label}")
        }

        // 6) 速度可弯到一起：只弯出场曲，再按小节交接。
        if (tempo == TempoRelation.STRETCHABLE && grid && ctx.capabilities.beatGrid) {
            return pick(EffectId.TEMPO_BEND, "两曲速度差在 12% 内，弯出场曲对齐小节")
        }

        // 7) 出场曲有衰减尾巴 + 进场曲有前奏：长重叠，从尾巴底下浮上来。
        if (from?.endingShape?.wire == "resolve" && (to?.introEndMs ?: 0L) > 2_000L) {
            return pick(EffectId.TAIL_RIDE, "出场曲衰减尾巴 + 进场曲前奏，长重叠骑行")
        }

        // 8) 出场曲是硬断开：用空间效果把断口藏起来。
        if (from?.endingShape?.wire == "cut" || from?.endingShape?.wire == "fullLevel") {
            return pick(
                if (ctx.capabilities.dspChain) EffectId.ECHO_THROW else EffectId.REVERB_CARRY,
                "出场曲结尾被剪断 / 满电平到底，用${if (ctx.capabilities.dspChain) "回声抛掷" else "混响尾"}盖住断口",
            )
        }

        // 9) 有分离能力且出场曲有人声尾：让人声先退，乐器继续垫。
        if (ctx.capabilities.enhancer && (from?.hasVocalTail == true || ctx.fromLyricLines > 0)) {
            return pick(EffectId.VOCAL_RECEDE, "增强包就绪且出场曲有人声尾，中频凹陷让人声先走")
        }

        // 10) 三频段占比差得远：分段错时交接，避免两首歌糊成一片。
        val bandDelta = bandDistance(from?.bandTail, to?.bandHead)
        if (bandDelta > 0.22f && ctx.capabilities.dspChain) {
            return pick(EffectId.THREE_BAND_SEAM, "两端频段结构差 ${"%.2f".format(bandDelta)}，分三段错时接缝")
        }

        // 11) 电子 / 舞曲：滤波扫入比纯音量斜坡更「有力」。
        val hotHigh = (to?.bandHead?.high ?: 0.33f) > 0.42f
        if (hotHigh && ctx.capabilities.dspChain) {
            return pick(EffectId.FILTER_SWEEP_IN, "进场曲高频占比高，低通扫入")
        }

        // 12) 有拍点网格且速度接近：按小节定长，而不是按秒。
        if (grid && ctx.capabilities.beatGrid && tempo in setOf(TempoRelation.LOCKED, TempoRelation.NEAR)) {
            return pick(EffectId.BAR_ALIGNED_BLEND, "两端速度 ${tempo.wire}，按小节对齐")
        }

        // 13) drifting：不变速，但照常重叠，只是较短。
        if (tempo == TempoRelation.DRIFTING) {
            return pick(EffectId.PLATEAU_BLEND, "速度差 ${tempo.wire}，不弯速、短平台混音")
        }

        // 14) 默认 DJ 接法：低频同一时刻只属于一方。
        return pick(
            if (ctx.capabilities.dspChain) EffectId.BASS_SWAP else EffectId.PLAIN_BLEND,
            "两曲可重叠，默认${if (ctx.capabilities.dspChain) "低频换手" else "等功率交叉"}",
        )
    }

    private fun bandDistance(a: top.izuna.foliamajor.player.transition.BandBalance?, b: top.izuna.foliamajor.player.transition.BandBalance?): Float {
        if (a == null || b == null) return 0f
        return (abs(a.low - b.low) + abs(a.mid - b.mid) + abs(a.high - b.high)) / 2f
    }

    /** 表现模式强度：只回答「打多重」，落点由执行层按 real swap 决定（Web 侧 README §6.7）。 */
    fun expansionIntensity(from: TrackProfile?, to: TrackProfile?): Float {
        val tail = from?.tailDb ?: -60f
        val head = to?.headDb ?: -60f
        val delta = abs(head - tail)
        return when {
            to?.startsHot == true -> 1f
            delta > 12f -> 0.75f
            delta > 6f -> 0.5f
            else -> 0.25f
        }
    }
}
