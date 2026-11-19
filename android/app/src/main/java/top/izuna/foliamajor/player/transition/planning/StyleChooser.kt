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
    /**
     * 上一次换歌用的接法。只用来避免连着两首听同一个接法 —— 用户听到的「单一」几乎都是
     * 「速度接近 + 有拍点」这条最常见分支每次都落到同一个效果上，而不是效果不够多。
     */
    val previousEffect: EffectId? = null,
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
        /*
         * 自动挑选不用「需要实时分频」的效果（低频换手 / 三频段 / 滤波扫入 / 回声抛掷 / 平台混音）。
         *
         * 那些效果要开 TransitionDspProcessor 对两路 PCM 实时分频，在中低端机上是实打实的
         * 负载：实测出现过播放一会儿整机卡死、应用被系统杀掉。听感收益远不如「播放稳」重要。
         * 想要它们，在设置里手动钉一个即可 —— 那条路走下面的 effectOverride 分支，按真实能力判。
         */
        val autoDsp = false
        // 手动指定：按真实能力判，用户点了就该生效。
        val manualIds = EffectCatalog.available(
            beatGrid = grid && ctx.capabilities.beatGrid,
            enhancer = ctx.capabilities.enhancer,
            dspChain = ctx.capabilities.dspChain,
        ).map { it.id }.toSet()
        // 自动挑选：只在「不需要实时分频」的效果里选。
        val ids = EffectCatalog.available(
            beatGrid = grid && ctx.capabilities.beatGrid,
            enhancer = ctx.capabilities.enhancer,
            dspChain = autoDsp,
        ).map { it.id }.toSet()

        fun pick(id: EffectId, why: String): Choice {
            val fallback = EffectCatalog.spec(EffectId.PLAIN_BLEND)
            val spec = if (id in ids) EffectCatalog.spec(id) else fallback
            return Choice(spec, relation, tempo, why)
        }

        // 0) 用户手动指定：只要当前能力够得着就照办，够不着就明确降级并写进 reason。
        ctx.settings.effectOverride?.let { wanted ->
            val spec = EffectCatalog.spec(wanted)
            val usable = wanted in manualIds
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

        // 3) 两曲速度差到会打架：不重叠，切口比硬叠干净。
        //
        // 原来这一条还兼管「进场曲满电平开头」，于是绝大多数流行歌（开头就是满电平）都被
        // 判成 40 ms 硬切 —— 用户听到的就是「智能过渡只有硬切」。满电平开头要的是**让进场
        // 曲别一下子砸进来**，而不是不接：短重叠 + 低通扫入 / 低频换手都能做到，且听得出
        // 是混音。真正的硬切只留给速度差大到会打架的情况。
        if (tempo == TempoRelation.FAR) {
            return pick(
                if (grid && ctx.capabilities.beatGrid) EffectId.BEAT_CUT else EffectId.HARD_CUT,
                "两曲速度差超过 ${(MusicalTime.DRIFT_LIMIT * 100).toInt()}%，不重叠",
            )
        }
        if (to?.startsHot == true) {
            val softened = if (autoDsp) {
                if ((to?.bandHead?.high ?: 0.33f) > 0.42f) EffectId.FILTER_SWEEP_IN else EffectId.BASS_SWAP
            } else {
                // 等功率交叉：唯一一条不需要实时分频的重叠接法。
                EffectId.PLAIN_BLEND
            }
            return pick(softened, "进场曲满电平开头，用${EffectCatalog.spec(softened).label}短重叠压住冲撞")
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
                if (autoDsp) EffectId.ECHO_THROW else EffectId.REVERB_CARRY,
                "出场曲结尾被剪断 / 满电平到底，用${if (autoDsp) "回声抛掷" else "混响尾"}盖住断口",
            )
        }

        // 9) 有分离能力且出场曲有人声尾：让人声先退，乐器继续垫。
        if (ctx.capabilities.enhancer && (from?.hasVocalTail == true || ctx.fromLyricLines > 0)) {
            return pick(EffectId.VOCAL_RECEDE, "增强包就绪且出场曲有人声尾，中频凹陷让人声先走")
        }

        // 10) 三频段占比差得远：分段错时交接，避免两首歌糊成一片。
        val bandDelta = bandDistance(from?.bandTail, to?.bandHead)
        if (bandDelta > 0.22f && autoDsp) {
            return pick(EffectId.THREE_BAND_SEAM, "两端频段结构差 ${"%.2f".format(bandDelta)}，分三段错时接缝")
        }

        // 11) 电子 / 舞曲：滤波扫入比纯音量斜坡更「有力」。
        val hotHigh = (to?.bandHead?.high ?: 0.33f) > 0.42f
        if (hotHigh && autoDsp) {
            return pick(EffectId.FILTER_SWEEP_IN, "进场曲高频占比高，低通扫入")
        }

        // 12) 有拍点网格且速度接近：按小节定长，而不是按秒。
        //
        // 这是整条链上命中率最高的一条 —— 绝大多数流行歌都「速度接近 + 有拍点」。原来这里
        // 固定回 BAR_ALIGNED_BLEND，于是听起来每次都是同一种等功率淡入淡出。改成从一个
        // 同样合格、但听感差别明显的候选池里挑：同一对歌永远挑到同一个（可复现、可解释），
        // 不同歌之间会变，且不会连着两次撞上上一次用过的那个。
        if (grid && ctx.capabilities.beatGrid && tempo in setOf(TempoRelation.LOCKED, TempoRelation.NEAR)) {
            val varied = pickVaried(
                candidates = listOf(
                    EffectId.BAR_ALIGNED_BLEND,
                    EffectId.BASS_SWAP,
                    EffectId.THREE_BAND_SEAM,
                    EffectId.FILTER_SWEEP_IN,
                    EffectId.BEAT_CUT,
                ),
                ids = ids,
                ctx = ctx,
            )
            if (varied != null) {
                return pick(varied, "两端速度 ${tempo.wire}，按小节对齐（本对曲目选 ${EffectCatalog.spec(varied).label}）")
            }
            return pick(EffectId.BAR_ALIGNED_BLEND, "两端速度 ${tempo.wire}，按小节对齐")
        }

        // 13) drifting：不变速，但照常重叠，只是较短。
        if (tempo == TempoRelation.DRIFTING) {
            return pick(EffectId.PLATEAU_BLEND, "速度差 ${tempo.wire}，不弯速、短平台混音")
        }

        // 14) 默认 DJ 接法：低频同一时刻只属于一方。
        if (autoDsp) {
            val varied = pickVaried(
                candidates = listOf(
                    EffectId.BASS_SWAP,
                    EffectId.THREE_BAND_SEAM,
                    EffectId.FILTER_SWEEP_IN,
                    EffectId.TAIL_RIDE,
                    EffectId.PLATEAU_BLEND,
                ),
                ids = ids,
                ctx = ctx,
            )
            if (varied != null) {
                return pick(varied, "两曲可重叠，本对曲目选 ${EffectCatalog.spec(varied).label}")
            }
        }
        return pick(
            if (autoDsp) EffectId.BASS_SWAP else EffectId.PLAIN_BLEND,
            "两曲可重叠，默认${if (autoDsp) "低频换手" else "等功率交叉"}",
        )
    }

    /**
     * 从一组都合格的候选里挑一个，规则有三条：
     *
     * 1. 只从当前能力够得着的里面挑（`ids`），够不着的一个都不选；
     * 2. 指纹只由两首曲目自己的事实算出来（时长 / 速度 / 频段 / 尾音），所以同一对歌每次
     *    都挑到同一个 —— 换歌是可复现的，诊断面板上的 reason 也说得清为什么是它；
     * 3. 挑到上一次用过的那个时，在剩下的候选里再选一次。连着两次同一个接法，听感上就是
     *    「这功能好像只有一种效果」，而这跟效果数量没关系。
     */
    private fun pickVaried(
        candidates: List<EffectId>,
        ids: Set<EffectId>,
        ctx: ChoiceContext,
    ): EffectId? {
        val usable = candidates.filter { it in ids }
        if (usable.isEmpty()) return null
        if (usable.size == 1) return usable.single()
        val withoutPrevious = usable.filter { it != ctx.previousEffect }
        val pool = withoutPrevious.ifEmpty { usable }
        val index = Math.floorMod(fingerprint(ctx), pool.size)
        return pool[index]
    }

    /**
     * 两首曲目的确定性指纹。故意只用「档案里本来就有的客观事实」，不掺随机数：
     * 同一对歌在设置页试听、在实际换歌时、在诊断复现时都得到同一个答案。
     */
    private fun fingerprint(ctx: ChoiceContext): Int {
        val from = ctx.from
        val to = ctx.to
        var acc = 17
        fun mix(value: Int) { acc = acc * 31 + value }
        mix((from?.durationMs ?: 0L).hashCode())
        mix((to?.durationMs ?: 0L).hashCode())
        mix(((from?.bpm ?: ctx.bpmLive ?: 0f) * 10f).toInt())
        mix(((to?.bpm ?: 0f) * 10f).toInt())
        mix(((from?.bandTail?.low ?: 0.33f) * 100f).toInt())
        mix(((to?.bandHead?.high ?: 0.33f) * 100f).toInt())
        mix(from?.endingShape?.wire?.hashCode() ?: 0)
        mix(from?.keyTail ?: -1)
        mix(to?.keyHead ?: -1)
        return acc
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
