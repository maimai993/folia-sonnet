package top.izuna.foliamajor

// android/app/src/main/java/top/izuna/foliamajor/ArtworkRetryPolicy.kt
// 通知栏封面的重试退避与请求代次状态机（#348）。
//
// 原来最多试 4 次（2+4+8+16 = 30 秒）就永久放弃，久后台断网切歌后封面再也补不回来。
// 这里把退避封顶后持续排队，并由网络恢复回调与回前台入口把退避清零立即重拉；
// 同时用 generation 隔离切歌前的晚到结果，避免同专辑 URL 或快速切歌把新歌状态污染。

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
        val scaled = BASE_DELAY_MS shl retryAttempt.coerceAtMost(5)
        return scaled.coerceAtMost(MEDIUM_CAP_DELAY_MS)
    }
}

class ArtworkFetchTracker(
    private val clockMs: () -> Long = { System.currentTimeMillis() },
) {
    data class FetchRequest(val url: String, val generation: Long)
    data class RetryPlan(val url: String, val generation: Long, val attemptNumber: Int, val delayMs: Long)

    private var generation = 0L
    private var currentUrl: String? = null
    private var inFlightUrl: String? = null
    private var hasLoadedArtwork = false
    private var retryAttempt = 0
    private var lastAttemptAtMs = 0L
    private val permanentlyFailedUrls = LinkedHashSet<String>()

    @Synchronized
    fun onSongChanged() {
        generation++
        currentUrl = null
        inFlightUrl = null
        hasLoadedArtwork = false
        retryAttempt = 0
        lastAttemptAtMs = 0L
    }

    @Synchronized
    fun onExternalArtworkLoaded() {
        hasLoadedArtwork = true
    }

    @Synchronized
    fun isPermanentlyFailed(url: String?): Boolean =
        url != null && permanentlyFailedUrls.contains(url)

    @Synchronized
    fun snapshotArtworkUrl(): String = currentUrl ?: ""

    @Synchronized
    fun currentGeneration(): Long = generation

    @Synchronized
    fun beginRequest(url: String?): FetchRequest? {
        if (ArtworkRetryPolicy.isLocalOnlyUrl(url)) return null
        val target = url!!
        if (permanentlyFailedUrls.contains(target)) return null
        if (inFlightUrl == target) return null
        if (hasLoadedArtwork && currentUrl == target) return null
        currentUrl = target
        inFlightUrl = target
        retryAttempt = 0
        lastAttemptAtMs = clockMs()
        return FetchRequest(target, generation)
    }

    @Synchronized
    fun beginScheduledRetry(plan: RetryPlan): FetchRequest? {
        if (plan.generation != generation) return null
        if (hasLoadedArtwork || inFlightUrl != null || currentUrl != plan.url) return null
        if (permanentlyFailedUrls.contains(plan.url)) return null
        inFlightUrl = plan.url
        lastAttemptAtMs = clockMs()
        return FetchRequest(plan.url, generation)
    }

    @Synchronized
    fun canRecoverOnNetwork(): FetchRequest? = recoverLocked(respectMinGap = true)

    @Synchronized
    fun canRecoverOnForeground(): FetchRequest? = recoverLocked(respectMinGap = false)

    private fun recoverLocked(respectMinGap: Boolean): FetchRequest? {
        val url = currentUrl ?: return null
        if (hasLoadedArtwork || inFlightUrl != null) return null
        if (ArtworkRetryPolicy.isLocalOnlyUrl(url) || permanentlyFailedUrls.contains(url)) return null
        if (respectMinGap && lastAttemptAtMs > 0L) {
            val elapsed = clockMs() - lastAttemptAtMs
            if (elapsed in 0 until ArtworkRetryPolicy.NETWORK_RECOVERY_MIN_GAP_MS) return null
        }
        retryAttempt = 0
        inFlightUrl = url
        lastAttemptAtMs = clockMs()
        return FetchRequest(url, generation)
    }

    @Synchronized
    fun onFetchSucceeded(request: FetchRequest): Boolean {
        if (request.generation != generation || request.url != currentUrl) return false
        inFlightUrl = null
        hasLoadedArtwork = true
        retryAttempt = 0
        return true
    }

    @Synchronized
    fun onFetchPermanentFailure(request: FetchRequest): Boolean {
        recordPermanentFailure(request.url)
        if (request.generation != generation || request.url != currentUrl) return false
        inFlightUrl = null
        return true
    }

    @Synchronized
    fun onFetchTransientFailure(request: FetchRequest): RetryPlan? {
        if (request.generation != generation || request.url != currentUrl) return null
        inFlightUrl = null
        if (hasLoadedArtwork) return null
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
