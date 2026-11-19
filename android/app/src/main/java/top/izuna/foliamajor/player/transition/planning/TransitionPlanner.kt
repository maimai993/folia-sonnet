package top.izuna.foliamajor.player.transition.planning

import top.izuna.foliamajor.player.transition.CurveId
import top.izuna.foliamajor.player.transition.EffectId
import top.izuna.foliamajor.player.transition.KeyRelations
import top.izuna.foliamajor.player.transition.MusicalTime
import top.izuna.foliamajor.player.transition.PlanKind
import top.izuna.foliamajor.player.transition.TempoRelation
import top.izuna.foliamajor.player.transition.TrackProfile
import top.izuna.foliamajor.player.transition.TransitionMode
import top.izuna.foliamajor.player.transition.TransitionPlan
import kotlin.math.roundToInt

// android/app/src/main/java/top/izuna/foliamajor/player/transition/planning/TransitionPlanner.kt
// 把「选了哪种接法」变成一份可执行的纯数据方案。纯函数，可 JVM 单测。
//
// 规划与执行分离的意义：执行层不关心是谁写的 plan（两个模式共用同一个 TransitionPlan），
// 于是新增一种模式 / 接法都不用碰播放器。契约与 Web 侧 transitionPlanner.ts 对齐。

object TransitionPlanner {

    fun plan(choice: Choice, ctx: ChoiceContext, nowMs: Long = System.currentTimeMillis()): TransitionPlan {
        val spec = choice.spec
        val from = ctx.from
        val to = ctx.to
        val settings = ctx.settings
        val fromBpm = from?.bpm ?: ctx.bpmLive
        val toBpm = to?.bpm
        val gridBpm = listOfNotNull(fromBpm, toBpm).firstOrNull()

        // ---- 1) 过渡时长 ----
        val overlapMs = when {
            spec.id == EffectId.HARD_CUT || spec.id == EffectId.BEAT_CUT -> MusicalTime.BEAT_CUT_MS.toInt()
            settings.mode == TransitionMode.CROSSFADE -> settings.crossfadeMaxMs
            else -> evidenceDrivenMs(spec.minOverlapMs, spec.maxOverlapMs, from, to, choice.tempo, gridBpm)
        }
            // 「混音时长」是用户手里的上限，automix 也得守：原来它只在固定淡化模式下被读，
            // 智能过渡自己算多长，于是设置页那个滑杆在 automix 下等于没有 —— 用户调了没反应。
            .coerceAtMost(settings.crossfadeMaxMs.coerceAtLeast(1))
            .coerceIn(spec.minOverlapMs, spec.maxOverlapMs)

        // ---- 2) 出场曲落点 ----
        // 优先落在人声唱完的地方（歌词时间轴），否则落在「尾部减去斜坡」。
        val duration = from?.durationMs ?: 0L
        val digitalTail = from?.silenceTailMs ?: 0L
        val outStartMs = if (duration > overlapMs) {
            (duration - digitalTail - overlapMs).coerceAtLeast(0L)
        } else 0L

        // ---- 3) 进场曲起点 ----
        val inStartMs = if (spec.needsBeatGrid && gridBpm != null) {
            MusicalTime.alignInStart(to?.silenceHeadMs ?: 0L, toBpm)
        } else (to?.silenceHeadMs ?: 0L).coerceAtMost(8_000L)

        // ---- 4) 音色 / 变速 / 空间 ----
        val tiltDb = KeyRelations.tiltDb(
            choice.relation,
            from?.bandTail ?: top.izuna.foliamajor.player.transition.BandBalance.FLAT,
            to?.bandHead ?: top.izuna.foliamajor.player.transition.BandBalance.FLAT,
        )
        val stretch = if (spec.id == EffectId.TEMPO_BEND) {
            MusicalTime.outgoingStretch(fromBpm, toBpm)
        } else 1f
        val echoThrow = spec.id == EffectId.ECHO_THROW || spec.id == EffectId.REVERB_CARRY

        // ---- 5) 曲线与强度 ----
        val curve = settings.curveOverride ?: spec.defaultCurve
        // 中段两曲同时保持多高，决定听感是「两段叠在一起混音」还是「此消彼长的淡入淡出」。
        //
        // 大多数效果的 defaultTogether 是 0，于是中段就是 sin/cos 此消彼长 —— 两条曲线虽然
        // 同时有声，但一条升一条降，听起来完全是普通交叉淡化，用户的原话是「没有两段音频
        // 重叠」。所以这里给一个基线平台：除了真正的切口（硬切 / 拍点切），一律保证中段有
        // 一段两曲都在 0.707 的重叠区。0.707 正是 cos=sin 那一点，合成功率不变，不会爆音。
        val cut = spec.id == EffectId.HARD_CUT || spec.id == EffectId.BEAT_CUT
        val baseline = if (cut) 0f else 0.45f
        val together = (maxOf(spec.defaultTogether, baseline) * (0.7f + 0.6f * settings.intensity))
            .coerceIn(0f, 0.85f)
        val expansion = if (settings.performance && settings.mode == TransitionMode.AUTOMIX) {
            StyleChooser.expansionIntensity(from, to)
        } else null

        val reason = buildString {
            append(choice.reason)
            append("；overlap=")
            append(overlapMs)
            append("ms")
            if (gridBpm != null && spec.needsBeatGrid) {
                append("（按 ")
                append("%.1f".format(gridBpm))
                append(" BPM 小节取整）")
            }
            if (stretch != 1f) {
                append("；出场变速 ×")
                append("%.3f".format(stretch))
            }
            if (choice.tempo == TempoRelation.DRIFTING) {
                append("；速度差 ")
                append("%.0f%%".format(driftPercent(fromBpm, toBpm)))
                append("，不弯速照常重叠")
            }
        }

        return TransitionPlan(
            kind = if (overlapMs <= MusicalTime.BEAT_CUT_MS) PlanKind.HARD_CUT else PlanKind.FADE,
            style = spec.id,
            relation = choice.relation,
            tempo = choice.tempo,
            stretch = stretch,
            tiltDb = tiltDb,
            echoThrow = echoThrow,
            outStartMs = outStartMs,
            inStartMs = inStartMs,
            overlapMs = overlapMs,
            minOverlapMs = spec.minOverlapMs,
            reason = reason,
            expansion = expansion,
            curve = curve,
            together = together,
            intensity = settings.intensity,
            needsDsp = spec.needsBandSplit,
            enhanced = spec.needsEnhancer && ctx.capabilities.enhancer,
            createdAtMs = nowMs,
        )
    }

