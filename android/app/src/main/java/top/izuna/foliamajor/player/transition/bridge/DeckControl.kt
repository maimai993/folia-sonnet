package top.izuna.foliamajor.player.transition.bridge

import top.izuna.foliamajor.player.transition.engine.EffectOutput
import top.izuna.foliamajor.player.transition.engine.TransitionCue

// android/app/src/main/java/top/izuna/foliamajor/player/transition/bridge/DeckControl.kt
// 执行层与 ExoPlayer 之间唯一的接缝。
//
// 存在的理由：FoliaNativePlayer 把所有播放器操作钉在自己的 playerLooper 上（见文件头
// 「线程」那一节），而过渡引擎不该知道 ExoPlayer、HandlerThread、Looper 这些细节。
// 由 FoliaNativePlayer 内部实现这个接口，把「回到播放器线程」这件事包在
// runOnPlayer / scheduleOnPlayer 里，引擎就只是纯状态机，能在 JVM 单测里用假实现跑。

interface DeckControl {

    /** 保证 [action] 在播放器专用线程上执行。 */
    fun runOnPlayer(action: Runnable)
    fun scheduleOnPlayer(delayMs: Long, action: Runnable)
    fun cancelOnPlayer(action: Runnable)
    fun nowMs(): Long

    /** 把一帧效果状态应用到两台播放器与 DSP 链。调用方已保证在播放器线程。 */
    fun applyOutput(output: EffectOutput)

    /** 是否具备交接条件（正在出声 / 有歌 / 时长有效）。同步、无副作用。 */
    fun canHandover(): Boolean

    /** 起一台额外播放器装新源、挂监听、音量置 0；返回 false 表示没得交接。 */
    fun prepareHandover(url: String, mediaId: String?, startMs: Long): Boolean

    /** 预检通过但真正交接时条件已失效：退回普通换源，避免这一首彻底不出声。 */
    fun fallbackPrepare(url: String, mediaId: String?)

    /** 斜坡跑完：停掉并释放旧播放器，把新播放器扶正。 */
    fun finishHandover()

    /** 交接被撤销：释放额外播放器、恢复主播放器音量与速度。 */
    fun abortHandover()

    fun restoreTempo()
    fun positionMs(): Long
    fun isPlaying(): Boolean

    /** cue 广播：UI 动画 / Remote 快照据此与音频跨度对齐。 */
    fun emitCue(cue: TransitionCue)
}
