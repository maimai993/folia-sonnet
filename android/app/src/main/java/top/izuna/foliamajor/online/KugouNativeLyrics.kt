package top.izuna.foliamajor.online

import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.Base64

// 酷狗原生续播歌词：与 Web 桥相同，按 hash 查候选再下载普通 LRC，不依赖会员取流状态。
object KugouNativeLyrics {
    private val timestamp = Regex("\\[\\d{1,3}:\\d{1,2}(?:[.:]\\d{1,3})?\\]")

    /** HTTP 200 也可能只是 No Action Found!，只有合法时间歌词才能交给播放器（#166）。 */
    fun fetch(hash: String, get: (String) -> String = ::download): String? {
        if (!Regex("[a-fA-F0-9]{32}").matches(hash)) return null
        val search = JSONObject(get("https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&hash=$hash&lrctxt=1"))
        val candidates = search.optJSONArray("candidates") ?: return null
        for (index in 0 until minOf(candidates.length(), 4)) {
            val candidate = candidates.optJSONObject(index) ?: continue
            val id = candidate.optString("id", "")
            val access = candidate.optString("accesskey", "")
            if (id.isEmpty() || access.isEmpty()) continue
            try {
                val body = JSONObject(get("https://lyrics.kugou.com/download?ver=1&client=pc&id=" +
                        encode(id) + "&accesskey=" + encode(access) + "&fmt=lrc&charset=utf8"))
                val content = body.optString("content", "")
                if (content.isEmpty()) continue
                val text = String(Base64.getDecoder().decode(content.replace(Regex("\\s"), "")), StandardCharsets.UTF_8)
                if (timestamp.containsMatchIn(text)) return text
            } catch (error: Exception) {
                Log.w("KugouLyrics", "候选歌词下载失败，继续下一份", error)
            }
        }
        return null
    }

    private fun encode(text: String): String = URLEncoder.encode(text, "UTF-8")

    private fun download(url: String): String {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 8000
            connection.readTimeout = 10000
            connection.setRequestProperty("User-Agent", "Mozilla/5.0")
            connection.setRequestProperty("Referer", "https://www.kugou.com/")
            check(connection.responseCode in 200..299) { "KuGou lyric HTTP ${connection.responseCode}" }
            return connection.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }
}
