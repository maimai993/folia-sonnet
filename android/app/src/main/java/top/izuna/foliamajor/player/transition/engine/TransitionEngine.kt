package top.izuna.foliamajor.player.transition.engine

import top.izuna.foliamajor.player.transition.TrackProfile
import top.izuna.foliamajor.player.transition.TransitionPlan
import top.izuna.foliamajor.player.transition.bridge.DeckControl

// android/app/src/main/java/top/izuna/foliamajor/player/transition/engine/TransitionEngine.kt
// 状态机 idle → armed → running → idle，以及每一步的撤销条件。
//
// 对应 Web 侧 automixSession.ts，但有一段关键差别：这里全部跑在播放器专用线程上，
// 不占 WebView 主线程，也不经过 Capacitor 桥的定时器 —— 20 ms 一拍的采样级调度在
// 原生侧没有掉帧问题，这是「强力」里精度那一半。
//
// 撤销条件对齐 Web 侧：seek、暂停、手动切歌、新的过渡抢占、播放源被替换。
// 每一次撤销都必须把额外播放器释放掉、把主播放器音量与速度还回去 ——
// 漏掉任何一样都会留下「两首歌同时响」或「一台 ExoPlayer 泄漏」。

class TransitionEngine(private val host: DeckControl) {

    enum class State(val wire: String) {
        IDLE("idle"), ARMED("armed"), RUNNING("running"),
    }

    companion object {
        /** 旧交叉淡化是 40 ms 一步；这里 20 ms，长斜坡不再有可闻台阶。 */
        private const val TICK_MS = 20L
        /** cue 不必每帧过桥，80 ms 一次足够动画插值，也不跟批量拉取抢桥。 */
        private const val CUE_INTERVAL_MS = 80L
    }

    @Volatile var state: State = State.IDLE
        private set

    private var plan: TransitionPlan? = null
    private var from: TrackProfile? = null
    private var to: TrackProfile? = null
    private var startWallMs = 0L
    private var lastCueElapsedMs = 0L
    private var tick: Runnable? = null

    /** 换歌前把计划装好。可以被新的 plan 覆盖（预取结果晚到时）。 */
    fun arm(newPlan: TransitionPlan, fromProfile: TrackProfile?, toProfile: TrackProfile?) {
        host.runOnPlayer(Runnable { armInternal(newPlan, fromProfile, toProfile) })
    }

    /** 立即按当前计划交接；返回 true 表示已受理（实际准备在播放器线程上完成）。 */
    fun start(url: String, mediaId: String?): Boolean {
        host.runOnPlayer(Runnable { startInternal(url, mediaId) })
        return true
    }

    fun cancel(reason: String) {
        host.runOnPlayer(Runnable { cancelInternal(reason) })
    }

    /** 播放链被外部打断时调用（seek / pause / 手动切歌 / 换源）。 */
    fun onPlaybackInterrupted(reason: String) {
        if (state == State.IDLE) return
        cancel(reason)
    }

    fun currentPlan(): TransitionPlan? = plan

    fun progressNow(): Float {
        val p = plan ?: return 0f
        if (state != State.RUNNING) return 0f
        val elapsed = host.nowMs() - startWallMs
        return (elapsed.toFloat() / p.overlapMs.coerceAtLeast(1)).coerceIn(0f, 1f)
    }

    // ---- 以下全部只在播放器线程上执行 ----

    private fun armInternal(newPlan: TransitionPlan, fromProfile: TrackProfile?, toProfile: TrackProfile?) {
        if (state == State.RUNNING) cancelInternal("新的过渡计划抢占")
        plan = newPlan
        from = fromProfile
        to = toProfile
        state = State.ARMED
        host.emitCue(
            TransitionCue(
                cueId = newPlan.cueId,
                phase = CuePhase.ARMED,
                style = newPlan.style.wire,
                // 不带整份 plan：引擎这一侧保持纯 Kotlin，JVM 单测不碰 org.json。
                // 需要完整字段时 Web 侧调 plan() / getSnapshot() 自己取。
                overlapMs = newPlan.overlapMs,
                reason = newPlan.reason,
            )
        )
    }

