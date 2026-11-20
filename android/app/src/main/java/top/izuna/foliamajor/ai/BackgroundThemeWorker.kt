package top.izuna.foliamajor.ai

import android.content.Context
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import top.izuna.foliamajor.player.FoliaNativePlayerPlugin
import top.izuna.foliamajor.settings.FoliaSettingsStore
import top.izuna.foliamajor.wallpaper.WallpaperThemePalette
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadFactory
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

// android/app/src/main/java/top/izuna/foliamajor/ai/BackgroundThemeWorker.kt
// 原生后台主题：切歌且歌词到手后，在原生单线程里先读云端 stage 候选，再按需生成。
// 结果只放有界内存等 JS 来 read；不碰播放器、不碰音频进度、不向云端上传任何东西。

/**
 * 认领结果时采用哪份歌词指纹。
 *
 * **只认原生自己那份**（`activeLyricHash`，来自本曲最近一次 `request` 的原始 LRC）。
 * Web 传进来的歌词是「界面上的那一份」：过了歌词过滤、staff 信用块策略（默认 smart
 * 会把开头的作词/作曲整块隐藏）、模组 transform，纯音乐时还会被换成歌名 —— 与原生
 * 生成时喂进模型的正文不是同一个字符串。拿它当身份，原生算好的结果就永远认领不回来，
 * 表现正是 issue #209 的「后台播放时 AI 主题拉不到」。
 *
 * 歌词内容真的变了也不能放过：换歌词时服务会重新 `request`，`activeLyricHash` 跟着
 * 换新值，旧结果自然对不上键 —— 判定还在，只是换成原生对得上的依据。
 *
 * 原生这一侧还没有歌词指纹时（旧调用路径）才退回 Web 传来的那份：宁可退回旧行为，
 * 也不要让「没传歌词」变成「永远不采用」。
 */
internal fun backgroundThemeLyricIdentity(nativeLyricHash: String, webLyricText: String?): String {
    if (nativeLyricHash.isNotEmpty()) return nativeLyricHash
    if (webLyricText == null) return ""
    return BackgroundThemeRules.lyricHash(webLyricText)
}

/**
 * 原生后台主题 worker。
 *
 * 调用方只做三件事：
 *  1. 每切歌 `updateActiveSong(songKey)`，清掉上一首的结果；
 *  2. 切歌且歌词到手后 `request(context, songKey, title, artist, lyricText)`；
 *  3. 回到前台 / 需要主题时 `read(context, songKey, policy, lyricText?)`，拿到 `{ payload, source }`。
 *
 * 线程模型：一个单线程 executor 顺序处理，队列里最新的请求优先；同一 identity 在飞时
 * 去重，在飞数与排队数都有上限，满了丢**最旧**那条（缓存/生成都只是加速器，
 * 但「用户最后点的那首」不能被丢）。
 */
object BackgroundThemeWorker {

    private const val TAG = "BackgroundTheme"
    private const val MAX_RESULTS = 16
    private const val MAX_IN_FLIGHT = 8
    private const val MAX_PENDING = 7
    private const val MAX_GENERATIONS = 64

    /**
     * 提示词长度的告警线（issue M32）。
     *
     * 按字符算，12000 大致对应中文 1 万 token 上下、英文三四千 —— 过了这条线，一次主题生成的
     * 额度消耗会明显高于普通曲目，值得在日志里留一笔。只告警不截断。
     */
    private const val BACKGROUND_THEME_PROMPT_WARN_CHARS = 12_000

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .build()

    /**
     * 最新优先：`offer` 插队头，worker 从队头取。
     *
     * 满队列时**丢最旧那条、留最新那条**。以前是直接 `offerFirst` 失败 → AbortPolicy 拒绝，
     * 也就是丢掉最新的：用户连点几首歌换主题时，最后点的那首反而没有任务，队列里排着的
     * 全是「已经听过去的歌」—— 肉眼看到的就是「最新一次点主题没反应」。丢最旧则是少算
     * 一首切走的歌，缓存与生成本来只是加速器，不该拿它换掉用户当下的那首。
     */
    internal class LatestFirstQueue(capacity: Int) : LinkedBlockingDeque<Runnable>(capacity) {
        override fun offer(runnable: Runnable): Boolean {
            while (!super.offerFirst(runnable)) {
                // 队尾就是最旧的那条；删掉它就腾出一个位置。
                // 删不到（被 worker 抢走 / 队列空）就再来一轮，别在这里放弃。
                if (pollLast() == null) return false
            }
            return true
        }
    }

