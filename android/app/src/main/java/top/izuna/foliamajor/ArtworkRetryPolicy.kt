package top.izuna.foliamajor

// android/app/src/main/java/top/izuna/foliamajor/ArtworkRetryPolicy.kt
// 通知栏封面的重试退避与请求代次状态机（#348）。
//
// 原来最多试 4 次（2+4+8+16 = 30 秒）就永久放弃，久后台断网切歌后封面再也补不回来。
// 这里把退避封顶后持续排队，并由网络恢复回调与回前台入口把退避清零立即重拉；
// 同时用 generation 隔离切歌前的晚到结果，避免同专辑 URL 或快速切歌把新歌状态污染。
//
// **去重维度是 songKey，不是 URL**（#383 审查）。歌词 / 封面一起推的这几种 update 会带着
// 同一个签名 URL 反复到达（Web 层每一拍都推，签名 URL 还会整首周期性换一个）：
//   · 同歌同 URL 再推一次 —— 已经拿到过就什么都不做，不起请求、不查盘、不写盘；
//   · 同歌换了 URL —— 同样不再起请求，新地址留给下次切歌或回前台补拉；
//   · 切歌 —— 换一个 songKey，才允许重新拉；那一次命中磁盘缓存（断网 / 后台节流时的主路）
//     也算「这首歌已经有过封面」，之后同一条 update 再来照样跳过。
// 判断统一在 [artworkNeeded]：[beginRequest]、[beginScheduledRetry]、[recoverLocked]、
// [onExternalArtworkLoaded] 四个入口都走它，不再各拿 URL / hasLoadedArtwork 各判一套。

object ArtworkRetryPolicy {
    const val BASE_DELAY_MS = 2_000L
    const val MEDIUM_CAP_DELAY_MS = 60_000L
    const val LONG_IDLE_DELAY_MS = 300_000L
    const val MEDIUM_CAP_UNTIL_ATTEMPT = 10
    const val NETWORK_RECOVERY_MIN_GAP_MS = 1_500L

    fun isLocalOnlyUrl(url: String?): Boolean =
        url.isNullOrBlank() ||
            url.startsWith("blob:", ignoreCase = true) ||
            url.startsWith("data:", ignoreCase = true)

    /**
     * 计算第 [retryAttempt] 次失败后下一次重试的等待毫秒数。
     * 0..4 -> 2s, 4s, 8s, 16s, 32s；5..9 -> 60s；10+ -> 300s（永不彻底放弃，长时间离线低功耗）。
     */
    fun nextDelayMs(retryAttempt: Int): Long {
        if (retryAttempt <= 0) return BASE_DELAY_MS
        if (retryAttempt >= MEDIUM_CAP_UNTIL_ATTEMPT) return LONG_IDLE_DELAY_MS
        // 左移 n 位即乘以 2^n；先限制位数，再把毫秒数封顶到 60 秒。
        val scaled = BASE_DELAY_MS shl retryAttempt.coerceAtMost(5)
        return scaled.coerceAtMost(MEDIUM_CAP_DELAY_MS)
    }
}

