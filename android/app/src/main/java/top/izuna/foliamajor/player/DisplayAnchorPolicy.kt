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

/**
 * 这一刻的「没在出声」是不是**播放意图还在、只是在等数据**（缓冲 / 欠载 / 换源那一下）。
 *
 * 桌面歌词拿它区分两种 playing=false（#314）：用户暂停该按「暂停时隐藏」收起；等数据不该 ——
 * 网络一卡就把叠层淡出、缓冲完再淡回来，用户看到的是「动画停住，然后整层消失」。
 *
 * 判据是播放器自己的三个真值，不看事件驱动的缓冲缓存（那份会漏清，见 [playerAudible]）：
 * 要求播着（playWhenReady）、状态机停在 BUFFERING、而此刻没有出声。IDLE（出错 / 没装源）
 * 与 ENDED 都不算 —— 那两种不会自己好起来，照旧按暂停收起。
 */
internal fun playerStalled(playWhenReady: Boolean, bufferingState: Boolean, isPlaying: Boolean): Boolean {
    return playWhenReady && bufferingState && !isPlaying
}

/**
 * 播放器事件写显示锚点时的 playing 取值（#314）。
 *
 * paused / playing 本身就是结论：pause() 是先发 paused、后 setPlayWhenReady(false) 的，那一刻播放器真值还是 true。
 * 其余事件（ready / seeked / position）只认播放器线程上的实时 isPlaying：READY 只表示有可播放源，
 * 不表示出声；不能读 play() 乐观写的 cachedPlaying，否则尚未出声就被写成 playing=true。
 */
internal fun anchorPlayingForEvent(type: String, playerIsPlayingNow: Boolean): Boolean {
    return when (type) {
        "paused" -> false
        "playing" -> true
        else -> playerIsPlayingNow
    }
}