    private val executor = ThreadPoolExecutor(
        1, 1, 0L, TimeUnit.MILLISECONDS, LatestFirstQueue(MAX_PENDING),
        ThreadFactory { runnable -> Thread(runnable, "folia-background-theme").apply { isDaemon = true } },
        ThreadPoolExecutor.AbortPolicy(),
    )

    private val resultLock = Any()

    private val results: MutableMap<String, ResultEntry> = object : LinkedHashMap<String, ResultEntry>(8, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ResultEntry>): Boolean = size > MAX_RESULTS
    }

    private val generations: MutableMap<String, Long> = object : LinkedHashMap<String, Long>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>): Boolean = size > MAX_GENERATIONS
    }

    /**
     * 失败记忆（issue H33）：key 是**生成身份**（`resultKey` 那一套：本曲 + policy + 歌词 +
     * 配置指纹），值是这个身份最近一次失败是什么、什么时候、连续几次。
     *
     * 为什么必须有：`request` 的三个触发点（切歌、`onStop`、歌词到手）都是热路径，而这里
     * 原来只有「已有结果不排队」和「在飞去重」两道保护 —— **没有失败记忆**。一次失败之后
     * 结果表里没有条目、在飞标记也释放了，于是下一次退到后台就把整轮重跑一遍：云端候选
     * 解析、多条条目拉取，再一次完整的**付费**模型生成。失败越频繁（限流、401）重试越密，
     * 额度就是这么烧掉的。
     *
     * 放进同一个 `resultLock` 是因为它和结果表一起读写，两把锁反而会给出不一致的快照。
     */
    private val failures: MutableMap<String, BackgroundThemeFailure> = object : LinkedHashMap<String, BackgroundThemeFailure>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, BackgroundThemeFailure>): Boolean =
            size > MAX_FAILURES
    }

    /** 失败记忆表的容量上限：只在最近这么多生成身份上记退避，够覆盖在听的那几首。 */
    private const val MAX_FAILURES = 64

    private val inFlight = HashSet<String>()
    private val generationCounter = AtomicLong()

    @Volatile
    private var activeSongKey: String = ""

    /**
     * 当前歌最近一次 request 的歌词指纹 —— **认领结果时以它为准**（见 [backgroundThemeLyricIdentity]）。
     *
     * 它来自原生自己拉的原始 LRC，与生成时喂进模型的正文同一份，所以「歌词换了」这件事
     * 在原生这边能自己判断出来，不必依赖 Web 手上那份被筛选过的歌词。
     */
    private var activeLyricHash: String = ""

    /**
     * 一条结果连同它的生成身份。
     *
     * read 不能只看内存里有没有 key：结果生成后关掉配置、换 policy、换密钥 / 模型 / 端点，
     * 旧答案都必须失效。identity 在写入时固化，读取时与当前设置逐项比对。
     */
    private data class ResultEntry(
        val payload: JSONObject,
        val source: String,
        val songKey: String,
        val policy: String,
        val lyricHash: String,
        val configFingerprint: String,
        val aiFingerprint: String,
        val generation: Long,
    ) {
        fun matches(
            songKey: String,
            policy: String,
            lyricHash: String,
            configFingerprint: String,
            aiFingerprint: String,
            generation: Long,
        ): Boolean = this.songKey == songKey &&
            this.policy == policy &&
            this.lyricHash == lyricHash &&
            this.configFingerprint == configFingerprint &&
            this.aiFingerprint == aiFingerprint &&
            this.generation == generation
    }

    /** 一次排队任务的完整身份：排队期间任何一项变了都作废。 */
    private data class JobIdentity(
        val songKey: String,
        val memoryKey: String,
        val generation: Long,
        val policy: String,
        val lyricHash: String,
        val configFingerprint: String,
        val aiFingerprint: String,
        val requestedDaylight: Boolean,
    )

    /**
     * Lead 每切歌调用一次：清掉上一首的结果。
     *
     * 只清内存，不碰播放器 / 音频时间，也不发网络请求；还在排队的旧任务会在
     * [runJob] 入口按 activeSongKey 直接放弃，不会走到云端或付费 AI。
     */
    @JvmStatic
    fun updateActiveSong(songKey: String) {
        val key = songKey.trim()
        synchronized(resultLock) {
            if (activeSongKey != key) results.clear()
            activeSongKey = key
            activeLyricHash = ""
        }
    }

    /**
     * 切歌且歌词到手后调用。方法本身只读设置、排队，不发网络请求。
     *
     * 配置关掉时会清空旧结果，避免关掉之后 JS 还读到上一首的答案。
     * `daylight` 不传时取当前配置；它只决定叠层取 stage 的哪一侧，不参与结果 identity。
     * 真正应用叠层时仍以 fresh config 的 daylight 为准。
     *
     * `userInitiated` 是「用户主动要求重新生成」（issue H33）：自动触发（切歌 / `onStop` /
     * 歌词到手）要受失败退避约束，用户主动点的那一次不受 —— 见 [BackgroundThemeBackoff]。
     */
    @JvmStatic
    @JvmOverloads
    fun request(
        context: Context, songKey: String, title: String, artist: String, lyricText: String,
        daylight: Boolean? = null, userInitiated: Boolean = false,
    ) {
        val key = songKey.trim()
        if (key.isEmpty()) return

        val appContext = context.applicationContext
        val store = FoliaSettingsStore.get(appContext)
        val config = currentConfig(store)
        val lyricHash = BackgroundThemeRules.lyricHash(lyricText)
        val configFingerprint = BackgroundThemeRules.configFingerprint(config)

        synchronized(resultLock) {
            if (activeSongKey != key) results.clear()
            activeSongKey = key
            activeLyricHash = lyricHash
        }

        if (!config.enabled) {
            synchronized(resultLock) { results.clear() }
            return
        }

        val memoryKey = BackgroundThemeRules.resultKey(key, config.policy, lyricHash, configFingerprint)
        // 同一 identity 已经有结果就不再排队：request 是切歌与歌词回调都会走的热路径。
        synchronized(resultLock) {
            if (results.containsKey(memoryKey)) return
        }
        /*
         * failedAttempts 要跟着作业走：作业失败时才知道该不该记账（用户主动那一次不计入
         * 连续次数，免得把用户的耐心当成机器的重试）。
         */
        val failureCountFlag = resolveFailureCountFlag(memoryKey, userInitiated, System.currentTimeMillis()) ?: return
        if (!beginJob(memoryKey)) return

        val generation = synchronized(resultLock) {
            val next = generationCounter.incrementAndGet()
            generations[memoryKey] = next
            next
        }
        val job = JobIdentity(
            songKey = key,
            memoryKey = memoryKey,
            generation = generation,
            policy = config.policy,
            lyricHash = lyricHash,
            configFingerprint = configFingerprint,
            aiFingerprint = aiFingerprint(store),
            requestedDaylight = daylight ?: config.daylight,
        )

        try {
            executor.execute {
                try {
                    runJob(appContext, store, job, title, artist, lyricText, failureCountFlag)
                } catch (error: Exception) {
                    Log.w(TAG, "[BackgroundTheme] 任务异常 ${error.javaClass.simpleName}")
                    recordFailure(job.memoryKey, failureCountFlag, BackgroundThemeBackoff.Kind.TRANSIENT)
                } finally {
                    finishJob(memoryKey)
                }
            }
        } catch (error: RejectedExecutionException) {
            /*
             * 兜底分支：`LatestFirstQueue` 自己会腾位置，正常不会再走到这里。
             * 真撞上（例如队列被判满又删不掉）也只是少算一首，缓存/生成都只是加速器。
             * 这不算「失败」：没发一次请求、没烧一次额度，不该让它占一次冷却。
             */
            finishJob(memoryKey)
            Log.w(TAG, "[BackgroundTheme] 队列拒绝任务，跳过本次")
        }
    }

    /**
     * 取当前歌曲的结果。`songKey` 不是当前歌、当前配置关闭、policy / 设置指纹 /
     * AI 密钥模型任一与结果生成时不一致，一律返回 null。
     *
     * **歌词指纹只按原生自己那份校验**（`activeLyricHash`）：Web 传来的 `lyricText`
     * 只进日志做对照，不参与判定。原因见 [backgroundThemeLyricIdentity] —— 界面上的
     * 歌词经过筛选/清洗，和原生生成时用的正文不是同一个字符串，拿它当身份等于永远
     * 认领不到。这一条是 issue #209 的根因修复点。
     *
     * 返回的是副本，JS 改它不会影响 worker 里那份。
     */
    @JvmStatic
    fun read(context: Context, songKey: String, policy: String, lyricText: String? = null): JSONObject? {
        val key = songKey.trim()
        if (key.isEmpty()) return null

        val store = FoliaSettingsStore.get(context.applicationContext)
        val config = currentConfig(store)
        if (!config.enabled || config.policy != policy) {
            /*
             * policy 不一致也要记：它是 issue #209 现场里容易被忽略的一条 ——
             * Web 读的时候用的是它自己认定的 policy，原生配置被改过就永远对不上。
             */
            if (config.enabled) {
                Log.i(TAG, "[BackgroundTheme] policy 不一致，不认领 songKey=$key 原生=${config.policy.take(32)} Web=${policy.take(32)}")
            }
            return null
        }
        val configFingerprint = BackgroundThemeRules.configFingerprint(config)
        val ai = aiFingerprint(store)

        var nativeHash = ""
        var outcome: JSONObject? = null
        var missReason = ""
        synchronized(resultLock) {
            nativeHash = activeLyricHash
            val hash = backgroundThemeLyricIdentity(activeLyricHash, lyricText)
            if (activeSongKey != key) {
                missReason = "songKey=$key 不是当前歌 activeSongKey=$activeSongKey"
            } else {
                val memoryKey = BackgroundThemeRules.resultKey(key, policy, hash, configFingerprint)
                val entry = results[memoryKey]
                val generation = generations[memoryKey]
                if (entry == null || generation == null || !entry.matches(key, policy, hash, configFingerprint, ai, generation)) {
                    missReason = "本曲没有可用的结果 歌词指纹=$hash 配置指纹=$configFingerprint"
                } else {
                    outcome = JSONObject()
                        .put("payload", JSONObject(entry.payload.toString()))
                        .put("source", entry.source)
                }
            }
        }

        /*
         * 成功也记：这一行就是 issue #209 要的现场（原生侧取到的命中与歌词指纹）。
         * 失败时把两侧指纹一起打出来 —— 它们本来就允许不同（Web 那份是界面上的歌词），
         * 不同不代表结果有问题，但排查时能一眼看出「谁的歌词变了」。
         */
        val webHash = lyricText?.let { BackgroundThemeRules.lyricHash(it) } ?: ""
        if (outcome != null) {
            Log.i(TAG, "[BackgroundTheme] 采用原生结果 songKey=$key policy=${policy.take(32)} 歌词指纹=$nativeHash")
        } else {
            Log.i(
                TAG,
                "[BackgroundTheme] 未命中 songKey=$key $missReason 原生歌词指纹=$nativeHash Web 歌词指纹=$webHash",
            )
        }
        return outcome
    }

    private fun currentConfig(store: FoliaSettingsStore): BackgroundThemeConfig =
        BackgroundThemeRules.parseConfig(store.snapshot().opt(BackgroundThemeRules.CONFIG_KEY))

    /** 密钥 / 模型 / 端点的指纹：只比较是否改过，不落盘、不写日志。 */
    private fun aiFingerprint(store: FoliaSettingsStore): String {
        val ai = readAiConfig(store)
        return BackgroundThemeRules.lyricHash(
            listOf(
                ai.provider, ai.geminiApiKey, ai.geminiApiUrl, ai.apiKey, ai.model, ai.baseUrl, ai.temperature.toString(),
            ).joinToString("\u0000"),
        )
    }

    /** 排队期间切歌 / 关配置 / 换 policy / 换云端配置 / 换密钥模型都会让任务作废；返回当前配置。 */
    private fun validConfig(store: FoliaSettingsStore, job: JobIdentity): BackgroundThemeConfig? {
        val config = currentConfig(store)
        if (!config.enabled || config.policy != job.policy) return null
        if (BackgroundThemeRules.configFingerprint(config) != job.configFingerprint) return null
        if (aiFingerprint(store) != job.aiFingerprint) return null
        synchronized(resultLock) {
            if (activeSongKey != job.songKey || generations[job.memoryKey] != job.generation) return null
        }
        return config
    }

    private fun runJob(
        context: Context, store: FoliaSettingsStore, job: JobIdentity, title: String, artist: String, lyricText: String,
        countsTowardStreak: Boolean,
    ) {
        // 入口先验一次：排队期间切歌 / 关配置 / 换密钥的任务在这里结束，不烧云端和 AI。
        val config = validConfig(store, job) ?: return

        val cloudPayload = pullFromCloud(config, title, lyricText)
        if (cloudPayload != null) {
            if (validConfig(store, job) != null && storeResult(job, cloudPayload, "cloud")) {
                applyToOverlay(context, store, job, cloudPayload)
                // 拿到了就清掉失败记忆：这一首现在是「有答案」的状态，退避没有理由继续。
                clearFailure(job.memoryKey)
            }
            return
        }

        // 云端未命中后再验一次，之后才会花付费 AI。
        val fresh = validConfig(store, job) ?: return
        /*
         * 生成失败的原因分类由 generate 带回来（out 参数），不放进共享字段：worker 是单线程，
         * 但 request 会在主线程提前读，一个可变的「上次失败类别」迟早对不上号。
         */
        val failureKind = arrayOf(BackgroundThemeBackoff.Kind.TRANSIENT)
        val generated = generate(context, fresh, store, title, artist, lyricText, failureKind)
        if (generated != null) {
            if (validConfig(store, job) != null && storeResult(job, generated, "ai")) {
                applyToOverlay(context, store, job, generated)
                clearFailure(job.memoryKey)
                Log.i(TAG, "[BackgroundTheme] 生成完成")
            }
            return
        }
        /*
         * 失败落到这里：没拿到结果（云端没命中 + 生成没成 / 未配置 / 401 / 限流）。
         *
         * 记下来，下一次自动触发在冷却窗口内直接跳过（issue H33）—— 不记的话，用户每退一次
         * 后台就是一轮云端往返加一次付费生成。`countsTowardStreak` 带回了这次是谁发起的：用户主动
         * 那次记成 0，表示「不增加连续次数」，退避只由自动触发的失败驱动。
         */
        recordFailure(job.memoryKey, countsTowardStreak, failureKind[0])
    }

    /**
     * 先按歌名读候选，再按证据词 100% 匹配；没有歌词时按标题允许（服务端排序最靠前）。
     *
     * 候选只读，不回填、不上传。
     */
    private fun pullFromCloud(config: BackgroundThemeConfig, title: String, lyricText: String): JSONObject? {
        if (!config.cloudEnabled) return null
        val songTitle = title.trim()
        if (songTitle.isEmpty()) return null

        val candidates = resolveCandidates(config.cloudBaseUrl, songTitle)
        if (candidates.isEmpty()) return null

        val selected = if (lyricText.isBlank()) {
            candidates.take(BackgroundThemeRules.MAX_ENTRY_FETCHES)
        } else {
            candidates
                .filter { BackgroundThemeRules.highlightWordsPresent(it.words, lyricText) }
                .sortedByDescending { BackgroundThemeRules.evidenceWords(it.words).size }
                .take(BackgroundThemeRules.MAX_ENTRY_FETCHES)
        }

        for (candidate in selected) {
            val payload = fetchEntry(config.cloudBaseUrl, candidate.key)
            if (payload != null && BackgroundThemeRules.payloadMatchesLyrics(payload, lyricText)) return payload
        }
        return null
    }

    /**
     * 真实契约来自 src/services/aiCloudCache.ts 的 fetchResolveCandidates：
     * `POST {cloudBaseUrl}/api/ai-cache/resolve`，body `{ kind: 'stage', songTitle }`。
     * 不是 GET query；不要按猜的格式发。
     */
    private fun resolveCandidates(baseUrl: String, songTitle: String): List<CloudCandidate> {
        val url = BackgroundThemeRules.resolveCandidatesUrl(baseUrl) ?: return emptyList()
        val body = JSONObject().put("kind", "stage").put("songTitle", songTitle).toString()

        val request = try {
            Request.Builder()
                .url(url)
                .header("Accept", "application/json")
                .post(body.toRequestBody(jsonMediaType))
                .build()
        } catch (error: Exception) {
            return emptyList()
        }

        return try {
            httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    Log.w(TAG, "[BackgroundTheme] 候选请求失败 code=${response.code}")
                    emptyList()
                } else {
                    val text = response.body?.string()
                    if (text.isNullOrEmpty()) {
                        emptyList()
                    } else {
                        val root = try {
                            JSONObject(text)
                        } catch (error: Exception) {
                            null
                        }
                        BackgroundThemeRules.parseCandidates(root)
                    }
                }
            }
        } catch (error: Exception) {
            // 不交 error.message：OkHttp 的异常原文可能带完整 URL（含 token query）。
            Log.w(TAG, "[BackgroundTheme] 候选请求异常 ${error.javaClass.simpleName}")
            emptyList()
        }
    }

    /** `GET {cloudBaseUrl}/api/ai-cache/stage/<key>`，只认 `{ hit:true, entry.payload }`。 */
    private fun fetchEntry(baseUrl: String, key: String): JSONObject? {
        val url = BackgroundThemeRules.entryUrl(baseUrl, key) ?: return null
        val request = try {
            Request.Builder()
                .url(url)
                .header("Accept", "application/json")
                .get()
                .build()
        } catch (error: Exception) {
            return null
        }

        return try {
            httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    null
                } else {
                    val text = response.body?.string()
                    val data = if (text.isNullOrEmpty()) {
                        null
                    } else {
                        try {
                            JSONObject(text)
                        } catch (error: Exception) {
                            null
                        }
                    }
                    if (data == null || !data.optBoolean("hit", false)) {
                        null
                    } else {
                        val entry = data.optJSONObject("entry")
                        val payload = entry?.optJSONObject("payload")
                        BackgroundThemeRules.asStagePayload(payload)
                    }
                }
            }
        } catch (error: Exception) {
            Log.w(TAG, "[BackgroundTheme] 条目读取异常 ${error.javaClass.simpleName}")
            null
        }
    }

    /**
     * 用已有 AiCompletion.run；模板只在本机拼，密钥只从 ai.* 设置读。
     *
     * `failureKind` 是出参：失败时把「这一趟为什么没成」写回去（配置错误 / 限流 / 临时），
     * 退避按它决定冷却多长 —— 401 重试一万次也不会好，那类要多等一会儿并让用户去改配置。
     */
    private fun generate(
        context: Context, config: BackgroundThemeConfig, store: FoliaSettingsStore, title: String, artist: String,
        lyricText: String,
        failureKind: Array<BackgroundThemeBackoff.Kind>,
    ): JSONObject? {
        val aiConfig = readAiConfig(store)
        if (!aiConfig.configured) {
            Log.i(TAG, "[BackgroundTheme] AI 未配置，跳过生成")
            failureKind[0] = BackgroundThemeBackoff.Kind.CONFIG
            return null
        }

        val system = config.system.ifBlank { BackgroundThemeRules.DEFAULT_SYSTEM }
        val prompt = BackgroundThemeRules.injectTemplate(config.promptTemplate, title, artist, lyricText)
        /*
         * 输入规模（issue M32）：歌词整份拼进提示词，双语时长曲目能到几万 token，而额度按 token 计。
         * 超了只记一行，不截断 —— 截断会直接影响主题质量，那是产品取舍，不该在这一层悄悄做决定。
         * 只记字数、不记正文。
         */
        if (prompt.length > BACKGROUND_THEME_PROMPT_WARN_CHARS) {
            Log.w(
                TAG,
                "[BackgroundTheme] 提示词偏长 chars=${prompt.length}（歌词 ${lyricText.length}）" +
                    "，超过 ${BACKGROUND_THEME_PROMPT_WARN_CHARS}，本次生成的额度消耗会明显偏高",
            )
        }

        return try {
            /*
             * M30：后台主题与前台补全走同一条原生网络栈，端点的准入判定也要一样，
             * 否则「前台不让连内网、后台照连」就是一个现成的绕过口。
             */
            val access = top.izuna.foliamajor.FoliaNativeAccess(context.applicationContext)
            val text = AiCompletion.run(aiConfig, system, prompt, BackgroundThemeRules.MAX_TOKENS, true) { url ->
                access.requireAllowedRequestUrl(url, "background-theme")
            }
            val payload = BackgroundThemeRules.parseStagePayload(text)
            if (payload == null) {
                Log.w(TAG, "[BackgroundTheme] 模型输出不是可用的 stage JSON")
            }
            payload
        } catch (error: AiCompletion.AiException) {
            Log.w(TAG, "[BackgroundTheme] AI 调用失败 code=${error.code}")
            failureKind[0] = BackgroundThemeBackoff.kindOfFailure(error.code, error.message)
            null
        } catch (error: Exception) {
            Log.w(TAG, "[BackgroundTheme] AI 调用异常 ${error.javaClass.simpleName}")
            failureKind[0] = BackgroundThemeBackoff.kindOfFailure(null, error.message)
            null
        }
    }

    /** 只读已有 ai.* 设置；不新增键、不落盘、不日志。 */
    private fun readAiConfig(store: FoliaSettingsStore): AiConfig = AiConfig(
        provider = store.getString("ai.provider") ?: "gemini",
        geminiApiKey = store.getString("ai.geminiApiKey") ?: "",
        geminiApiUrl = store.getString("ai.geminiApiUrl") ?: "",
        apiKey = store.getString("ai.apiKey") ?: "",
        model = store.getString("ai.model") ?: "",
        baseUrl = store.getString("ai.baseUrl") ?: "",
        temperature = store.getDouble("ai.temperature", 0.7),
    )

    /**
     * 只有「当前歌 + 当前 generation」才落结果。
     *
     * 晚到的旧歌结果会在这里被丢掉：切歌时 activeSongKey 已经换掉，旧任务写不进来。
     * 结果连同 policy / 歌词 / 配置 / AI 指纹一起存，供 read 时逐项复核。
     */
    private fun storeResult(job: JobIdentity, payload: JSONObject, source: String): Boolean =
        synchronized(resultLock) {
            if (activeSongKey != job.songKey || generations[job.memoryKey] != job.generation) {
                false
            } else {
                results[job.memoryKey] = ResultEntry(
                    payload = JSONObject(payload.toString()),
                    source = source,
                    songKey = job.songKey,
                    policy = job.policy,
                    lyricHash = job.lyricHash,
                    configFingerprint = job.configFingerprint,
                    aiFingerprint = job.aiFingerprint,
                    generation = job.generation,
                )
                true
            }
        }

    /**
     * 只写叠层主题表；配置 / policy / 云端配置 / 密钥模型、本曲、generation 任一不符就不写，
     * 不碰播放器与音频时间。明暗取 fresh config 的 daylight，排队期间切换不会沿用旧值。
     */
    private fun applyToOverlay(context: Context, store: FoliaSettingsStore, job: JobIdentity, payload: JSONObject) {
        val fresh = validConfig(store, job) ?: return
        val media = FoliaNativePlayerPlugin.mediaSnapshot()
        if (media == null || media.songKey.trim() != job.songKey) {
            Log.i(TAG, "[BackgroundTheme] 原生已不在本曲，跳过叠层")
            return
        }
        if (job.requestedDaylight != fresh.daylight) {
            Log.i(TAG, "[BackgroundTheme] daylight 已变化，按最新配置应用")
        }
        val theme = BackgroundThemeRules.sanitizeForOverlay(payload, fresh.daylight) ?: return
        WallpaperThemePalette.save(
            context.applicationContext,
            theme.optString("primaryColor", ""),
            theme.optString("secondaryColor", ""),
            theme.toString(),
        )
        Log.i(TAG, "[BackgroundTheme] 已应用到原生叠层")
    }

    private fun beginJob(key: String): Boolean = synchronized(inFlight) {
        if (inFlight.contains(key) || inFlight.size >= MAX_IN_FLIGHT) {
            false
        } else {
            inFlight.add(key)
            true
        }
    }

    private fun finishJob(key: String) {
        synchronized(inFlight) {
            inFlight.remove(key)
        }
    }

    /**
     * 决定这一次要不要跑：返回 `null` = 在冷却窗口里，跳过；`false` = 用户主动要求，跑但
     * 不增加连续次数；`true` = 自动触发，跑，失败时计入连续次数。
     *
     * 不把这个标志塞进 [JobIdentity]：作业身份参与作废判定，多一个只在记账时用的字段会让
     * 「同样的作业」看起来不一样，得不偿失。
     */
    private fun resolveFailureCountFlag(key: String, userInitiated: Boolean, nowMs: Long): Boolean? {
        synchronized(resultLock) {
            if (userInitiated) {
                /* 用户点了「重新生成」：立刻清掉退避，这一次必须真的跑。 */
                if (failures.remove(key) != null) {
                    Log.i(TAG, "[BackgroundTheme] 用户主动重试，清掉失败退避")
                }
                return false
            }
            val failure = failures[key]
            if (BackgroundThemeBackoff.shouldSkip(failure, nowMs)) {
                /*
                 * 冷却中：直接跳过，不排队、不发请求、不生成。这一行是排查「为什么没主题」
                 * 的唯一依据，所以把类别与还剩多久都记下来（不含任何凭据）。
                 */
                val kind = BackgroundThemeBackoff.kindOf(failure?.kind)
                val remaining = if (failure != null && failure.streak < BackgroundThemeBackoff.MAX_STREAK) {
                    BackgroundThemeBackoff.cooldownMs(kind, failure.streak) - (nowMs - failure.atMs)
                } else {
                    -1L
                }
                Log.i(
                    TAG,
                    "[BackgroundTheme] 冷却中，跳过本次自动生成 类别=${kind.name} 连续失败=${failure?.streak}" +
                        if (remaining >= 0) " 剩余≈${remaining / 1000}s" else " 已停止自动重试",
                )
                return null
            }
            return true
        }
    }

    /** 记一次失败。`countsTowardStreak = false`（用户主动那一次）只记类别，不增加连续次数。 */
    private fun recordFailure(key: String, countsTowardStreak: Boolean, kind: BackgroundThemeBackoff.Kind) {
        val now = System.currentTimeMillis()
        synchronized(resultLock) {
            val previous = failures[key]
            failures[key] = if (countsTowardStreak) {
                BackgroundThemeBackoff.recordFailure(previous, kind, now)
            } else {
                BackgroundThemeFailure(
                    kind = kind.name,
                    atMs = now,
                    streak = (previous?.streak ?: 0).coerceAtLeast(1),
                )
            }
            val recorded = failures[key]
            Log.i(
                TAG,
                "[BackgroundTheme] 记一次失败 类别=${kind.name} 连续失败=${recorded?.streak} " +
                    "冷却≈${BackgroundThemeBackoff.cooldownMs(kind, recorded?.streak ?: 1) / 1000}s",
            )
        }
    }

    private fun clearFailure(key: String) {
        synchronized(resultLock) {
            failures.remove(key)
        }
    }

    /**
     * 配置一改就整体作废退避（issue H33 的边界条件：用户改完配置必须能立刻重试）。
     *
     * 退避按「生成身份」记，而身份里含配置指纹 —— 改了配置本来就会算出新身份、自然不受
     * 旧记录的约束。但仍然整体清一次：401 那些常常是用户换了密钥之后才发现旧的已经过期，
     * 他改完就该立刻有一次机会，而不是先等旧身份那几条记录各自过期。
     *
     * 由 Lead 在下发配置时调用（`useBackgroundThemeConfig` → `configureBackgroundTheme`）。
     */
    @JvmStatic
    fun onConfigChanged() {
        synchronized(resultLock) {
            if (failures.isNotEmpty()) {
                Log.i(TAG, "[BackgroundTheme] 配置已变更，清掉全部失败退避")
                failures.clear()
            }
        }
    }
}
