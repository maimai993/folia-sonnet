package top.izuna.foliamajor.player.transition.bridge

import android.os.SystemClock
import top.izuna.foliamajor.player.transition.dsp.TransitionDspState
import top.izuna.foliamajor.player.transition.engine.EffectOutput
import top.izuna.foliamajor.player.transition.engine.TransitionCue

// android/app/src/main/java/top/izuna/foliamajor/player/transition/bridge/NativeDeckControl.kt
// DeckControl 的真机实现：把引擎的一帧输出拆成「播放器那一半」和「DSP 那一半」。
// 这里不碰 ExoPlayer，也不碰线程 —— 全部委托给 TransitionDeckHost。

class NativeDeckControl(
    private val hostProvider: () -> TransitionDeckHost?,
) : DeckControl {

    private fun host(): TransitionDeckHost? = hostProvider()

    override fun runOnPlayer(action: Runnable) {
        val h = host()
        if (h != null) h.runOnPlayer(action) else action.run()
    }

    override fun scheduleOnPlayer(delayMs: Long, action: Runnable) {
        val h = host()
        if (h != null) h.scheduleOnPlayer(delayMs, action) else Unit
    }

    override fun cancelOnPlayer(action: Runnable) {
        host()?.cancelOnPlayer(action)
    }

    override fun nowMs(): Long = SystemClock.elapsedRealtime()

    override fun applyOutput(output: EffectOutput) {
        // DSP 状态是 volatile，音频渲染线程自己来读；这里不需要过播放器线程。
        TransitionDspState.publish(output.takeIf { it.needsDsp })
        host()?.apply(output.incomingGain, output.outgoingGain, output.tempoOut)
    }

    override fun canHandover(): Boolean = host()?.canHandover() ?: false

    override fun prepareHandover(url: String, mediaId: String?, startMs: Long): Boolean =
        host()?.begin(url, mediaId, startMs) ?: false

    override fun fallbackPrepare(url: String, mediaId: String?) {
        host()?.fallbackPrepare(url, mediaId)
    }

    override fun finishHandover() {
        TransitionDspState.clear()
        host()?.finish()
    }

    override fun abortHandover() {
        TransitionDspState.clear()
        host()?.abort()
    }

    override fun restoreTempo() {
        host()?.apply(1f, 0f, 1f)
    }

    override fun positionMs(): Long = host()?.positionMs() ?: 0L

    override fun isPlaying(): Boolean = host()?.isPlaying() ?: false

    override fun emitCue(cue: TransitionCue) {
        TransitionRuntime.publishCue(cue)
    }
}
