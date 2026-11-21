package top.izuna.foliamajor.settings

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import org.json.JSONObject

// android/app/src/main/java/top/izuna/foliamajor/settings/FoliaSettingsStore.kt
// 应用设置的**唯一真相**。WebView 不再持有任何设置：它启动时拉一次、改了再写回来，
// 之后所有按设置行事的地方（播放链路、歌词、主题、界面）都读这里。
//
// 为什么必须搬：设置会**影响播放结果**。循环模式决定放完往哪走、跳过不可播决定失败后
// 重试还是换歌、音质与淡入淡出决定请求参数与换源时机、AI 主题参数决定主题缓存怎么算。
// 这些原本挂在 React store 上，WebView 被系统冻结时 JS 不跑，播放链路就失去了判断依据 ——
// 用户报的「前台冻结时暂停后无法继续」「切歌单后主题不换」都与此有关。
//
// 存法：一个 JSON blob 放在 SharedPreferences 里（键 `folia.settings.v1`）。
// 不用一百个独立的键，是因为设置项还在增加，逐个建键每加一项都要改三处（读、写、默认值）；
// 一个 blob 加一份默认值表就够，写入是整份覆盖，原子且不会出现半新半旧。
// 已经发布的键名保持不变（Web 侧的 localStorage 键仍按原样存一份，见 WebSettingsMirror）。
class FoliaSettingsStore private constructor(context: Context) {

    /** 加密槽位（AI 密钥）要用它，留一份 applicationContext 省得每处都传。 */
    private val appContext: Context = context.applicationContext

    private val prefs: SharedPreferences =
        appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** 当前设置的缓存。整份 JSON，读一次解析一次太贵，改动时同步更新。 */
    @Volatile
    private var cached: JSONObject = JSONObject()

    init {
        cached = load()
        // 升级后的第一次启动：老版本把 AI 密钥明文写在这个 blob 里，搬进加密槽位再删掉。
        migrateSecretsOutOfBlob()
    }

    private fun load(): JSONObject {
        val raw = prefs.getString(KEY_SETTINGS, null)
        val stored = if (raw.isNullOrEmpty()) {
            JSONObject()
        } else {
            try {
                JSONObject(raw)
            } catch (error: Throwable) {
                Log.w(TAG, "设置解析失败，回到默认值", error)
                JSONObject()
            }
        }
        // 与默认值合并：老版本存的 blob 里没有新加的项，这里补上，读的地方不用判空。
        val merged = merge(defaults(), stored)
        // 加密槽位里那份是 AI 密钥的真相；blob 里残留的明文（还没迁走的）也要能读到，
        // 否则升级后第一次启动 AI 会显示"未配置"。加密那份优先。
        val secrets = loadSecrets()
        SECRET_KEYS.forEach { key ->
            val encrypted = secrets?.optString(key, "") ?: ""
            val legacy = stored.optString(key, "")
            val value = encrypted.ifEmpty { legacy }
            if (value.isNotEmpty()) merged.put(key, value)
        }
        return merged
    }

    /**
     * 从加密槽位读 AI 密钥。
     *
     * 解不开（换机、Keystore 被重置）时当没有：AI 功能回退到「未配置」，用户在设置里重填一次即可，
     * 比拿着半截密钥去请求要好。这里**不**把密钥写回 blob。
     */
    private fun loadSecrets(): JSONObject? {
        return try {
            val stored = top.izuna.foliamajor.FoliaSecureStore.read(appContext, AI_KEY_SLOT)
            if (!stored.decrypted || stored.text == null) null
            else top.izuna.foliamajor.FoliaSecureStore.decode(stored.text)
        } catch (error: Throwable) {
            Log.w(TAG, "AI 密钥读取失败，按未配置处理", error)
            null
        }
    }

    /** 只把密钥那几项写进加密槽位；别的设置一个字都不进这里。 */
    private fun writeSecrets(values: Map<String, Any?>): Boolean {
        return try {
            top.izuna.foliamajor.FoliaSecureStore.write(
                appContext, AI_KEY_SLOT, top.izuna.foliamajor.FoliaSecureStore.encode(
                    SECRET_KEYS.associateWith { key -> values[key] as? String ?: "" }))
        } catch (error: Throwable) {
            Log.w(TAG, "AI 密钥写入失败", error)
            false
        }
    }

    /**
     * 升级后的第一件事：把老版本明文写在 blob 里的 AI 密钥搬进加密槽位，然后从 blob 删掉。
     *
     * 顺序是「先加密写成功，再删明文」：写不进去就把明文原样留着，下次启动再试 ——
     * 绝不在写不进去的时候先删，那才是真的把用户的 Key 弄丢。
     *
     * 返回 true = 老明文已经不在了（搬走了或本来就没有）。
     */
    @Synchronized
    private fun migrateSecretsOutOfBlob(): Boolean {
        val raw = prefs.getString(KEY_SETTINGS, null) ?: return true
        val blob = try {
            JSONObject(raw)
        } catch (error: Throwable) {
            return true // 解析不了就交给 load() 走默认值，这里不动它
        }
        val pending = SECRET_KEYS.filter { blob.has(it) && blob.optString(it, "").isNotEmpty() }
        if (pending.isEmpty()) {
            if (SECRET_KEYS.any { blob.has(it) }) {
                // 只有空串：不是凭据，直接删掉，别让它继续占着明文字段。
                stripSecrets(blob)
            }
            return true
        }
        val existing = loadSecrets()
        val merged = JSONObject(existing?.toString() ?: "{}")
        pending.forEach { key -> merged.put(key, blob.optString(key, "")) }
        return commitMigratedSecrets(blob, merged)
    }

