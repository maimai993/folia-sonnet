package top.izuna.foliamajor.player.transition.bridge

// android/app/src/main/java/top/izuna/foliamajor/player/transition/bridge/TransitionDeckHost.kt
// FoliaNativePlayer 需要向过渡系统提供的最小能力集合。
//
// 由 FoliaNativePlayer 的**内部类**实现（见该文件的 TransitionDeck），因为 begin / apply /
// finish / abort 都要碰 player、crossfadeOutgoing、playerListener 这些 private 字段。
// 过渡系统这一侧只认接口，不 import ExoPlayer —— 于是 JVM 单测可以用假 Host 跑完整状态机。

interface TransitionDeckHost {

    fun runOnPlayer(action: Runnable)
    fun scheduleOnPlayer(delayMs: Long, action: Runnable)
    fun cancelOnPlayer(action: Runnable)
    fun nowMs(): Long

    /**
     * 现在能不能交接：正在出声、手上有歌、时长有效。
     * 只读 volatile 缓存，任何线程都能问 —— 调用方据此决定「走过渡」还是「老实换源」。
     */
    fun canHandover(): Boolean

    /** 起一台额外播放器装新源、把主指针指过去；旧的那台留作出场。false = 没得交接。 */
    fun begin(url: String, mediaId: String?, startMs: Long): Boolean

    /**
     * 交接判据在预检之后失效时的兜底：照普通换源装上去，别让这首歌彻底不出声。
     * 只会被 startInternal 的失败分支调用。
     */
    fun fallbackPrepare(url: String, mediaId: String?)

    /** 一帧：两台播放器的音量 + 出场曲的速度。调用方已保证在播放器线程。 */
    fun apply(incomingGain: Float, outgoingGain: Float, tempoOut: Float)

    /** 斜坡跑完：释放旧播放器，把新播放器扶正。 */
    fun finish()

    /** 交接被撤销：释放新播放器，把旧播放器扶正并恢复音量 / 速度。 */
    fun abort()

    fun positionMs(): Long
    fun isPlaying(): Boolean
}
