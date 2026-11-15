package top.izuna.foliamajor.online

import android.content.Context
import android.content.SharedPreferences

import org.json.JSONException
import org.json.JSONObject

/**
 * 原生补写红心的记录（songKey → 写入结果），落盘。
 *
 * WebView 冻结期间通知栏那颗心原生直报服务器成功之后，JS 手上的账号缓存还是旧的；
 * 它一醒来就会把「旧状态」推回来，通知栏那颗心跟着被翻回去 —— 用户看到的就是
 * 「一打开 app 全部恢复原样」。这张表就是判据：JS 推来的值与记录一致 = 它已经从
 * 服务器读回了真状态，记录解除；不一致 = 它手上是旧缓存，以原生写入为准。
 *
 * App 启动时 JS 也会通过 FoliaPlayback.consumeLikeOverrides 把记录取走、对齐自己的
 * 账号缓存（见 omni.applyNativeLikeOverrides），这样 App 里的心与通知栏一起对上。
 */
class LikeOverrideStore private constructor() {

    companion object {
        private const val PREFS = "folia_like_overrides"
        private const val KEY_OVERRIDES = "overrides"
        /** 上限条数：丢最老的，别让长播放把这张表养大。 */
        private const val MAX_ENTRIES = 32

        /** 全部记录（songKey → {liked, providerId, serverSongId, at}）。没有就是空对象。 */
        @JvmStatic
        fun read(context: Context?): JSONObject {
            if (context == null) {
                return JSONObject()
            }
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            try {
                return JSONObject(prefs.getString(KEY_OVERRIDES, "{}"))
            } catch (error: JSONException) {
                return JSONObject()
            }
        }

        @JvmStatic
        fun save(context: Context?, overrides: JSONObject) {
            if (context == null) {
                return
            }
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putString(KEY_OVERRIDES, overrides.toString())
                    .apply()
        }

        /** 原生补写成功后记账。songKey 为空（拿不到身份）就不记。 */
        @JvmStatic
        fun record(context: Context?, songKey: String?, providerId: String?,
                   serverSongId: String?, liked: Boolean) {
            if (context == null || songKey == null || songKey.isEmpty()) {
                return
            }
            try {
                val overrides = read(context)
                val entry = JSONObject()
                entry.put("liked", liked)
                entry.put("providerId", if (providerId == null) "" else providerId)
                entry.put("serverSongId", if (serverSongId == null) "" else serverSongId)
                entry.put("at", System.currentTimeMillis())
                overrides.put(songKey, entry)
                while (overrides.length() > MAX_ENTRIES) {
                    var oldest: String? = null
                    var oldestAt = Long.MAX_VALUE
                    val keys = overrides.keys()
                    while (keys.hasNext()) {
                        val key = keys.next()
                        val at = overrides.optJSONObject(key)?.optLong("at", 0L) ?: 0L
                        if (at < oldestAt) {
                            oldestAt = at
                            oldest = key
                        }
                    }
                    if (oldest == null) {
                        break
                    }
                    overrides.remove(oldest)
                }
                save(context, overrides)
            } catch (ignored: JSONException) {
                // 记不上账就没有守卫：最坏回到「JS 旧状态翻回去」的现状。
            }
        }

        /**
         * 这首歌有没有原生补写过（有回 true/false，没有回 null）。
         *
         * 原生兜底切歌时用：镜像条目里的 liked 是 JS 推全量那一刻的账号缓存快照，
         * 冻结期间点过的心它不知道 —— 不叠这一层，一切歌心就被打回原形
         * （用户原话：「点了需要缓存，因为歌单不一定马上刷新」）。
         */
        @JvmStatic
        fun likedOf(context: Context?, songKey: String?): Boolean? {
            if (context == null || songKey == null || songKey.isEmpty()) {
                return null
            }
            try {
                val entry = read(context).optJSONObject(songKey)
                if (entry == null || !entry.has("liked")) {
                    return null
                }
                return entry.optBoolean("liked", false)
            } catch (error: Throwable) {
                return null
            }
        }

        /** 取走全部记录并清空（App 启动时 JS 的认领入口）。 */
        @JvmStatic
        fun consume(context: Context?): JSONObject {
            val overrides = read(context)
            if (context != null && overrides.length() > 0) {
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .edit()
                        .remove(KEY_OVERRIDES)
                        .apply()
            }
            return overrides
        }
    }
}
