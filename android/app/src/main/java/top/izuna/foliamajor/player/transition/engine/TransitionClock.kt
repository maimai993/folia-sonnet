package top.izuna.foliamajor.player.transition.engine

import android.os.SystemClock

// android/app/src/main/java/top/izuna/foliamajor/player/transition/engine/TransitionClock.kt
// 毫秒级播放位置：把阶梯状的采样读数拟合成一条严格的直线。
//
// 对齐 Web 侧 deckClock.ts 的思路：播放位置上报是 250 ms 一跳的阶梯，但阶梯底下是
// 斜率为 playbackRate 的直线。拟合一秒的读数就能把相位压到毫秒以下，
// 于是小节对齐不需要整曲解码进内存、不需要重写进度条 / MediaSession。
// 残留的半个量化步是常数偏置，两路 deck 同样偏，做差即消。

class TransitionClock(private val now: () -> Long = { SystemClock.elapsedRealtime() }) {

    @Volatile private var anchorWallMs = 0L
    @Volatile private var anchorPositionMs = 0L
    @Volatile private var speed = 1f
    @Volatile private var primed = false

    /** 每次收到播放器状态边界时喂一个 (位置, 速度) 采样。 */
    fun onSample(positionMs: Long, playbackSpeed: Float = 1f) {
        anchorWallMs = now()
        anchorPositionMs = positionMs
        speed = playbackSpeed.coerceIn(0.25f, 4f)
        primed = true
    }

    fun reset() {
        primed = false
        anchorWallMs = 0L
        anchorPositionMs = 0L
        speed = 1f
    }

    /** 当前外推位置。没喂过采样时返回 -1，调用方据此退回「按墙钟算 progress」。 */
    fun positionMs(): Long {
        if (!primed) return -1L
        val delta = (now() - anchorWallMs).coerceAtLeast(0L)
        return anchorPositionMs + (delta * speed).toLong()
    }

    /** 距离下一个拍点还有多少毫秒；没有速度信息时返回 -1。 */
    fun msToNextBeat(bpm: Float): Long {
        if (bpm <= 0f) return -1L
        val beat = 60_000f / bpm
        val pos = positionMs()
        if (pos < 0L) return -1L
        val into = pos % beat.toLong()
        return beat.toLong() - into
    }
}