class ArtworkFetchTracker(
    private val clockMs: () -> Long = { System.currentTimeMillis() },
) {
    data class FetchRequest(val url: String, val generation: Long)
    data class RetryPlan(val url: String, val generation: Long, val attemptNumber: Int, val delayMs: Long)

    /**
     * 请求所属的那首歌：Web 层给的 songKey，拿不到（老 Web 层 / 本地歌）时退回地址本身。
     *
     * 去重、代次、退避、恢复全都按它走；同歌的不同签名 URL 归到同一个身份上。
     */
    private class SongIdentity private constructor(val songKey: String?, val token: String) {
        companion object {
            fun of(songKey: String?, url: String): SongIdentity {
                val key = songKey?.takeIf { it.isNotBlank() }
                return SongIdentity(key, key ?: "url:$url")
            }
        }
    }

    private var generation = 0L
    /** 当前这首歌的身份与它此刻的封面地址。[identity] 为 null = 还没有过任何一次 update。 */
    private var identity: SongIdentity? = null
    private var currentUrl: String? = null
    /** 这首歌**是否已经有封面**（下载成功 / 磁盘缓存命中 / Web 层直接给了 base64 都算）。 */
    private var hasArtwork = false
    private var inFlightToken: String? = null
    private var retryAttempt = 0
    private var lastAttemptAtMs = 0L
    private val permanentlyFailedUrls = LinkedHashSet<String>()

    /**
     * 换歌。
     *
     * 同一个 songKey 再来时**什么都不重置** —— 那只是同一首的又一次 metadata update
     * （重推、签名 URL 轮换、歌词回来后的重推），已经拿到的封面和退避进度都该保留。
     */
    @Synchronized
    fun onSongChanged(songKey: String? = null) {
        val next = SongIdentity.of(songKey, "")
        if (identity != null && next.songKey != null && next.token == identity?.token) return
        generation++
        identity = if (next.songKey == null) null else next
        currentUrl = null
        hasArtwork = false
        inFlightToken = null
        retryAttempt = 0
        lastAttemptAtMs = 0L
    }

    /**
     * 这一首已经有封面了（下载成功、磁盘命中，或 Web 层直接给了 base64）。
     *
     * 传了 [songKey] 时只认当前这一首：上一首晚到的结果不能把它记成「已有封面」。
     * 传 null（Web 层直接给 base64、但没带 songKey 的老路径）按当前这一首处理。
     */
    @Synchronized
    fun onExternalArtworkLoaded(songKey: String? = null) {
        if (songKey != null && songKey != identity?.songKey) return
        hasArtwork = true
        inFlightToken = null
    }

    @Synchronized
    fun isPermanentlyFailed(url: String?): Boolean =
        url != null && permanentlyFailedUrls.contains(url)

    @Synchronized
    fun snapshotArtworkUrl(): String = currentUrl ?: ""

    @Synchronized
    fun currentGeneration(): Long = generation

    /**
     * 这一次 update 要不要为 [songKey] 起一个请求；不需求时**一个副作用都不留**
     * （不记 URL、不占在途标记），所以同一条 update 再来多少次都是空转返回。
     */
    @Synchronized
    fun beginRequest(url: String?, songKey: String?): FetchRequest? {
        if (ArtworkRetryPolicy.isLocalOnlyUrl(url)) return null
        val target = url!!
        val next = SongIdentity.of(songKey, target)
        if (identity?.token != next.token) {
            generation++
            identity = next
            currentUrl = target
            hasArtwork = false
            inFlightToken = null
            retryAttempt = 0
            lastAttemptAtMs = 0L
        }
        if (!artworkNeeded(next, target)) return null
        currentUrl = target
        inFlightToken = next.token
        retryAttempt = 0
        lastAttemptAtMs = clockMs()
        return FetchRequest(target, generation)
    }

    @Synchronized
    fun beginScheduledRetry(plan: RetryPlan): FetchRequest? {
        if (plan.generation != generation) return null
        val next = identity ?: return null
        if (!artworkNeeded(next, plan.url)) return null
        val target = currentUrl ?: plan.url
        if (target != plan.url) return null
        inFlightToken = next.token
        lastAttemptAtMs = clockMs()
        return FetchRequest(plan.url, generation)
    }

    @Synchronized
    fun canRecoverOnNetwork(): FetchRequest? = recoverLocked(respectMinGap = true)

    @Synchronized
    fun canRecoverOnForeground(): FetchRequest? = recoverLocked(respectMinGap = false)

    private fun recoverLocked(respectMinGap: Boolean): FetchRequest? {
        val url = currentUrl ?: return null
        val next = identity ?: return null
        if (!artworkNeeded(next, url)) return null
        if (respectMinGap && lastAttemptAtMs > 0L) {
            val elapsed = clockMs() - lastAttemptAtMs
            if (elapsed in 0 until ArtworkRetryPolicy.NETWORK_RECOVERY_MIN_GAP_MS) return null
        }
        retryAttempt = 0
        inFlightToken = next.token
        lastAttemptAtMs = clockMs()
        return FetchRequest(url, generation)
    }

    /**
     * 唯一的判定：这一首还缺封面、也没有请求在途、地址不是本地协议、不是永久失败。
     *
     * 不看 URL 是不是同一个 —— 同歌换了签名 URL 也不重拉，理由见文件头。
     */
    private fun artworkNeeded(next: SongIdentity, url: String): Boolean {
        if (hasArtwork) return false
        if (inFlightToken == next.token) return false
        if (ArtworkRetryPolicy.isLocalOnlyUrl(url)) return false
        if (permanentlyFailedUrls.contains(url)) return false
        return true
    }

    @Synchronized
    fun onFetchSucceeded(request: FetchRequest): Boolean {
        if (request.generation != generation) return false
        inFlightToken = null
        hasArtwork = true
        retryAttempt = 0
        return true
    }

    @Synchronized
    fun onFetchPermanentFailure(request: FetchRequest): Boolean {
        recordPermanentFailure(request.url)
        if (request.generation != generation) return false
        inFlightToken = null
        return true
    }

    @Synchronized
    fun onFetchTransientFailure(request: FetchRequest): RetryPlan? {
        if (request.generation != generation) return null
        inFlightToken = null
        if (hasArtwork) return null
        val delay = ArtworkRetryPolicy.nextDelayMs(retryAttempt)
        retryAttempt++
        return RetryPlan(request.url, request.generation, retryAttempt, delay)
    }

    private fun recordPermanentFailure(url: String) {
        if (permanentlyFailedUrls.contains(url)) return
        if (permanentlyFailedUrls.size >= MAX_PERMANENT_FAILURES) {
            val oldest = permanentlyFailedUrls.iterator().next()
            permanentlyFailedUrls.remove(oldest)
        }
        permanentlyFailedUrls.add(url)
    }

    companion object {
        private const val MAX_PERMANENT_FAILURES = 64
    }
}
