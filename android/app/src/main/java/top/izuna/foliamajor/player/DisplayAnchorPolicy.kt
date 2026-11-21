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

/** 外推的上限：比后台最慢的采样周期（1 秒）宽一点，超过就说明采样停了，不再猜。 */
internal const val DISPLAY_POSITION_EXTRAPOLATE_MAX_MS = 1_500L

// ===== 原生 seek 的回弹守卫（#H9） =====
//
// ExoPlayer 的 seek 是异步的：seekTo 之后、真正落位之前，播放循环里可能先报出一条
// onPositionDiscontinuity（换成非自有 seek 那一下，旧位置被当成新位置报出来），而插件对
// 「seeked」的规则是**一律照写**锚点。锚点一被写回旧位置，壁纸 / 悬浮窗 / 锁屏的歌词就往回
// 跳一行再追回来 —— 正是用户报的「拖动之后歌词回弹」。
//
// 修法是两阶段：发起 seek 时打开守卫窗，**播放器确认落位时关**（不靠固定墙钟）。
// 窗内到达的位置跳变，只要与目标位置差在锚点写入容差之内，就认为「这就是这次 seek 的落位」；
// 差得远的一律不写锚点。窗过期（播放器崩在缓冲里、根本没落位）之后照旧写，别把守卫变成永久静音。

/**
 * 守卫窗在「播放器报告的新位置等于目标位置」之后再撑多久。
 *
 * 一次 seek 会连着报若干条不连续（落位一条、缓冲状态变化又一条），后面那条同样是旧位置。
 * 撑一小段把这几条一起盖住，同时保证真的有下一首 seek 时窗口会被重新打开。
 */
internal const val NATIVE_SEEK_GUARD_HOLD_MS = 500L

/**
 * 守卫窗在「播放器始终没报告目标位置」时的上限。
 *
 * 正常一次 seek 在这里面一定落位（本地文件几十毫秒，网络流一次重缓冲通常一两秒）。超过它
 * 还没落位，说明这一下要么失败、要么早就落位却报了个差一点的值 —— 那时候不放行就等于
 * 让歌词停住，宁可放行。
 */
internal const val NATIVE_SEEK_GUARD_MAX_MS = 4_000L

/** 一次原生 seek 的守卫状态。[armed] 之前写过什么无关紧要，过期由 [armedAtMs] 判。 */
internal data class NativeSeekGuard(
    val armed: Boolean,
    val armedAtMs: Long,
    val targetMs: Long,
    /** 播放器已经报告过目标位置：之后再撑 [NATIVE_SEEK_GUARD_HOLD_MS] 就关。 */
    val confirmed: Boolean,
)

internal val NATIVE_SEEK_GUARD_IDLE = NativeSeekGuard(armed = false, armedAtMs = 0L, targetMs = 0L, confirmed = false)

/** 发起一次原生 seek（或 Web 回声那一下）：窗口从这一刻重新计时，目标就是这次要去的位置。 */
internal fun armNativeSeekGuard(targetMs: Long, nowMs: Long): NativeSeekGuard =
    NativeSeekGuard(armed = true, armedAtMs = nowMs, targetMs = targetMs, confirmed = false)

/**
 * 窗内收到一条位置跳变，判断这次 `seeked` 的锚点该不该写。
 *
 * @param positionMs 播放器报告的新位置。
 * @return 该写的值；null 表示「这一条不写锚点」（位置丢弃，playing 照收 —— 那是独立的事实）。
 */
internal fun seekGuardVerdict(guard: NativeSeekGuard, positionMs: Long, nowMs: Long): Long? {
    if (!guard.armed) return positionMs
    val elapsed = nowMs - guard.armedAtMs
    // 时钟倒退按过期处理：宁可写一次，也不要因为一个坏钟把守卫永久挂住。
    if (elapsed < 0L || elapsed > NATIVE_SEEK_GUARD_MAX_MS) return positionMs
    val gap = kotlin.math.abs(positionMs - guard.targetMs)
    return if (gap <= DISPLAY_ANCHOR_TOLERANCE_MS) positionMs else null
}

/** 收到一条跳变之后守卫该变成什么样：落位确认了就进入收尾期，没确认就继续等。 */
internal fun advanceNativeSeekGuard(guard: NativeSeekGuard, positionMs: Long, nowMs: Long): NativeSeekGuard {
    if (!guard.armed) return guard
    val elapsed = nowMs - guard.armedAtMs
    if (elapsed < 0L || elapsed > NATIVE_SEEK_GUARD_MAX_MS) return NATIVE_SEEK_GUARD_IDLE
    val atTarget = kotlin.math.abs(positionMs - guard.targetMs) <= DISPLAY_ANCHOR_TOLERANCE_MS
    if (!atTarget) return if (guard.confirmed) NATIVE_SEEK_GUARD_IDLE else guard
    // 已经落位：从这一刻起再撑一段，把紧跟着的旧位置那几条一起盖住。
    return if (guard.confirmed) NATIVE_SEEK_GUARD_IDLE else guard.copy(confirmed = true, armedAtMs = nowMs)
}

/** 守卫还该不该挡（诊断 / 日志用）。 */
internal fun nativeSeekGuardActive(guard: NativeSeekGuard, nowMs: Long): Boolean {
    if (!guard.armed) return false
    val elapsed = nowMs - guard.armedAtMs
    return elapsed in 0L..NATIVE_SEEK_GUARD_MAX_MS
}

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
