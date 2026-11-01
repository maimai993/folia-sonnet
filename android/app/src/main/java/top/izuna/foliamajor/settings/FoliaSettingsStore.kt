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

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** 当前设置的缓存。整份 JSON，读一次解析一次太贵，改动时同步更新。 */
    @Volatile
    private var cached: JSONObject = JSONObject()

    init {
        cached = load()
    }

    private fun load(): JSONObject {
        val raw = prefs.getString(KEY_SETTINGS, null)
        if (raw.isNullOrEmpty()) return defaults()
        return try {
            // 与默认值合并：老版本存的 blob 里没有新加的项，这里补上，读的地方不用判空。
            merge(defaults(), JSONObject(raw))
        } catch (error: Throwable) {
            Log.w(TAG, "设置解析失败，回到默认值", error)
            defaults()
        }
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
     */
    @Synchronized
    fun put(key: String, value: Any?): JSONObject {
        val next = JSONObject(cached.toString())
        if (value == null) next.remove(key) else next.put(key, value)
        cached = next
        prefs.edit().putString(KEY_SETTINGS, next.toString()).commit()
        return snapshot()
    }

    /** 批量改（WebView 保存设置时一次提交多项，避免中间态被读到）。 */
    @Synchronized
    fun putAll(values: Map<String, Any?>): JSONObject {
        val next = JSONObject(cached.toString())
        values.forEach { (key, value) ->
            if (value == null) next.remove(key) else next.put(key, value)
        }
        cached = next
        prefs.edit().putString(KEY_SETTINGS, next.toString()).commit()
        return snapshot()
    }

    companion object {
        private const val TAG = "FoliaSettings"
        private const val PREFS_NAME = "folia.settings"
        private const val KEY_SETTINGS = "folia.settings.v1"

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
            "playbackFade": true,
            "audioQuality": "high",
            "preventSleep": false,
            "deviceType": "phone"
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
