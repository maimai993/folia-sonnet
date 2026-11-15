package top.izuna.foliamajor.online

import android.util.Log

import org.json.JSONArray
import org.json.JSONObject

import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * 网易云红心的原生写入：weapi 直连 music.163.com，WebView 冻结时通知栏红心的兜底。
 *
 * 端点与写后复查的顺序照抄 {@code src/nativeBridge/api/netease.js} 的 handleSongLike：
 * 先走收藏库那条 {@code /api/song/like}（{@code /api/radio/like} 是私人 FM 的路子，
 * 实测会被风控挡，code=-460），每写一次都用 {@code /api/song/like/check} 复查——
 * 上游无论有没有真的写进收藏库都回 code 200，不复查就是「提示成功但我喜欢的音乐里没有」。
 */
class NeteaseLikeClient private constructor() {

    companion object {
        private const val TAG = "NeteaseLikeClient"
        private const val UA =
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
                        "Chrome/124.0.0.0 Safari/537.36"

        /**
         * @return 写入是否**确认**生效。写请求通了但复查不出来按失败算：宁可让 JS 醒来后再补，
         * 也不让通知栏停在一个没真正写进去的状态上。
         */
        @JvmStatic
        fun setLiked(cookieHeader: String?, trackIdText: String, liked: Boolean): Boolean {
            if (cookieHeader == null || cookieHeader.isEmpty()) {
                return false
            }
            // 未登录时写入会以匿名身份被服务端丢弃，先按登录事实拦一道。
            val cookie = LikeFallback.parseCookie(cookieHeader)
            if (!cookie.containsKey("MUSIC_U") && !cookie.containsKey("MUSIC_A")) {
                return false
            }
            val trackId: Long
            try {
                trackId = trackIdText.trim().toLong()
            } catch (error: NumberFormatException) {
                return false
            }
            if (trackId <= 0) {
                return false
            }

            val attempts = arrayOf(
                    arrayOf("/weapi/song/like",
                            "{\"trackId\":" + trackId + ",\"like\":" + liked + "}"),
                    arrayOf("/weapi/radio/like",
                            "{\"alg\":\"itembased\",\"trackId\":" + trackId +
                                    ",\"like\":" + liked + ",\"time\":\"3\"}"))
            for (attempt in attempts) {
                try {
                    val body = weapiPost("https://music.163.com" + attempt[0],
                            attempt[1], cookieHeader)
                    if (body.optInt("code", 0) != 200) {
                        continue
                    }
                    val after = readLikedNow(cookieHeader, trackId)
                    if (after != null && after == liked) {
                        return true
                    }
                } catch (error: Throwable) {
                    Log.w(TAG, "like write failed: " + attempt[0], error)
                }
            }
            return false
        }

        /** 写后复查：data 里是 {trackId: bool}，老形状是 ids / songs 数组。认不出回 null。 */
        private fun readLikedNow(cookieHeader: String, trackId: Long): Boolean? {
            try {
                val body = weapiPost("https://music.163.com/weapi/song/like/check",
                        "{\"trackIds\":\"[" + trackId + "]\"}", cookieHeader)
                val data = body.optJSONObject("data")
                if (data != null) {
                    val value = data.opt(trackId.toString())
                    if (value is Boolean) {
                        return value
                    }
                }
                var ids = body.optJSONArray("ids")
                if (ids == null && data != null) {
                    ids = data.optJSONArray("ids")
                }
                if (ids != null) {
                    for (i in 0 until ids.length()) {
                        if (ids.optLong(i, -1L) == trackId) {
                            return true
                        }
                    }
                    return false
                }
                var songs = body.optJSONArray("songs")
                if (songs == null && data != null) {
                    songs = data.optJSONArray("songs")
                }
                if (songs != null) {
                    for (i in 0 until songs.length()) {
                        val song = songs.optJSONObject(i)
                        if (song != null && song.optLong("id", -1L) == trackId) {
                            return true
                        }
                    }
                    return false
                }
            } catch (ignored: Throwable) {
                // 复查失败按「无法确认」处理，调用方会换下一条写入路径再试。
            }
            return null
        }

        /** weapi 请求：体里补 csrf_token，AES 双层加密后按表单发送。 */
        internal fun weapiPost(url: String, json: String, cookieHeader: String): JSONObject {
            val data = JSONObject(json)
            data.put("csrf_token", LikeFallback.parseCookie(cookieHeader)
                    .getOrDefault("__csrf", ""))
            val encrypted = WeapiCrypto.encrypt(data.toString())
            val form = "params=" + URLEncoder.encode(encrypted[0], "UTF-8") +
                    "&encSecKey=" + URLEncoder.encode(encrypted[1], "UTF-8")
            val connection = URL(url).openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "POST"
                connection.connectTimeout = 8000
                connection.readTimeout = 10000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
                connection.setRequestProperty("User-Agent", UA)
                connection.setRequestProperty("Referer", "https://music.163.com/")
                connection.setRequestProperty("Cookie", cookieHeader)
                connection.outputStream.use { out ->
                    out.write(form.toByteArray(StandardCharsets.UTF_8))
                }
                val status = connection.responseCode
                val text = LikeFallback.readAll(connection)
                if (status < 200 || status >= 300) {
                    throw IllegalStateException("HTTP " + status + " @ " + url)
                }
                return JSONObject(text)
            } finally {
                connection.disconnect()
            }
        }
    }
}
