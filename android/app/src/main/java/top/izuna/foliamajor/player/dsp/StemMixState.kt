package top.izuna.foliamajor.player.dsp

import java.io.File

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/StemMixState.kt
// 四轨混音的共享状态：桥线程写、音频渲染线程读，只有一个 volatile 引用。
//
// 为什么单开一个而不是塞进 NativeEqualizerState：那个对象管的是「调音链的参数」，
// 这里管的是「这首歌的四轨文件与摆位」。两者生命周期不同 —— 四轨还依赖
// InstrumentalStore 里的文件是否就绪，而 NativeEqualizerState 只认 JSON 载荷。

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
)

object StemMixState {

    @Volatile private var song: StemSongState? = null

    /**
     * 四轨的摆位设置。现在只有 NEUTRAL（原样、全响）：逐轨摆位的界面属于调音台那半，
     * 本改动不带。留这一层指针，播放端不用跟着「有没有设置」分叉。
     */
    @Volatile private var mixSettings: StemMixSettings = StemMixSettings.NEUTRAL

    /** 插件 seek 之后写进来的目标帧数（44.1k 时间轴）；-1 表示没有待处理的 seek。 */
    @Volatile private var pendingSeekFrames: Long = -1L

    /** 最近一次真正应用进解码器的 seek 帧数。 */
    @Volatile private var lastSeekFrames: Long = 0L

    /**
     * 这一块该拿出去混的会话；null 表示「这首歌没有可用的四轨」。
     *
     * 只要求四轨齐了 —— 具体「要不要混」由 [StemMixProcessor.resolve] 按播放模式
     * 判断（没开「关闭人声 / 只留人声」时走原曲）。
     */
    fun snapshot(): StemMixSession? {
        val current = song ?: return null
        if (!current.ready) return null
        return StemMixSession(current.songKey, current.stems)
    }

    fun settings(): StemMixSettings = mixSettings

    fun publishSettings(next: StemMixSettings) {
        mixSettings = next
    }

    fun publishSong(next: StemSongState?) {
        /*
         * 换歌必须重置 seek 状态：不重置的话，上一首 seek 到 2:00 之后切歌，
         * 新歌的四轨解码器会从 2:00 起播，与 ExoPlayer 时钟整首错位。
         */
        val songChanged = next?.songKey != song?.songKey
        song = next
        if (next == null || songChanged) {
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
        song = null
        pendingSeekFrames = -1L
        lastSeekFrames = 0L
    }}
