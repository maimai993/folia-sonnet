package top.izuna.foliamajor.online

import android.util.Log

import org.json.JSONArray
import org.json.JSONObject

import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * QQ 音乐红心的原生写入：musicu.fcg 直连 u.y.qq.com，WebView 冻结时通知栏红心的兜底。
 *
 * 写入顺序照抄 {@code src/nativeBridge/api/qq.js} 的 handleQQSongLike：
 * PlaylistDetailWrite（Add/DelSonglist，dirId 201 = 「我喜欢」）→ SongFavWrite（Add/DelSong），
 * songType 先 0 再 13；comm 与回包判定照 buildQQAuthComm / qqLikeWriteResult。
 * 回包判定的意义与网易云复查一样：上游不保证回 0 就真的写进去了，逐条核对才敢换心。
 */
class QqLikeClient private constructor() {

    companion object {
        private const val TAG = "QqLikeClient"
        private const val UA =
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
                        "Chrome/124.0.0.0 Safari/537.36"
        private const val MUSICU = "https://u.y.qq.com/cgi-bin/musicu.fcg?format=json"

        @JvmStatic
        fun setLiked(cookieHeader: String?, songIdText: String, liked: Boolean): Boolean {
            if (cookieHeader == null || cookieHeader.isEmpty()) {
                return false
            }
            val songId: Long
            try {
                songId = songIdText.trim().toLong()
            } catch (error: NumberFormatException) {
                return false
            }
            if (songId <= 0) {
                return false
            }
            val cookie = LikeFallback.parseCookie(cookieHeader)
            val uin = qqUin(cookie)
            // 没有账号身份（游客）写不了收藏：写了也白写。
            if (uin.isEmpty()) {
                return false
            }
            val musicKey = LikeFallback.firstNonBlank(cookie, "qm_keyst", "qqmusic_key",
                    "music_key", "p_skey", "skey", "psrf_qqaccess_token", "psrf_qqrefresh_token",
                    "wxrefresh_token", "wxskey")
            if (musicKey.isEmpty()) {
                return false
            }

            try {
                val comm = JSONObject()
                        .put("uin", uin.toLong())
                        .put("format", "json")
                        .put("ct", 19)
                        .put("cv", 0)
                        .put("platform", "yqq.json")
                        .put("authst", musicKey)
                // 微信扫码通道的凭据必须带自己的 tmeLoginType，否则上游按 QQ 通道解析拿不到数据。
                val loginType = cookie["tmeLoginType"]
                if (loginType != null) {
                    try {
                        val type = Integer.parseInt(loginType.trim())
                        if (type > 0) {
                            comm.put("tmeLoginType", type)
                        }
                    } catch (ignored: NumberFormatException) {
                        // 非数字就当没有。
                    }
                }

                val attempts = arrayOf(
                        arrayOf("music.musicasset.PlaylistDetailWrite",
                                if (liked) "AddSonglist" else "DelSonglist", "0"),
                        arrayOf("music.musicasset.PlaylistDetailWrite",
                                if (liked) "AddSonglist" else "DelSonglist", "13"),
                        arrayOf("music.musicasset.SongFavWrite",
                                if (liked) "AddSong" else "DelSong", "0"),
                        arrayOf("music.musicasset.SongFavWrite",
                                if (liked) "AddSong" else "DelSong", "13"))
                for (attempt in attempts) {
                    val param: JSONObject
                    if ("music.musicasset.PlaylistDetailWrite" == attempt[0]) {
                        param = JSONObject()
                                .put("dirId", 201)
                                .put("v_songInfo", JSONArray().put(JSONObject()
                                        .put("songId", songId)
                                        .put("songType", Integer.parseInt(attempt[2]))))
                    } else {
                        param = JSONObject()
                                .put("uin", uin.toLong())
                                .put("v_uin", uin.toLong())
                                .put("dirId", 201)
                                .put("ids", JSONArray().put(songId))
                                .put("songTypes", JSONArray().put(Integer.parseInt(attempt[2])))
                    }
                    val payload = JSONObject()
                            .put("comm", comm)
                            .put("req_0", JSONObject()
                                    .put("module", attempt[0])
                                    .put("method", attempt[1])
                                    .put("param", param))
                    val body = post(payload, cookieHeader)
                    val block = body.optJSONObject("req_0")
                    if (writeConfirmed(block, body)) {
                        return true
                    }
                    val data = if (block == null) null else block.optJSONObject("data")
                    val code = responseCode(block, data, body)
                    if (code == 1000) {
                        // 未登录：后面的尝试也一样，直接停。
                        return false
                    }
                }
                return false
            } catch (error: Throwable) {
                Log.w(TAG, "QQ like fallback failed", error)
                return false
            }
        }

        /** 回包判定，照 qqLikeWriteResult：code 与业务码都对上、没有失败歌单才算写成功。 */
        private fun writeConfirmed(block: JSONObject?, root: JSONObject): Boolean {
            if (block == null) {
                return false
            }
            val data = block.optJSONObject("data")
            val code = responseCode(block, data, root)
            if (code != 0 && code != 200) {
                return false
            }
            if (data == null) {
                // 上游有时只回 code：code 对上就认。
                return true
            }
            val result = data.opt("result")
            if (result is Number) {
                // Number.intValue() 是 Java 写法；Kotlin 里用 toInt()。
                val value = result.toInt()
                if (value != 0 && value != 200) {
                    return false
                }
            }
            var business = 0
            if (data.has("ret")) {
                business = data.optInt("ret", 0)
            } else if (data.has("resultCode")) {
                business = data.optInt("resultCode", 0)
            } else if (data.has("errCode")) {
                business = data.optInt("errCode", 0)
            }
            if (business != 0 && business != 200 && result !is JSONObject) {
                return false
            }
            for (key in arrayOf("v_failedSongId", "v_failSongId", "vFailedSongId",
                        "failedSongIds")) {
                val failed = data.opt(key)
                if (failed is JSONArray && failed.length() > 0) {
                    return false
                }
            }
            return true
        }

        private fun responseCode(block: JSONObject?, data: JSONObject?, root: JSONObject?): Int {
            if (block != null && block.has("code")) {
                return block.optInt("code", 0)
            }
            if (data != null && data.has("code")) {
                return data.optInt("code", 0)
            }
            return if (root == null) 0 else root.optInt("code", 0)
        }

        /** uin 取法照 qqCookieUin：微信通道（login_type=2）先 wxuin，QQ 通道先 uin。 */
        private fun qqUin(cookie: Map<String, String>): String {
            val loginType = cookie["login_type"]
            val raw: String?
            if ("2" == (loginType?.trim() ?: "")) {
                raw = LikeFallback.firstNonBlank(cookie, "wxuin", "uin", "p_uin")
            } else {
                raw = LikeFallback.firstNonBlank(cookie, "uin", "qqmusic_uin", "wxuin", "p_uin")
            }
            val digits = raw?.replace(Regex("\\D"), "") ?: ""
            val stripped = digits.replaceFirst(Regex("^0+"), "")
            return if (stripped.isEmpty()) digits else stripped
        }

        private fun post(payload: JSONObject, cookieHeader: String): JSONObject {
            val connection = URL(MUSICU).openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "POST"
                connection.connectTimeout = 8000
                connection.readTimeout = 10000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json;charset=UTF-8")
                connection.setRequestProperty("Referer", "https://y.qq.com/")
                connection.setRequestProperty("User-Agent", UA)
                connection.setRequestProperty("Cookie", cookieHeader)
                connection.outputStream.use { out ->
                    out.write(payload.toString().toByteArray(StandardCharsets.UTF_8))
                }
                val status = connection.responseCode
                val text = LikeFallback.readAll(connection)
                if (status < 200 || status >= 300) {
                    throw IllegalStateException("HTTP " + status + " @ musicu.fcg")
                }
                return JSONObject(text)
            } finally {
                connection.disconnect()
            }
        }
    }
}
