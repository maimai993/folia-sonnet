package top.izuna.foliamajor.wallpaper

// 「播放器在等数据」这段时间的记账：桌面歌词据此不把缓冲当成暂停收起（#314）。纯逻辑，可在 JVM 单测里直接跑。

/**
 * 等数据最多替叠层撑多久。
 *
 * 缓冲一般几秒就过去；但连接可能一直「滴」着不报错（播放器停在 BUFFERING、既不恢复也不出错），
 * 那时不能让一张静止的画面无限期盖在桌面上。超过这个时长就不再豁免，照旧按「暂停时隐藏」收起，
 * 恢复出声时叠层自己会回来。
 */
internal const val STALL_HOLD_MAX_MS = 15_000L

/** 一段「等数据」从什么时候开始、现在还算不算数。时间由调用方给（单调时钟，毫秒）。 */
internal class StallHold(private val maxMs: Long = STALL_HOLD_MAX_MS) {
    private var stalled = false
    private var sinceMs = 0L

    /**
     * 报一次播放器此刻是不是在等数据。
     *
     * 连着报 true 不会把起点往后挪 —— 否则位置刻度每报一次，上限就跟着顺延一次，等于没有上限。
     *
     * @return 这一次让状态翻了面就返回 true（调用方据此只在翻面时记日志）。
     */
    @Synchronized
    fun update(nowStalled: Boolean, nowMs: Long): Boolean {
        if (nowStalled == stalled) return false
        stalled = nowStalled
        sinceMs = nowMs
        return true
    }

    /** 正在等数据、而且还没超过上限：这段时间的 playing=false 不是暂停。 */
    @Synchronized
    fun held(nowMs: Long): Boolean {
        return stalled && nowMs - sinceMs in 0..maxMs
    }

    /** 还在等数据，但已经超过上限（收起理由里要能说清是这一条）。 */
    @Synchronized
    fun expired(nowMs: Long): Boolean {
        return stalled && !(nowMs - sinceMs in 0..maxMs)
    }

    /** 这一段（或刚结束的上一段）状态已经持续了多久，给日志用。 */
    @Synchronized
    fun elapsedMs(nowMs: Long): Long {
        return nowMs - sinceMs
    }
}
