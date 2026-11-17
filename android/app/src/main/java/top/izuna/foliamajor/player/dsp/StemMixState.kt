package top.izuna.foliamajor.player.dsp

import java.io.File

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/StemMixState.kt
// 空间声场的共享状态：桥线程写、音频渲染线程读，只有一个 volatile 引用。
//
// 为什么单开一个而不是塞进 NativeEqualizerState：那个对象管的是「调音链的参数」，
// 这里管的是「这首歌的四轨文件与摆位」。两者生命周期不同 —— 空间声场还依赖
// StemStore 里的文件是否就绪，而 NativeEqualizerState 只认 JSON 载荷。

/** 一首歌的四轨文件，下标与 [StemKind.ordinal] 对齐；缺的轨为 null。 */
data class StemSongState(
    val songKey: String,
    val stems: Array<File?>,
    val ready: Boolean,
)

/** 音频线程每块读一次的会话快照。 */
data class StemMixSession(
    val songKey: String,
    val stems: Array<File?>,
    val spatial: SpatialSettings,
)

object StemMixState {

    @Volatile private var spatial: SpatialSettings? = null
    @Volatile private var song: StemSongState? = null

    /** 插件 seek 之后写进来的目标帧数（44.1k 时间轴）；-1 表示没有待处理的 seek。 */
    @Volatile private var pendingSeekFrames: Long = -1L

    /** 最近一次真正应用进解码器的 seek 帧数。 */
    @Volatile private var lastSeekFrames: Long = 0L

    fun snapshot(): StemMixSession? {
        val s = spatial ?: return null
        val current = song ?: return null
        if (!s.enabled || !current.ready) return null
        return StemMixSession(current.songKey, current.stems, s)
    }

    fun publishSpatial(next: SpatialSettings?) {
        spatial = next
    }

    fun publishSong(next: StemSongState?) {
        song = next
        if (next == null) {
            pendingSeekFrames = -1L
            lastSeekFrames = 0L
        }
    }

    fun requestSeek(frames: Long) {
        pendingSeekFrames = frames.coerceAtLeast(0L)
    }

    /** 音频线程在开解码器之前调：把待处理的 seek 落成 lastSeekFrames。 */
    fun consumeSeek() {
        if (pendingSeekFrames >= 0L) {
            lastSeekFrames = pendingSeekFrames
            pendingSeekFrames = -1L
        }
    }

    fun lastSeekFrames(): Long = lastSeekFrames

    fun hasPendingSeek(): Boolean = pendingSeekFrames >= 0L

    fun clear() {
        spatial = null
        song = null
        pendingSeekFrames = -1L
        lastSeekFrames = 0L
    }
}
