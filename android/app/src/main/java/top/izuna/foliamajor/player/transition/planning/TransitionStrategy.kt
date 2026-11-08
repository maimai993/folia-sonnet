package top.izuna.foliamajor.player.transition.planning

import top.izuna.foliamajor.player.transition.TransitionPlan

// android/app/src/main/java/top/izuna/foliamajor/player/transition/planning/TransitionStrategy.kt
// 两种模式 = 两种规划路径，执行层一行不改。对应 Web 侧 automix/transitionStrategy.ts。
//
// 这里刻意保留「降级判据对着规划器实际消费什么写」那条纪律：
// 一首没有离线档案的歌照样有速度（正在播放那一路自测的），而那个速度正是
// 「接八小节」与「接五秒」的差别 —— 只问「有没有档案」会把 21 秒的音乐性混音
// 白白扔掉，换成一个 5 秒交叉淡化。

object TransitionStrategy {

    /** 该模式要不要为拍点网格付分析代价。crossfade 规划器不读速度，跑了也没人看。 */
    fun modeNeedsBeatGrid(mode: top.izuna.foliamajor.player.transition.TransitionMode): Boolean =
        mode == top.izuna.foliamajor.player.transition.TransitionMode.AUTOMIX

    /**
     * 三个独立的证据来源，任何一个都能把 automix 带到一个 crossfade 去不了的地方：
     * 任一侧档案、任何来源的速度、出场曲的歌词时间轴。
     */
    fun hasEvidence(ctx: ChoiceContext): Boolean =
        ctx.from?.hasEvidence == true
            || ctx.to?.hasEvidence == true
            || ctx.bpmLive != null
            || ctx.fromLyricLines > 0

    fun plan(ctx: ChoiceContext, nowMs: Long = System.currentTimeMillis()): TransitionPlan {
        val choice = StyleChooser.choose(ctx)
        val plan = TransitionPlanner.plan(choice, ctx, nowMs)
        // 表现模式是 automix 的修饰符，不是第三种模式：它只改强度，不改计划形状。
        // 这里不做任何二次改写，形状完全由规划器决定，避免「两处都在加手势」。
        return plan
    }

    /** 供设置页预览：不算真实换歌，带 preview 标记，不广播给 Remote。 */
    fun preview(ctx: ChoiceContext): TransitionPlan =
        plan(ctx).copy(cueId = "preview-${System.currentTimeMillis()}")
}