    /** 把密钥从明文 blob 里删掉并落盘（用 commit：这是「明文到此为止」的证据）。内存缓存不动。 */
    private fun stripSecrets(blob: JSONObject) {
        var removed = false
        SECRET_KEYS.forEach { key ->
            if (blob.has(key)) {
                blob.remove(key)
                removed = true
            }
        }
        if (removed) prefs.edit().putString(KEY_SETTINGS, blob.toString()).commit()
    }

    /**
     * 上面那条路的收尾：加密那份写进去之后，blob 里的明文只能算残留，删掉它。
     *
     * 写不进去时**一定不删**：先删后写的顺序在掉电 / 进程被杀的情况下就是「用户的 Key 没了」。
     * 单独拆出来是为了让调用点一眼看到这个顺序。
     */
    @Synchronized
    private fun commitMigratedSecrets(blob: JSONObject, secrets: JSONObject): Boolean {
        if (!writeSecrets(SECRET_KEYS.associateWith { key -> secrets.optString(key, "") })) {
            Log.w(TAG, "AI 密钥暂时搬不进加密存储，明文先留着，下次启动再试")
            return false
        }
        // 内存里换成读得懂的那份（provider 等明文项仍在 cached 里）。
        val next = JSONObject(cached.toString())
        SECRET_KEYS.forEach { key ->
            val value = secrets.optString(key, "")
            if (value.isNotEmpty()) next.put(key, value) else next.remove(key)
        }
        cached = next
        stripSecrets(blob)
        return true
    }

    private fun defaults(): JSONObject = JSONObject(DEFAULTS)

    private fun merge(base: JSONObject, override: JSONObject): JSONObject {
        val result = JSONObject(base.toString())
        override.keys().forEach { key ->
            result.put(key, override.opt(key))
        }
        return result
    }

    /** 整份快照。WebView 启动时用它一次性把界面填满。 */
    fun snapshot(): JSONObject = JSONObject(cached.toString())

    fun getString(key: String): String? = cached.optString(key, "").takeIf { it.isNotEmpty() }

    fun getBoolean(key: String, fallback: Boolean = false): Boolean = cached.optBoolean(key, fallback)

    fun getInt(key: String, fallback: Int = 0): Int = cached.optInt(key, fallback)

    fun getDouble(key: String, fallback: Double = 0.0): Double = cached.optDouble(key, fallback)

    /**
     * 改一项并落盘，返回新的整份快照。
     *
     * 同步写（`commit`）而不是 `apply`：设置改完紧接着就可能有播放动作按它走，
     * 异步落盘在进程被系统杀掉时会丢。设置写入的频率很低（人手点），这点开销可以接受。
     *
     * AI 密钥不进这份明文 blob（见 [SECRET_KEYS]）：先加密写进槽位，写成功才更新内存缓存；
     * 写不进就保留旧值并如实返回，别让内存里"看着改好了"而磁盘上没有。
     */
    @Synchronized
    fun put(key: String, value: Any?): JSONObject {
        if (key in SECRET_KEYS) return applySecret(mapOf(key to value))
        val next = JSONObject(cached.toString())
        if (value == null) next.remove(key) else next.put(key, value)
        cached = next
        prefs.edit().putString(KEY_SETTINGS, next.toString()).commit()
        notifyBackgroundThemeConfigChanged(setOf(key))
        return snapshot()
    }

    /**
     * 批量改（WebView 保存设置时一次提交多项，避免中间态被读到）。
     *
     * 密钥项从这一批里挑出来单独进加密槽位；其余照旧一个 blob 落盘，所以 AI 设置页
     * 「一次提交七项」时不会出现「provider 存了、Key 没存」那种半截状态。
     */
    @Synchronized
    fun putAll(values: Map<String, Any?>): JSONObject {
        val secrets = values.filterKeys { it in SECRET_KEYS }
        val plain = values.filterKeys { it !in SECRET_KEYS }
        val next = JSONObject(cached.toString())
        plain.forEach { (key, value) ->
            if (value == null) next.remove(key) else next.put(key, value)
        }
        cached = next
        // apply() 而不是 commit()：cached 已经同步更新，读的人立刻拿到新值；
        // commit() 是同步 fsync，在主线程上是 ANR，在 Capacitor 桥线程上会把后续所有调用堵住。
        // apply() 的落盘由系统在 Activity 停止 / 进程正常退出时保证发出。
        prefs.edit().putString(KEY_SETTINGS, next.toString()).apply()
        /*
         * 两个分支都要通知后台主题（issue H33）：配置变更通知挂在「设置的唯一写入点」上，
         * 密钥项走加密槽位、其余走上面那个 blob，但「后台主题的配置改了」这件事是一样的。
         * 所以通知放在分流**之前**。
         */
        notifyBackgroundThemeConfigChanged(values.keys)
        if (secrets.isNotEmpty()) return applySecret(secrets)
        return snapshot()
    }