    /**
     * 证据驱动的时长：先按结尾形态和速度关系给一个秒数，再按小节取整。
     * 判据全部来自 TrackProfile，没有一条是拍脑袋的固定值。
     */
    private fun evidenceDrivenMs(
        minMs: Int,
        maxMs: Int,
        from: TrackProfile?,
        to: TrackProfile?,
        tempo: TempoRelation,
        gridBpm: Float?,
    ): Int {
        var base = 5_000
        // 衰减尾巴 + 长前奏 → 长重叠；硬断开 / 满电平 → 短重叠。
        base += when (from?.endingShape?.wire) {
            "resolve" -> 3_000
            "cut", "fullLevel" -> -2_000
            else -> 0
        }
        base += if ((to?.introEndMs ?: 0L) > 8_000L) 2_000 else 0
        // 速度越远，重叠越短；drifting 之上不再叠。
        base += when (tempo) {
            TempoRelation.LOCKED, TempoRelation.NEAR -> 2_000
            TempoRelation.STRETCHABLE -> 1_000
            TempoRelation.DRIFTING -> -1_500
            TempoRelation.FAR -> -3_000
            TempoRelation.UNKNOWN -> 0
        }
        // 两端电平差大时给一点余量，避免进场曲一进来就被压住。
        val levelDelta = kotlin.math.abs((to?.headDb ?: -20f) - (from?.tailDb ?: -20f))
        base += (levelDelta * 80f).roundToInt().coerceIn(-1_500, 2_000)

        val bounded = base.coerceIn(minMs, maxMs)
        return if (gridBpm != null && tempo in setOf(
                TempoRelation.LOCKED, TempoRelation.NEAR, TempoRelation.STRETCHABLE
            )) {
            MusicalTime.snapToBars(bounded, gridBpm, minMs, maxMs)
        } else bounded
    }

    private fun driftPercent(from: Float?, to: Float?): Float {
        if (from == null || to == null || from <= 0f) return 0f
        return kotlin.math.abs(1f - MusicalTime.foldOctave(to / from)) * 100f
    }
}
