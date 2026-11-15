package top.izuna.foliamajor.player

// 桌面歌词显示锚点的纯判定：播放器采样值什么时候该写进 WallpaperLyricsState（可在 JVM 单测里直接跑）。

/** 采样值与外推值之差在这个范围内视为「外推是准的」，与播放器上报位置的周期一致。 */
internal const val DISPLAY_ANCHOR_TOLERANCE_MS = 250L

/**
 * 这一拍要不要把播放器的位置 / 播停写进显示锚点。
 *
 * 只有「位置差在一个采样周期内」**并且**「快照的播 / 停与播放器一致」才算没有新信息。
 * 漏掉第二条的话，快照被别处写成 playing=false 之后（换歌那一刻的缓冲态、Web 冻结前
 * 推来的旧状态），位置一直对得上就一直不写 —— 而 playing=false 时外推冻住，
 * 三处桌面歌词都停在原地，只有拖一下进度条（setSeekAnchor 连 playing 一起写）才救得回来。
 */
internal fun displayAnchorNeedsWrite(
    snapshotPlaying: Boolean,
    snapshotPositionMs: Long,
    playerPlaying: Boolean,
    playerPositionMs: Long,
): Boolean {
    if (snapshotPlaying != playerPlaying) return true
    val gap = snapshotPositionMs - playerPositionMs
    return gap >= DISPLAY_ANCHOR_TOLERANCE_MS || gap <= -DISPLAY_ANCHOR_TOLERANCE_MS
}

/**
 * 播放器此刻算不算「在出声」，供显示锚点用。
 *
 * isPlaying 是 ExoPlayer 在播放器线程上的真值；缓冲标记是事件驱动的缓存，
 * 只要真值说在播，就不再让一个没被清掉的缓冲标记把它压成「暂停」。
 */
internal fun playerAudible(isPlaying: Boolean, buffering: Boolean): Boolean {
    return isPlaying && !buffering
}

/** 外推的上限：比后台最慢的采样周期（1 秒）宽一点，超过就说明采样停了，不再猜。 */
internal const val DISPLAY_POSITION_EXTRAPOLATE_MAX_MS = 1_500L

/**
 * 叠层核对要的「此刻」位置（#320）。
 *
 * 缓存位置是上一拍采样的值：App 在后台时一秒才采一次，拿它直接当锚点就是往回拽最多 1 秒，
 * 每 3 秒一次的核对因此每次都越过 250ms 容差、把桌面歌词往回抽一下。
 * 在出声时按采样之后过去的墙钟补上（乘倍速）；没在出声、没有采样时刻、或缓存已被
 * seek / 换源改写（sampleAtMs 传 0）时原样返回缓存值。
 */
internal fun extrapolatedDisplayPositionMs(
    cachedPositionMs: Long,
    sampleAtMs: Long,
    nowMs: Long,
    audible: Boolean,
    speed: Float,
): Long {
    if (!audible || sampleAtMs <= 0L) return cachedPositionMs
    val elapsed = (nowMs - sampleAtMs).coerceIn(0L, DISPLAY_POSITION_EXTRAPOLATE_MAX_MS)
    return cachedPositionMs + (elapsed * speed).toLong()
}