    private fun startInternal(url: String, mediaId: String?) {
        if (state == State.RUNNING) cancelInternal("新的交接抢占")
        val active = plan ?: TransitionPlan(reason = "未预置计划，按默认等功率交叉执行")
        plan = active
        if (!host.prepareHandover(url, mediaId, active.inStartMs)) {
            // 没有正在出声的歌 / 时长无效：不硬凑过渡，让调用方照旧 prepare + play。
            state = State.IDLE
            plan = null
            // 预检之后条件失效（这一瞬间被暂停 / 手动停了）时，交回普通换源 ——
            // 否则这首歌会静默地谁也没装。已经装上了才走这里的话，重复 prepare 是幂等的。
            runCatching { host.fallbackPrepare(url, mediaId) }
            host.emitCue(
                TransitionCue(
                    cueId = active.cueId, phase = CuePhase.FINISHED,
                    style = active.style.wire, overlapMs = active.overlapMs,
                    reason = "无交接条件（没有正在出声的歌），按普通换源",
                )
            )
            return
        }
        state = State.RUNNING
        startWallMs = host.nowMs()
        lastCueElapsedMs = -CUE_INTERVAL_MS
        host.emitCue(
            TransitionCue(
                    cueId = active.cueId, phase = CuePhase.STARTED,
                    style = active.style.wire,
                    overlapMs = active.overlapMs, reason = active.reason,
                )
        )
        tick = Runnable { tickInternal() }
        host.scheduleOnPlayer(TICK_MS, tick!!)
    }

    private fun tickInternal() {
        val active = plan
        if (state != State.RUNNING || active == null) return
        val elapsed = (host.nowMs() - startWallMs).coerceAtLeast(0L)
        val progress = (elapsed.toFloat() / active.overlapMs.coerceAtLeast(1)).coerceIn(0f, 1f)

        val frame = EffectFrame(
            progress = progress,
            elapsedMs = elapsed,
            totalMs = active.overlapMs,
            plan = active,
            from = from,
            to = to,
        )
        // 效果注册表的输出直接落到两台播放器 + DSP 链，中间不再过 JS。
        host.applyOutput(EffectRegistry.output(frame))

        if (elapsed - lastCueElapsedMs >= CUE_INTERVAL_MS) {
            host.emitCue(
                TransitionCue(
                    cueId = active.cueId, phase = CuePhase.PROGRESS,
                    style = active.style.wire, progress = progress,
                    overlapMs = active.overlapMs, elapsedMs = elapsed,
                )
            )
            lastCueElapsedMs = elapsed
        }

        if (progress >= 1f) {
            finishInternal(active)
        } else {
            host.scheduleOnPlayer(TICK_MS, tick!!)
        }
    }

    private fun finishInternal(active: TransitionPlan) {
        tick?.let { host.cancelOnPlayer(it) }
        tick = null
        // 终态钉死：进场满音量、出场静音、速度归位。
        host.applyOutput(EffectOutput(incomingGain = 1f, outgoingGain = 0f, tempoOut = 1f))
        host.finishHandover()
        host.restoreTempo()
        state = State.IDLE
        plan = null
        from = null
        to = null
        host.emitCue(
            TransitionCue(
                cueId = active.cueId, phase = CuePhase.FINISHED,
                style = active.style.wire, progress = 1f,
                overlapMs = active.overlapMs, elapsedMs = active.overlapMs.toLong(),
            )
        )
    }

    private fun cancelInternal(reason: String) {
        val active = plan
        tick?.let { host.cancelOnPlayer(it) }
        tick = null
        if (state == State.RUNNING) {
            host.abortHandover()
            host.restoreTempo()
        }
        state = State.IDLE
        plan = null
        from = null
        to = null
        if (active != null) {
            host.emitCue(
                TransitionCue(
                    cueId = active.cueId, phase = CuePhase.CANCELLED,
                    style = active.style.wire, overlapMs = active.overlapMs, reason = reason,
                )
            )
        }
    }
}