    /** 只更新密钥项（加密槽位是它们的唯一落盘处）。 */
    @Synchronized
    private fun applySecret(values: Map<String, Any?>): JSONObject {
        val merged = SECRET_KEYS.associateWith { key ->
            if (values.containsKey(key)) (values[key] as? String ?: "") else (cached.optString(key, ""))
        }
        if (!writeSecrets(merged)) {
            // 写不进加密存储：内存里也不改成"成功"的样子，读的人照旧看到旧值。
            Log.w(TAG, "AI 密钥没能写进加密存储，保留原值")
            return snapshot()
        }
        val next = JSONObject(cached.toString())
        merged.forEach { (key, value) ->
            if (value.isEmpty()) next.remove(key) else next.put(key, value)
        }
        cached = next
        return snapshot()
    }

    /**
     * 那份「后台主题」配置变了就通知 worker（issue H33）。
     *
     * 退避必须**一改配置就作废**：401 / 没配 Key 这类失败重试一万次也不会好，真正要发生的是
     * 用户去改配置 —— 他改完就该立刻有一次机会，而不是先等冷却窗口走完（否则表现是「改好了
     * 还是没主题」）。这里挂在设置的**唯一写入点**上，Web 从哪个入口改都覆盖得到。
     *
     * 只在真的变了的时候通知：Web 每次启动回前台都会重下发一遍同样的配置，那里不该清退避。
     */
    private fun notifyBackgroundThemeConfigChanged(changedKeys: Set<String>) {
        val key = "backgroundTheme.config"
        if (key !in changedKeys) return
        try {
            top.izuna.foliamajor.ai.BackgroundThemeWorker.onConfigChanged()
        } catch (error: Throwable) {
            // 通知失败不该让「保存设置」这件事失败。
            Log.w(TAG, "后台主题配置变更通知失败", error)
        }
    }

    companion object {
        private const val TAG = "FoliaSettings"
        private const val PREFS_NAME = "folia.settings"
        private const val KEY_SETTINGS = "folia.settings.v1"

        /**
         * **不进设置 blob 的键**：AI 的 API Key（H29）。
         *
         * 这个 blob 是明文 JSON 躺在 SharedPreferences 里，而 SharedPreferences 又在 auto backup
         * 的范围内 —— 抓一次 adb 备份、或者云备份被拖走，用户买的 Key 就跟着走了。所以这两项
         * 改由 [top.izuna.foliamajor.FoliaSecureStore] 用 Keystore 里的密钥加密后单独落盘
         * （槽位 [AI_KEY_SLOT]），blob 里只留 provider / 地址 / 模型这些**不是凭据**的部分。
         *
         * 读的地方不用改：`getString("ai.apiKey")` 仍然拿得到值，只是值的来源换成了加密槽位。
         * 真正解密的地方是 [load] 与 [applySecret]。
         */
        val SECRET_KEYS = listOf("ai.geminiApiKey", "ai.apiKey")
        private const val AI_KEY_SLOT = "ai-keys"

        /**
         * 默认值表。每加一项设置先在这里登记，Web 侧不再各自写一份默认值 ——
         * 两边各有一份默认值正是「改了没生效」的常见来源。
         *
         * 键名与 Web 侧 `use*SettingsStore` 保持不变（已发布的存储键不改名）。
         */
        private val DEFAULTS = """
        {
            "loopMode": "off",
            "shuffle": false,
            "volume": 1.0,
            "queueBehavior": "append",
            "autoSkipUnplayable": true,
            "backgroundSilentSkip": true,
            "playbackEntryView": "player",
            "phoneFitOrientation": "portrait",
            "autoLandscapeForVisualizer": false,
            "forceLandscape": false,
            "themeAutoFollow": true,
            "lyricsAutoScroll": true,
            "lyricFontScale": 1.0,
            "visualizerTheme": "default",
            "visualizerHighQuality": false,
            "crossfadeEnabled": false,
            "crossfadeMs": 0,
            "crossfadeCurve": "equalPower",
            "playbackFade": true,
            "transition.mode": "automix",
            "transition.effect": "",
            "transition.maxMs": 8000,
            "transition.performance": false,
            "transition.intensity": 0.75,
            "transition.enhancer": true,
            "transition.curve": "",
            "eq.version": 1,
            "eq.enabled": false,
            "eq.gains": "[0,0,0,0,0,0,0,0,0,0]",
            "eq.effects": "",
            "audioQuality": "high",
            "preventSleep": false,
            "deviceType": "phone",
            "prebuildTracks": false
        }
        """.trimIndent()

        @Volatile
        private var instance: FoliaSettingsStore? = null

        fun get(context: Context): FoliaSettingsStore =
            instance ?: synchronized(this) {
                instance ?: FoliaSettingsStore(context).also { instance = it }
            }
    }
}
