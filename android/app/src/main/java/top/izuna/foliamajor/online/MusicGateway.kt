package top.izuna.foliamajor.online

import android.util.Log
import android.webkit.CookieManager

import org.json.JSONArray
import org.json.JSONObject

import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.Collections
import java.util.Random
import java.util.regex.Pattern

import top.izuna.foliamajor.wallpaper.WallpaperLyricsState

/**
 * 原生平台网关：WebView 冻结 / 已死时，播放延续需要的平台读取直接从这里出网。
 *
 * 为什么要它：应用的取流地址、歌词、红心状态原本全在 Web 层那套 JS 里
 * （nativeBridge/api/ 下的 JS），WebView 一冻结整条链就断 —— 原生兜底切歌只能用镜像里
 * 预取过的那几个地址（「连按五首就切不动」），歌词与封面没人拉（壁纸停在上一首），
 * 红心状态也没处问。这个类把**播放延续需要的那一小块**平台逻辑用 Java 复刻：
 *
 *  · 取流地址：网易 weapi /song/enhance/player/url（{@link WeapiCrypto} 现成），
 *    QQ musicu vkey.GetVkeyServer/CgiGetVkey（{@link QqLikeClient} 的 comm 三件套现成）。
 *  · 歌词：网易 /song/lyric/v1（lrc + tlyric，纯文本），QQ GetPlayLyricInfo
 *    （回的是普通 LRC，base64 皮，不需要 QRC 那套 3DES）。
 *
 * 范围刻意收窄：搜索、歌单、登录那些只有前台用得上的交互仍然归 Web 层 —— 前台
 * WebView 活着，没必要两套并存。等哪天前台也出问题再往这里搬。
 *
 * 登录态不另存：WebView 侧的 chrome.cookies 已经接在 CookieManager 上
 * （installCookieShim），直接读同一个罐子。酷狗的签名直连照 KuGouMusicApi
 * 复刻（会话从同一个罐里取）。汽水不走 HTTP：签名必须由签名宿主里那个真页面
 * 算，这里经 {@link top.izuna.foliamajor.QishuiGatewayBridge} 同步要一次 request。
 * 飞牛是纯 HTTP，但凭据（地址 / token / 中继）在 Web 层手里 —— 由它登录后经
 * FoliaNative.setGatewayCredentials 推进来，见 {@link #setFeiniuCredentials}。
 */
class MusicGateway private constructor() {

    /** 平台歌词的两个纯文本：主 LRC 与翻译 LRC（都可能为空串）。 */
    class Lyric(mainLrc: String?, transLrc: String?) {
        @JvmField val mainLrc: String = mainLrc ?: ""
        @JvmField val transLrc: String = transLrc ?: ""
    }

    /** 飞牛的会话三件套：地址、token、中继模式 —— 由 Web 层登录后推过来。 */
    class FeiniuCredentials(serverUrl: String, token: String, relayMode: Boolean) {
        @JvmField val serverUrl: String = serverUrl
        @JvmField val token: String = token
        @JvmField val relayMode: Boolean = relayMode
    }

    /**
     * 「我喜欢」名单缓存：按身份（uin / userid / 凭据串）隔离，换账号自动作废；
     * 拉失败时同身份沿用旧名单（null = 从没拉到过）。加锁在实例上，五家互不堵。
     */
    private class LikedList {
        private val lock = Object()
        private var identity: String? = null
        private var ids: MutableSet<String>? = null
        private var readAtMs = 0L

        fun snapshot(who: String?,
                     fetcher: java.util.function.Supplier<MutableSet<String>?>): MutableSet<String>? {
            val now = android.os.SystemClock.elapsedRealtime()
            val cached = ids
            if (cached != null && who != null && who == identity && now - readAtMs < LIKED_TTL_MS) {
                return cached
            }
            synchronized(lock) {
                val nowLocked = android.os.SystemClock.elapsedRealtime()
                val cachedLocked = ids
                if (cachedLocked != null && who != null && who == identity
                        && nowLocked - readAtMs < LIKED_TTL_MS) {
                    return cachedLocked
                }
                val fresh = fetcher.get()
                if (fresh != null) {
                    identity = who
                    ids = fresh
                    readAtMs = nowLocked
                    return fresh
                }
                // 拉失败沿用旧名单，但只有同身份的才可信（换了账号旧名单是别人的）。
                return if (who != null && who == identity) ids else null
            }
        }
    }

    companion object {
        private const val TAG = "MusicGateway"
        private const val UA =
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
                        "Chrome/124.0.0.0 Safari/537.36"
        private const val MUSICU = "https://u.y.qq.com/cgi-bin/musicu.fcg?format=json"
        private const val QQ_FALLBACK_SIP = "https://ws.stream.qqmusic.qq.com/"

        /**
         * 向平台要这首歌的播放地址。拿不到（没登录、VIP 歌、平台拒绝）回 null，
         * 调用方保持原状 —— 通知栏的错误比假装切了歌诚实。
         *
         * @param providerId 平台（netease / qq / kugou）
         * @param songId     服务器侧数字 id（网易曲库 id；QQ 的数字 songId）
         * @param mid        QQ 的 songmid（CgiGetVkey 只认它；网易不用）
         * @param hash       酷狗的文件 hash（/v5/url 只认它；其它平台不用）
         * @param albumAudioId 酷狗的 album_audio_id（与 hash 一起送）
         */
        @JvmStatic
        fun resolvePlayUrl(providerId: String?, songId: String?, mid: String?,
                           hash: String?, albumAudioId: String?): String? {
            try {
                if ("netease" == providerId) {
                    return neteasePlayUrl(songId)
                }
                if ("qq" == providerId) {
                    return qqPlayUrl(mid)
                }
                if ("kugou" == providerId) {
                    return kugouPlayUrl(hash, albumAudioId)
                }
                if ("qishui" == providerId) {
                    return qishuiPlayUrl(songId)
                }
                if ("feiniu" == providerId) {
                    return feiniuPlayUrl(songId)
                }
            } catch (error: Throwable) {
                Log.w(TAG, "resolvePlayUrl failed (" + providerId + ")", error)
            }
            return null
        }

        /** 向平台要歌词。拿不到回 null；文本拿到了但解不出时间轴由调用方兜底。 */
        @JvmStatic
        fun fetchLyric(providerId: String?, songId: String?, mid: String?,
                       hash: String?): Lyric? {
            try {
                if ("netease" == providerId) {
                    return neteaseLyric(songId)
                }
                if ("qq" == providerId) {
                    return qqLyric(songId, mid)
                }
                if ("kugou" == providerId) {
                    return kugouLyric(hash)
                }
                if ("qishui" == providerId) {
                    return qishuiLyric(songId)
                }
                if ("feiniu" == providerId) {
                    return feiniuLyric(songId)
                }
            } catch (error: Throwable) {
                Log.w(TAG, "fetchLyric failed (" + providerId + ")", error)
            }
            return null
        }

        // ==================== 汽水（签名宿主直调） ====================

        /**
         * 汽水的取流地址要过签名宿主里那个隐藏 WebView 的协议层（bdms.js 签名这一步
         * 绕不开），所以这里只是把 request 同步化：拿到的就是协议层 song.url 的信封。
         *
         * 与 Web 层（qishuiProvider.getAudioSource）的一致性：trial（试听段）**不拒**
         * —— 兜底切歌的目标是「别停」，试听总比没得放强；Web 层拒它是因为它还要进
         * 缓存与时长统计，兜底这条路没有那些后续。加密直链（带 #auth=）换成本地
         * 解密代理地址；代理没起来时放弃（给 ExoPlayer 一条解不开的密文没有意义）。
         */
        private fun qishuiPlayUrl(songId: String?): String? {
            val id = songId?.trim() ?: ""
            if (id.isEmpty()) {
                return null
            }
            val envelope = qishuiRequest("song.url", qishuiParams("id", id, "quality", "standard"))
            if (envelope == null || !envelope.optBoolean("ok", false)) {
                return null
            }
            val data = envelope.optJSONObject("data")
            val url = data?.optString("url", "") ?: ""
            if (url.isEmpty()) {
                return null
            }
            val authAt = url.indexOf("#auth=")
            if (authAt < 0) {
                // 明文直链（车机协议）：ExoPlayer 直接吃。
                return url
            }
            val cleanUrl = url.substring(0, authAt)
            val auth = url.substring(authAt + "#auth=".length)
            val proxied = top.izuna.foliamajor.QishuiGatewayBridge.audioProxyUrlFor(cleanUrl, auth)
            return if (proxied.isEmpty()) null else proxied
        }

        /** 汽水歌词：协议层回 {lyric, tlyric, yrc, ytlrc}，壁纸用整行 LRC 那两个。 */
        private fun qishuiLyric(songId: String?): Lyric? {
            val id = songId?.trim() ?: ""
            if (id.isEmpty()) {
                return null
            }
            val envelope = qishuiRequest("lyric", qishuiParams("id", id))
            if (envelope == null || !envelope.optBoolean("ok", false)) {
                return null
            }
            val data = envelope.optJSONObject("data")
            if (data == null) {
                return null
            }
            return Lyric(data.optString("lyric", ""), data.optString("tlyric", ""))
        }

        /**
         * 参数拼成 JSON 字符串（签名宿主的 request 就是收字符串）。JSONObject.put 是
         * 受检异常，链式 new 在 try 外面编译不过 —— 统一在这里包掉：全是字符串对，
         * 理论上抛不出来。
         */
        private fun qishuiParams(vararg pairs: String): String {
            try {
                val params = JSONObject()
                var i = 0
                while (i + 1 < pairs.size) {
                    params.put(pairs[i], pairs[i + 1])
                    i += 2
                }
                return params.toString()
            } catch (error: Exception) {
                return "{}"
            }
        }

        /** 同步过一次签名宿主（后台线程调）；拿不到信封回 null。 */
        private fun qishuiRequest(operation: String, paramsJson: String): JSONObject? {
            val envelope = top.izuna.foliamajor.QishuiGatewayBridge.requestSync(
                    operation, paramsJson, 12_000L)
            if (envelope == null || envelope.isEmpty()) {
                return null
            }
            try {
                return JSONObject(envelope)
            } catch (error: Exception) {
                Log.w(TAG, "qishui " + operation + " envelope is not JSON", error)
                return null
            }
        }

        // ==================== 飞牛（凭据推送 + 纯 HTTP） ====================

        @Volatile
        private var feiniuCreds: FeiniuCredentials? = null

        /**
         * Web 层登录 / 登出 / 改地址 / 切中继时推送（FoliaNative.setGatewayCredentials）。
         * token 为空视为登出。凭据只进内存：进程活着就有效，死了说明 Web 层同样要重登。
         *
         * 地址先照 Web 层 withSchemeAndPort 补齐：没写 scheme 的按 http；http 又没写
         * 端口的补 5666（fnOS 网关就挂那儿）—— 不补的话拼出来的请求会打到 80 上，
         * 收到一个 HTML 页，表现跟「服务不存在」一模一样。
         */
        @JvmStatic
        fun setFeiniuCredentials(serverUrl: String?, token: String?, relayMode: Boolean) {
            var cleanUrl = serverUrl?.trim()?.replaceFirst(Regex("/+$"), "") ?: ""
            val cleanToken = token?.trim() ?: ""
            if (cleanUrl.isEmpty() || cleanToken.isEmpty()) {
                feiniuCreds = null
                return
            }
            if (!cleanUrl.matches(Regex("(?i)^https?://.*"))) {
                cleanUrl = "http://" + cleanUrl
            }
            // Kotlin 的 regionMatches 参数序：ignoreCase 在最后，不是第一位。
            if (cleanUrl.regionMatches(0, "http://", 0, 7, ignoreCase = true)) {
                val slash = cleanUrl.indexOf('/', 7)
                val hostPart = if (slash < 0) cleanUrl.substring(7) else cleanUrl.substring(7, slash)
                if (!hostPart.contains(":")) {
                    cleanUrl = if (slash < 0)
                        cleanUrl + ":5666"
                    else
                        cleanUrl.substring(0, slash) + ":5666" + cleanUrl.substring(slash)
                }
            }
            feiniuCreds = FeiniuCredentials(cleanUrl, cleanToken, relayMode)
        }

        /** 飞牛资源请求的 Cookie：中继模式恒带 mode=relay（网关只认这个值）。 */
        private fun feiniuCookieValue(creds: FeiniuCredentials): String {
            return "music-token=" + creds.token + (if (creds.relayMode) "; mode=relay" else "")
        }

        /**
         * 飞牛取流：地址是确定性的（guid 拼出来就是），不用网络往返 ——
         * 直接给直链。ExoPlayer 那一份 Cookie 由 {@link #headersForPlaybackUrl} 补。
         */
        private fun feiniuPlayUrl(guid: String?): String? {
            val creds = feiniuCreds
            val id = guid?.trim() ?: ""
            if (creds == null || id.isEmpty()) {
                return null
            }
            return creds.serverUrl + "/music/api/v1/track/stream?guid=" + urlEncode(id)
        }

        /**
         * 飞牛歌词：/lyric/list 回 {list:[{guid,content}],preferred}，
         * 挑 preferred 那条，没有就第一条（照 Web 层 pickFeiniuLyricText）。
         */
        private fun feiniuLyric(guid: String?): Lyric? {
            val creds = feiniuCreds
            val id = guid?.trim() ?: ""
            if (creds == null || id.isEmpty()) {
                return null
            }
            var connection: HttpURLConnection? = null
            try {
                val conn = URL(creds.serverUrl +
                        "/music/api/v1/lyric/list?trackGUID=" + urlEncode(id)).openConnection()
                        as HttpURLConnection
                connection = conn
                conn.connectTimeout = 8000
                conn.readTimeout = 10000
                conn.setRequestProperty("Cookie", feiniuCookieValue(creds))
                conn.setRequestProperty("Accept", "application/json")
                val status = conn.responseCode
                val text = LikeFallback.readAll(conn)
                if (status < 200 || status >= 300 || text.isEmpty()) {
                    return null
                }
                val data = JSONObject(text).optJSONObject("data")
                if (data == null) {
                    return null
                }
                val list = data.optJSONArray("list")
                if (list == null || list.length() == 0) {
                    return null
                }
                val preferred = data.optString("preferred", "")
                var content = ""
                for (i in 0 until list.length()) {
                    val entry = list.optJSONObject(i) ?: continue
                    val value = entry.optString("content", "")
                    if (value.isEmpty()) continue
                    if (!preferred.isEmpty() && entry.optString("guid", "") == preferred) {
                        return Lyric(value, "")
                    }
                    if (content.isEmpty()) content = value
                }
                return if (content.isEmpty()) null else Lyric(content, "")
            } catch (error: Exception) {
                Log.w(TAG, "feiniu lyric failed", error)
                return null
            } finally {
                if (connection != null) connection.disconnect()
            }
        }

        /**
         * 飞牛红心的原生兜底：POST favorite-track/create|delete，
         * body 是 {"trackGUID": guid}（照 Web 层 feiniuMutations.likeSong）。
         */
        @JvmStatic
        fun feiniuSetLiked(guid: String?, liked: Boolean): Boolean {
            val creds = feiniuCreds
            val id = guid?.trim() ?: ""
            if (creds == null || id.isEmpty()) {
                return false
            }
            var connection: HttpURLConnection? = null
            try {
                val conn = URL(creds.serverUrl + "/music/api/v1/" +
                        (if (liked) "favorite-track/create" else "favorite-track/delete"))
                        .openConnection() as HttpURLConnection
                connection = conn
                conn.requestMethod = "POST"
                conn.connectTimeout = 8000
                conn.readTimeout = 10000
                conn.doOutput = true
                conn.setRequestProperty("Cookie", feiniuCookieValue(creds))
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Accept", "application/json")
                val body = ("{\"trackGUID\":\"" + id.replace("\"", "") + "\"}")
                        .toByteArray(StandardCharsets.UTF_8)
                conn.outputStream.use { out ->
                    out.write(body)
                }
                val status = conn.responseCode
                return status >= 200 && status < 300
            } catch (error: Exception) {
                Log.w(TAG, "feiniu like failed", error)
                return false
            } finally {
                if (connection != null) connection.disconnect()
            }
        }

        // ==================== 网易「我喜欢」名单（切换后红心状态的真源） ====================

        @Volatile
        private var neteaseUid = 0L

        @Volatile
        private var neteaseLikedIds: MutableSet<Long>? = null

        @Volatile
        private var neteaseLikedReadAtMs = 0L

        /** 名单缓存多久。刚点过的心以 LikeOverrideStore 为准（服务端名单不保证马上刷新）。 */
        private const val NETEASE_LIKED_TTL_MS = 10 * 60_000L

        /** Web 层登录后把网易 uid 推过来（FoliaNative.setGatewayCredentials）；登出推空。 */
        @JvmStatic
        fun setNeteaseUid(uid: String?) {
            val parsed = parseSongId(uid)
            if (parsed <= 0) {
                neteaseUid = 0L
                neteaseLikedIds = null
                return
            }
            if (parsed != neteaseUid) {
                // 换了账号：旧名单作废，下一问重新拉。
                neteaseLikedIds = null
            }
            neteaseUid = parsed
        }

        /**
         * 这首歌在不在网易「我喜欢」里；名单拿不到回 null（调用方保持原状）。
         *
         * 名单一发就是全部（一次请求、几万 id 也就几百 KB），10 分钟缓存 —— 每次切歌
         * 都拉一遍太重。叫用要在后台线程（里面是 weapi 网络）。
         */
        @JvmStatic
        fun neteaseIsLiked(songId: String?): Boolean? {
            if (neteaseUid <= 0) {
                return null
            }
            var now = android.os.SystemClock.elapsedRealtime()
            var cached = neteaseLikedIds
            if (cached == null || now - neteaseLikedReadAtMs > NETEASE_LIKED_TTL_MS) {
                synchronized(MusicGateway::class.java) {
                    cached = neteaseLikedIds
                    now = android.os.SystemClock.elapsedRealtime()
                    if (cached == null || now - neteaseLikedReadAtMs > NETEASE_LIKED_TTL_MS) {
                        val fresh = fetchNeteaseLikedList()
                        if (fresh != null) {
                            neteaseLikedIds = fresh
                            neteaseLikedReadAtMs = now
                            cached = fresh
                        }
                        // 拉失败就继续用旧的（可能为 null）：null = 不知道，调用方不动那颗心。
                    }
                }
            }
            if (cached == null) {
                return null
            }
            val id = parseSongId(songId)
            return if (id > 0) cached.contains(id) else null
        }

        private fun fetchNeteaseLikedList(): MutableSet<Long>? {
            try {
                val cookie = cookieFor("https://music.163.com/")
                val body = weapiPost("/api/song/like/get",
                        JSONObject().put("uid", neteaseUid).put("csrf_token", csrfOf(cookie)), cookie)
                val ids = body.optJSONArray("ids")
                if (ids == null) {
                    return null
                }
                val out = HashSet<Long>()
                for (i in 0 until ids.length()) {
                    val value = ids.optLong(i, -1L)
                    if (value > 0) {
                        out.add(value)
                    }
                }
                Log.i(TAG, "netease liked list refreshed (" + out.size + " songs)")
                return out
            } catch (error: Exception) {
                Log.w(TAG, "netease liked list fetch failed", error)
                return null
            }
        }

        /** 平台「我喜欢」名单的缓存时长（各平台共用）。 */
        private const val LIKED_TTL_MS = 10 * 60_000L

        /**
         * 各平台「我喜欢」名单查询的统一入口：歌在不在平台自己的名单里。
         * 名单拿不到回 null（调用方保持原状），跟 {@link #neteaseIsLiked} 一个约定。
         *
         * 身份字段的对应关系（镜像条目里各平台都有的那几个）：网易/汽水/飞牛认
         * serverSongId；QQ 认 songmid（providerMid），数字 id 兜底；酷狗认文件 hash
         * （providerHash），mixsongid/album_audio_id 兜底。
         */
        @JvmStatic
        fun likedListContains(providerId: String?, songId: String?, mid: String?,
                              hash: String?): Boolean? {
            if (providerId == null) {
                return null
            }
            try {
                when (providerId) {
                    "netease" ->
                        return neteaseIsLiked(songId)
                    "qq" ->
                        return qqIsLiked(songId, mid)
                    "kugou" ->
                        return kugouIsLiked(hash, songId)
                    "qishui" ->
                        return qishuiIsLiked(songId)
                    "feiniu" ->
                        return feiniuIsLiked(songId)
                }
            } catch (error: Throwable) {
                Log.w(TAG, "likedListContains failed (" + providerId + ")", error)
            }
            return null
        }

        private val qqLikedList = LikedList()
        private val kugouLikedList = LikedList()
        private val qishuiLikedList = LikedList()
        private val feiniuLikedList = LikedList()

        // ==================== QQ「我喜欢」名单（CgiGetDiss dirid 201） ====================

        private fun qqIsLiked(songId: String?, mid: String?): Boolean? {
            val cleanMid = mid?.trim() ?: ""
            val id = parseSongId(songId)
            if (cleanMid.isEmpty() && id <= 0) {
                return null
            }
            val cookie = cookieFor("https://u.y.qq.com/")
            val parsed = LikeFallback.parseCookie(cookie)
            val uin = qqUinOf(parsed)
            if (uin <= 0) {
                return null
            }
            val list = qqLikedList.snapshot(uin.toString(),
                    java.util.function.Supplier { fetchQQLikedList(cookie, parsed, uin) })
            if (list == null) {
                return null
            }
            if (!cleanMid.isEmpty() && list.contains(cleanMid)) {
                return true
            }
            return id > 0 && list.contains(id.toString())
        }

        /**
         * 照 folia.js 的 user_liked_songs 主通道：musicu CgiGetDiss，dirid 201 就是
         * 「我喜欢」歌单。song_num 一页 100（JS 那边 clamp 过的上限），封顶 8 页 ——
         * 拉到封顶还没完就放弃（回 null 不缓存）：半份名单会把手里的歌错判成「没收藏」。
         */
        private fun fetchQQLikedList(cookie: String?, parsed: Map<String, String>,
                                     uin: Long): MutableSet<String>? {
            var encryptedUin: String? = LikeFallback.firstNonBlank(parsed,
                    "encryptUin", "encrypt_uin", "str_musicid", "wxuin")
            if (encryptedUin == null || encryptedUin.isEmpty()) {
                encryptedUin = uin.toString()
            }
            val out = HashSet<String>()
            try {
                for (page in 0 until 8) {
                    val param = JSONObject()
                            .put("disstid", 0)
                            .put("dirid", 201)
                            .put("tag", true)
                            .put("song_begin", page * 100)
                            .put("song_num", 100)
                            .put("userinfo", true)
                            .put("orderlist", true)
                            .put("enc_host_uin", encryptedUin)
                    val payload = JSONObject()
                            .put("comm", qqComm(cookie, 24))
                            .put("req_0", JSONObject()
                                    .put("module", "music.srfDissInfo.DissInfo")
                                    .put("method", "CgiGetDiss")
                                    .put("param", param))
                    val body = musicuPost(payload, cookie)
                    val block = body?.optJSONObject("req_0")
                    if (block == null || block.optInt("code", -1) != 0) {
                        return null
                    }
                    val data = block.optJSONObject("data")
                    val songs = if (data == null) null
                    else (data.optJSONArray("songlist") ?: data.optJSONArray("songList"))
                    if (data == null || songs == null) {
                        return null
                    }
                    for (i in 0 until songs.length()) {
                        val song = songs.optJSONObject(i) ?: continue
                        val songMid = song.optString("mid", "")
                        if (!songMid.isEmpty()) out.add(songMid)
                        val songId = song.optLong("id", -1L)
                        if (songId > 0) out.add(songId.toString())
                    }
                    val total = data.optLong("total_song_num", data.optLong("total", -1L))
                    val hasMore = data.optBoolean("hasmore", false)
                            || (total > 0 && (page + 1) * 100 < total)
                    if (!hasMore || songs.length() == 0) {
                        Log.i(TAG, "qq liked list refreshed (" + out.size + " songs)")
                        return out
                    }
                    if (page == 7) {
                        // 封顶了还没完：半份名单不可信。
                        Log.i(TAG, "qq liked list capped at " + out.size + ", giving up")
                        return null
                    }
                }
                return out
            } catch (error: Exception) {
                Log.w(TAG, "qq liked list fetch failed", error)
                return null
            }
        }

        // ==================== 酷狗「我喜欢」名单（cloudlist 签名直连） ====================

        private fun kugouIsLiked(hash: String?, songId: String?): Boolean? {
            val cleanHash = hash?.trim()?.lowercase() ?: ""
            val cleanSongId = songId?.trim() ?: ""
            if (cleanHash.isEmpty() && cleanSongId.isEmpty()) {
                return null
            }
            val cookie = cookieFor("https://www.kugou.com/")
            val parsed = LikeFallback.parseCookie(cookie)
            val userId = digitsOr(LikeFallback.firstNonBlank(parsed, "userid", "KugooID"), "0")
            val token = LikeFallback.firstNonBlank(parsed, "token", "t")
            if ("0" == userId || token.isEmpty()) {
                return null
            }
            val list = kugouLikedList.snapshot(userId,
                    java.util.function.Supplier { fetchKugouLikedList(parsed, userId, token) })
            if (list == null) {
                return null
            }
            if (!cleanHash.isEmpty() && list.contains(cleanHash)) {
                return true
            }
            val digits = digitsOr(cleanSongId, "")
            return !digits.isEmpty() && !("0" == digits) && list.contains(digits)
        }

        /** 「我喜欢」歌单的 listid（进程内缓存；照 JS fetchKGFavoriteListId 的 cloudlist 通道）。 */
        @Volatile
        private var kgFavListId: String? = null

        @Volatile
        private var kgFavListIdUser: String? = null

        @Volatile
        private var kgFavListIdAtMs = 0L

        private fun fetchKgFavoriteListId(parsed: Map<String, String>, userId: String,
                                          token: String): String? {
            val now = android.os.SystemClock.elapsedRealtime()
            val cached = kgFavListId
            if (cached != null && !cached.isEmpty() && userId == kgFavListIdUser
                    && now - kgFavListIdAtMs < LIKED_TTL_MS) {
                return cached
            }
            for (type in intArrayOf(2, 0)) {
                try {
                    // body 的 key 顺序照 JS（JSON.stringify 按插入序）——签名按服务端收到的字节算。
                    val bodyJson = "{\"userid\":" + userId + ",\"token\":\"" + jsonEscape(token) +
                            "\",\"total_ver\":979,\"type\":" + type + ",\"page\":1,\"pagesize\":50}"
                    val body = kgPostCloudlist("/v7/get_all_list", bodyJson, true, parsed, userId, token)
                    val lists = extractKgCloudArray(body)
                    if (lists == null) continue
                    var listId = ""
                    var bestScore = -1
                    for (i in 0 until lists.length()) {
                        val item = lists.optJSONObject(i) ?: continue
                        val score = scoreKgFavoriteList(item)
                        if (score > bestScore) {
                            bestScore = score
                            val candidate = kgPlaylistListId(item)
                            if (!candidate.isEmpty()) listId = candidate
                        }
                    }
                    if (!listId.isEmpty()) {
                        kgFavListId = listId
                        kgFavListIdUser = userId
                        kgFavListIdAtMs = now
                        return listId
                    }
                } catch (ignored: Exception) {
                    // 换下一个 type 再试。
                }
            }
            return null
        }

        /** 照 JS scoreKGFavoriteList：名字/标记打分，挑最像「我喜欢」的那个。 */
        private fun scoreKgFavoriteList(item: JSONObject): Int {
            val name = firstNonBlank2(item, "name", "listname", "specialname", "list_name")
            val score: Int
            if (name.equals("我喜欢", ignoreCase = true)) {
                score = 1000
            } else if (name.contains("我喜欢")) {
                score = 800
            } else if (item.optInt("is_favorite", 0) == 1) {
                score = 700
            } else if (item.optInt("is_default", 0) == 1) {
                score = 500
            } else if (name.matches(Regex("(?i)默认收藏|红心|^favorite$"))) {
                score = 300
            } else if ("2" == kgPlaylistListId(item) && item.optInt("type", -1) != 1) {
                score = 200
            } else {
                return -1
            }
            var count = 0
            for (key in arrayOf("count", "song_count", "songcount", "count_total",
                        "total", "song_num", "trackCount", "track_count")) {
                val value = item.optInt(key, 0)
                if (value > 0) {
                    count = value
                    break
                }
            }
            return score + Math.min(500, count)
        }

        private fun kgPlaylistListId(item: JSONObject): String {
            val direct = firstNonBlank2(item, "listid", "list_id", "global_list_id", "listId")
            if (!direct.isEmpty()) return direct
            val globalId = firstNonBlank2(item, "global_collection_id", "globalCollectionId", "gid")
            val matcher = Pattern.compile("^collection_\\d+_\\d+_(\\d+)_\\d+$",
                    Pattern.CASE_INSENSITIVE).matcher(globalId)
            return if (matcher.find()) matcher.group(1) else ""
        }

        /** 照 JS extractKGCloudLists：响应里挑第一个像列表的数组。 */
        private fun extractKgCloudArray(body: JSONObject?): JSONArray? {
            if (body == null) return null
            val direct = body.optJSONArray("info")
            if (direct != null) return direct
            val data = body.optJSONObject("data")
            if (data != null) {
                for (key in arrayOf("info", "files", "songs", "list", "lists",
                            "playlist", "playlists", "list_info", "listInfo", "info_list",
                            "collection_list", "collections")) {
                    val value = data.optJSONArray(key)
                    if (value != null && value.length() > 0) return value
                }
                for (key in arrayOf("info", "files", "songs", "list", "lists")) {
                    val value = data.optJSONArray(key)
                    if (value != null) return value
                }
                val nested = data.optJSONObject("data")
                if (nested != null) {
                    for (key in arrayOf("info", "list", "files")) {
                        val value = nested.optJSONArray(key)
                        if (value != null && value.length() > 0) return value
                    }
                }
            }
            for (key in arrayOf("info", "list", "lists", "files")) {
                val value = body.optJSONArray(key)
                if (value != null && value.length() > 0) return value
            }
            return null
        }

        private fun fetchKugouLikedList(parsed: Map<String, String>,
                                        userId: String, token: String): MutableSet<String>? {
            try {
                val listId = fetchKgFavoriteListId(parsed, userId, token)
                if (listId == null || listId.isEmpty()) {
                    return null
                }
                val out = HashSet<String>()
                // 两页封顶 1000 首（JS 单页 500）；没拉完同样回 null 不缓存。
                for (page in 1..2) {
                    val bodyJson = "{\"listid\":" + digitsOr(listId, "0") + ",\"page\":" + page +
                            ",\"pagesize\":500,\"type\":0}"
                    val body = kgPostCloudlist("/v2/get_list_all_file", bodyJson, false, parsed, userId, token)
                    val tracks = extractKgCloudArray(body)
                    if (tracks == null || tracks.length() == 0) {
                        return if (page == 1) null else out
                    }
                    for (i in 0 until tracks.length()) {
                        val track = tracks.optJSONObject(i) ?: continue
                        val hash = firstNonBlank2(track, "hash", "FileHash", "HASH").lowercase()
                        if (!hash.isEmpty()) out.add(hash)
                        val mixId = firstNonBlank2(track, "mixsongid", "album_audio_id",
                                "AlbumAudioID", "MixSongID")
                        if (!mixId.isEmpty()) out.add(mixId)
                    }
                    if (tracks.length() < 500) {
                        Log.i(TAG, "kugou liked list refreshed (" + out.size + " songs)")
                        return out
                    }
                    if (page == 2) {
                        Log.i(TAG, "kugou liked list capped at " + out.size + ", giving up")
                        return null
                    }
                }
                return out
            } catch (error: Exception) {
                Log.w(TAG, "kugou liked list fetch failed", error)
                return null
            }
        }

        /**
         * cloudlist 网关的签名 POST，照 JS kgPostAndroidSigned：
         * 签名 = md5(盐 + 排序后 k=v 串 + body 原文 + 盐)，body 串必须与服务端
         * 收到的一字不差（所以这里手工拼 JSON，保持与 JS 一致的 key 顺序）。
         */
        private fun kgPostCloudlist(path: String, bodyJson: String, withPlat: Boolean,
                                    parsed: Map<String, String>, userId: String,
                                    token: String): JSONObject? {
            var dfid = LikeFallback.firstNonBlank(parsed, "dfid")
            if (dfid.isEmpty()) dfid = "-"
            val mid = kgMid()
            val clienttime = System.currentTimeMillis() / 1000L
            val params = java.util.TreeMap<String, String>()
            params.put("appid", KG_APPID)
            params.put("clienttime", clienttime.toString())
            params.put("clientver", KG_CLIENTVER)
            params.put("dfid", dfid)
            params.put("mid", mid)
            params.put("token", token)
            params.put("userid", userId)
            params.put("uuid", "-")
            if (withPlat) params.put("plat", "1")
            val paramsString = StringBuilder()
            val query = StringBuilder()
            for (entry in params.entries) {
                paramsString.append(entry.key).append('=').append(entry.value)
                query.append(if (query.isNotEmpty()) "&" else "")
                        .append(urlEncode(entry.key)).append('=').append(urlEncode(entry.value))
            }
            query.append("&signature=").append(urlEncode(
                    md5(KG_SIGN_SALT + paramsString + bodyJson + KG_SIGN_SALT)))
            val connection = (URL("https://gateway.kugou.com/cloudlist.service" + path + "?" + query)
                    .openConnection()) as HttpURLConnection
            try {
                connection.requestMethod = "POST"
                connection.connectTimeout = 8000
                connection.readTimeout = 10000
                connection.doOutput = true
                connection.setRequestProperty("Cookie", kgLeanCookie(parsed, userId, token, dfid))
                connection.setRequestProperty("User-Agent", KG_ANDROID_UA)
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty("dfid", dfid)
                connection.setRequestProperty("clienttime", clienttime.toString())
                connection.setRequestProperty("mid", mid)
                connection.setRequestProperty("kg-rc", "1")
                connection.setRequestProperty("kg-thash", "5d816a0")
                connection.setRequestProperty("kg-rec", "1")
                connection.setRequestProperty("kg-rf", "B9EDA08A64250DEFFBCADDEE00F8F25F")
                connection.setRequestProperty("x-router", "cloudlist.service.kugou.com")
                connection.outputStream.use { out ->
                    out.write(bodyJson.toByteArray(StandardCharsets.UTF_8))
                }
                val status = connection.responseCode
                val text = LikeFallback.readAll(connection)
                if (status < 200 || status >= 300 || text.isEmpty()) {
                    return null
                }
                return JSONObject(text)
            } finally {
                connection.disconnect()
            }
        }

        private fun jsonEscape(value: String?): String {
            return value?.replace("\\", "\\\\")
                    ?.replace("\"", "\\\"") ?: ""
        }

        /** firstNonBlank 的 JSONObject 版：第一个非空字段值。 */
        private fun firstNonBlank2(obj: JSONObject, vararg keys: String): String {
            for (key in keys) {
                val value = obj.optString(key, "")
                if (!value.isEmpty() && !("null" == value)) {
                    return value.trim()
                }
            }
            return ""
        }

        // ==================== 汽水「我喜欢」名单（协议页两跳） ====================

        private fun qishuiIsLiked(songId: String?): Boolean? {
            val id = songId?.trim() ?: ""
            if (id.isEmpty()) {
                return null
            }
            val list = qishuiLikedList.snapshot("host",
                    java.util.function.Supplier { fetchQishuiLikedList() })
            return if (list == null) null else list.contains(id)
        }

        /**
         * 两跳：user.playlists 找「我喜欢」（base_info.type === 1；车机协议把真歌单
         * 过滤掉后给的是虚拟 id qishui-liked）→ playlist.tracks 分页收曲目 id。
         */
        private fun fetchQishuiLikedList(): MutableSet<String>? {
            try {
                val playlistsBody = qishuiRequest("user.playlists", "{}")
                if (playlistsBody == null) {
                    return null
                }
                var likedId = ""
                for (arrayKey in arrayOf("playlists", "items")) {
                    val items = playlistsBody.optJSONArray(arrayKey)
                    if (items == null) continue
                    for (i in 0 until items.length()) {
                        val item = items.optJSONObject(i) ?: continue
                        // 照协议页 likedPlaylist 的取法：row.playlist || row。
                        var playlist = item.optJSONObject("playlist")
                        if (playlist == null) playlist = item
                        val base = playlist.optJSONObject("base_info")
                        val type = if (base == null) playlist.optInt("type", -1) else base.optInt("type", -1)
                        if (type != 1) continue
                        val candidate = if (base == null) playlist.optString("id", "") else base.optString("id", "")
                        if (!candidate.isEmpty()) {
                            likedId = candidate
                            break
                        }
                    }
                    if (!likedId.isEmpty()) break
                }
                if (likedId.isEmpty()) {
                    likedId = "qishui-liked"
                }
                val out = HashSet<String>()
                for (page in 0 until 4) {
                    val body = qishuiRequest("playlist.tracks",
                            qishuiParams("id", likedId, "limit", "500", "offset",
                                    (page * 500).toString()))
                    if (body == null) {
                        return if (page == 0) null else out
                    }
                    var tracks = body.optJSONArray("tracks")
                    if (tracks == null) tracks = body.optJSONArray("songs")
                    if (tracks == null || tracks.length() == 0) {
                        return if (page == 0) null else out
                    }
                    for (i in 0 until tracks.length()) {
                        val track = tracks.optJSONObject(i)
                        val trackId = track?.optString("id", "") ?: ""
                        if (!trackId.isEmpty()) out.add(trackId)
                    }
                    if (!body.optBoolean("hasMore", false) || tracks.length() < 500) {
                        Log.i(TAG, "qishui liked list refreshed (" + out.size + " songs)")
                        return out
                    }
                    if (page == 3) {
                        Log.i(TAG, "qishui liked list capped at " + out.size + ", giving up")
                        return null
                    }
                }
                return out
            } catch (error: Exception) {
                Log.w(TAG, "qishui liked list fetch failed", error)
                return null
            }
        }

        // ==================== 飞牛「我喜欢」名单（favorite-track/list） ====================

        private fun feiniuIsLiked(songId: String?): Boolean? {
            val id = songId?.trim() ?: ""
            val creds = feiniuCreds
            if (id.isEmpty() || creds == null) {
                return null
            }
            val list = feiniuLikedList.snapshot(
                    creds.serverUrl + "|" + creds.token,
                    java.util.function.Supplier { fetchFeiniuLikedList(creds) })
            return if (list == null) null else list.contains(id)
        }

        private fun fetchFeiniuLikedList(creds: FeiniuCredentials): MutableSet<String>? {
            val out = HashSet<String>()
            try {
                for (page in 1..5) {
                    val connection = URL(
                            creds.serverUrl + "/music/api/v1/favorite-track/list?page=" + page +
                                    "&size=200").openConnection() as HttpURLConnection
                    val body: JSONObject = try {
                        connection.connectTimeout = 8000
                        connection.readTimeout = 10000
                        connection.setRequestProperty("Cookie", feiniuCookieValue(creds))
                        connection.setRequestProperty("Accept", "application/json")
                        val status = connection.responseCode
                        val text = LikeFallback.readAll(connection)
                        if (status < 200 || status >= 300 || text.isEmpty()) {
                            return if (page == 1) null else out
                        }
                        JSONObject(text)
                    } finally {
                        connection.disconnect()
                    }
                    // 数组字段照 pickFeiniuList 的 LIST_KEYS 顺序。
                    var items: JSONArray? = null
                    for (key in arrayOf("list", "tracks", "items", "songs",
                                "records", "rows", "data")) {
                        var value = body.optJSONArray(key)
                        if (value == null) {
                            val data = body.optJSONObject("data")
                            if (data != null) value = data.optJSONArray(key)
                        }
                        if (value != null && value.length() > 0) {
                            items = value
                            break
                        }
                    }
                    if (items == null || items.length() == 0) {
                        return if (page == 1) null else out
                    }
                    for (i in 0 until items.length()) {
                        val item = items.optJSONObject(i)
                        val guid = item?.optString("guid", "") ?: ""
                        if (!guid.isEmpty()) out.add(guid)
                    }
                    if (items.length() < 200) {
                        Log.i(TAG, "feiniu liked list refreshed (" + out.size + " songs)")
                        return out
                    }
                    if (page == 5) {
                        Log.i(TAG, "feiniu liked list capped at " + out.size + ", giving up")
                        return null
                    }
                }
                return out
            } catch (error: Exception) {
                Log.w(TAG, "feiniu liked list fetch failed", error)
                return null
            }
        }

        /**
         * 取流 / 缓存下载时要附带的请求头：目前只有飞牛要带会话 Cookie
         * （它的音频流认 music-token，不认就不给字节）。其余平台回空表。
         */
        @JvmStatic
        fun headersForPlaybackUrl(url: String?): Map<String, String> {
            val creds = feiniuCreds
            if (creds == null || url == null || !url.startsWith(creds.serverUrl)) {
                return Collections.emptyMap()
            }
            return Collections.singletonMap("Cookie", feiniuCookieValue(creds))
        }

        // ==================== 网易云（weapi 直连） ====================

        private fun neteasePlayUrl(songId: String?): String? {
            val id = parseSongId(songId)
            if (id <= 0) {
                return null
            }
            val cookie = cookieFor("https://music.163.com/")
            // v1 按音质档回地址；标准档免费账号必得。空了再试老接口（br 直报码率）。
            val data = JSONObject()
                    .put("ids", JSONArray().put(id))
                    .put("level", "standard")
                    .put("encodeType", "flac")
                    .put("csrf_token", csrfOf(cookie))
            val url = urlOfNeteaseSongUrl(weapiPost("/api/song/enhance/player/url/v1", data, cookie))
            if (url != null && !url.isEmpty()) {
                return url
            }
            val legacy = JSONObject()
                    .put("ids", JSONArray().put(id))
                    .put("br", 128000)
                    .put("csrf_token", csrfOf(cookie))
            return urlOfNeteaseSongUrl(weapiPost("/api/song/enhance/player/url", legacy, cookie))
        }

        private fun urlOfNeteaseSongUrl(body: JSONObject?): String? {
            val data = body?.optJSONArray("data")
            if (data != null && data.length() > 0) {
                val first = data.optJSONObject(0)
                if (first != null) {
                    val url = first.optString("url", "")
                    if (!url.isEmpty()) {
                        return url
                    }
                }
            }
            return null
        }

        /**
         * 网易歌词：要整行（lrc）也**要逐字（yrc）**。
         *
         * yv 以前填的是 0，平台只回整行 LRC —— 原生兜底（WebView 冻结时）喂给壁纸的
         * 时间轴就只有整行，那一段的逐字动画自然没了。这里把 yv 打开，平台回 yrc
         * 时用逐字那份；没有逐字（很多歌本来就没有）就仍用 lrc，与以前一致。
         * 翻译同时要把逐字的翻译（ytlrc）带上，否则逐字那份会丢翻译。
         */
        private fun neteaseLyric(songId: String?): Lyric? {
            val id = parseSongId(songId)
            if (id <= 0) {
                return null
            }
            val cookie = cookieFor("https://music.163.com/")
            val data = JSONObject()
                    .put("id", id)
                    .put("cp", false)
                    .put("tv", 0).put("lv", 0).put("rv", 0).put("kv", 0)
                    .put("yv", 1).put("ytv", 0).put("yrv", 0)
                    .put("csrf_token", csrfOf(cookie))
            val body = weapiPost("/api/song/lyric/v1", data, cookie)
            val yrc = textOf(body.optJSONObject("yrc"))
            val ytlrc = textOf(body.optJSONObject("ytlrc"))
            if (!yrc.isEmpty()) {
                return Lyric(yrc, if (!ytlrc.isEmpty()) ytlrc else textOf(body.optJSONObject("tlyric")))
            }
            return Lyric(
                    textOf(body.optJSONObject("lrc")),
                    textOf(body.optJSONObject("tlyric")))
        }

        private fun textOf(block: JSONObject?): String {
            return block?.optString("lyric", "") ?: ""
        }

        /** weapi 一发：表单里只有 params 与 encSecKey 两个 WangHome 加密产物。 */
        private fun weapiPost(path: String, data: JSONObject, cookie: String?): JSONObject {
            val encrypted = WeapiCrypto.encrypt(data.toString())
            val form = StringBuilder()
                    .append("params=").append(urlEncode(encrypted[0]))
                    .append("&encSecKey=").append(urlEncode(encrypted[1]))
            val connection = (URL("https://music.163.com/weapi/" +
                    path.replaceFirst(Regex("^/+"), "").replaceFirst(Regex("^api/"), ""))
                    .openConnection()) as HttpURLConnection
            try {
                connection.requestMethod = "POST"
                connection.connectTimeout = 8000
                connection.readTimeout = 10000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
                connection.setRequestProperty("User-Agent", UA)
                connection.setRequestProperty("Referer", "https://music.163.com/")
                if (cookie != null && !cookie.isEmpty()) {
                    connection.setRequestProperty("Cookie", cookie)
                }
                connection.outputStream.use { out ->
                    out.write(form.toString().toByteArray(StandardCharsets.UTF_8))
                }
                val status = connection.responseCode
                val text = LikeFallback.readAll(connection)
                if (status < 200 || status >= 300) {
                    throw IllegalStateException("HTTP " + status + " @ " + path)
                }
                return JSONObject(text)
            } finally {
                connection.disconnect()
            }
        }

        // ==================== QQ（musicu 直连） ====================

        private fun qqPlayUrl(mid: String?): String? {
            if (mid == null || mid.isEmpty()) {
                return null
            }
            val cookie = cookieFor("https://u.y.qq.com/")
            val comm = qqComm(cookie, 24)
            val uin = comm.optLong("uin", 0L)
            val mids = JSONArray().put(mid)
            val param = JSONObject()
                    .put("guid", randomGuid())
                    .put("songmid", mids)
                    .put("songtype", JSONArray().put(0))
                    .put("uin", uin)
                    .put("loginflag", 1)
                    .put("platform", "20")
            val payload = JSONObject()
                    .put("comm", comm)
                    .put("req_0", JSONObject()
                            .put("module", "vkey.GetVkeyServer")
                            .put("method", "CgiGetVkey")
                            .put("param", param))
            val body = musicuPost(payload, cookie)
            val block = body?.optJSONObject("req_0")
            val data = block?.optJSONObject("data")
            val infos = data?.optJSONArray("midurlinfo")
            if (data == null || infos == null) {
                return null
            }
            for (i in 0 until infos.length()) {
                val info = infos.optJSONObject(i)
                val purl = info?.optString("purl", "") ?: ""
                if (!purl.isEmpty()) {
                    var sip = QQ_FALLBACK_SIP
                    val sips = data.optJSONArray("sip")
                    if (sips != null && sips.length() > 0 && !sips.optString(0, "").isEmpty()) {
                        sip = sips.optString(0)
                    }
                    return sip + purl
                }
            }
            return null
        }

        private fun qqLyric(songId: String?, mid: String?): Lyric? {
            val param = JSONObject()
            if (mid != null && !mid.isEmpty()) {
                param.put("songMID", mid)
            }
            val id = parseSongId(songId)
            if (id > 0) {
                param.put("songID", id)
            }
            if (param.length() == 0) {
                return null
            }
            val payload = JSONObject()
                    .put("comm", JSONObject().put("ct", 24).put("cv", 0))
                    .put("lyric", JSONObject()
                            .put("module", "music.musichallSong.PlayLyricInfo")
                            .put("method", "GetPlayLyricInfo")
                            .put("param", param))
            val body = musicuPost(payload, cookieFor("https://u.y.qq.com/"))
            val block = body.optJSONObject("lyric")
            val data = block?.optJSONObject("data")
            if (data == null) {
                return null
            }
            return Lyric(decodeQQLyricText(data.optString("lyric", "")),
                    decodeQQLyricText(data.optString("trans", "")))
        }

        /**
         * comm 照 buildQQAuthComm：没登录是匿名脸（ct 24），有会话换网页脸（ct 19）带
         * authst；微信通道要 tmeLoginType。照抄 {@link QqLikeClient} 的取法。
         */
        private fun qqComm(cookie: String?, anonymousCt: Int): JSONObject {
            val parsed = LikeFallback.parseCookie(cookie)
            val musicKey = LikeFallback.firstNonBlank(parsed, "qm_keyst", "qqmusic_key",
                    "music_key", "p_skey", "skey", "psrf_qqaccess_token", "psrf_qqrefresh_token",
                    "wxrefresh_token", "wxskey")
            val comm = JSONObject()
                    .put("uin", qqUinOf(parsed))
                    .put("format", "json")
                    .put("ct", if (musicKey.isEmpty()) anonymousCt else 19)
                    .put("cv", 0)
                    .put("platform", "yqq.json")
            if (!musicKey.isEmpty()) {
                comm.put("authst", musicKey)
                val loginType = parsed["tmeLoginType"]
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
            }
            return comm
        }

        /** uin 取法照 qqCookieUin：微信通道（login_type=2）先 wxuin，QQ 通道先 uin。 */
        private fun qqUinOf(cookie: Map<String, String>): Long {
            val loginType = cookie["login_type"]
            val raw: String?
            if ("2" == (loginType?.trim() ?: "")) {
                raw = LikeFallback.firstNonBlank(cookie, "wxuin", "uin", "p_uin")
            } else {
                raw = LikeFallback.firstNonBlank(cookie, "uin", "qqmusic_uin", "wxuin", "p_uin")
            }
            val digits = raw?.replace(Regex("\\D"), "") ?: ""
            val stripped = digits.replaceFirst(Regex("^0+"), "")
            return try {
                (if (stripped.isEmpty()) digits else stripped).toLong()
            } catch (error: NumberFormatException) {
                0L
            }
        }

        private fun musicuPost(payload: JSONObject, cookie: String?): JSONObject {
            val connection = URL(MUSICU).openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "POST"
                connection.connectTimeout = 8000
                connection.readTimeout = 10000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json;charset=UTF-8")
                connection.setRequestProperty("Referer", "https://y.qq.com/")
                connection.setRequestProperty("User-Agent", UA)
                if (cookie != null && !cookie.isEmpty()) {
                    connection.setRequestProperty("Cookie", cookie)
                }
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

        /**
         * QQ 歌词的皮：多数时候就是 base64 过一道，剥了就是普通 LRC。
         * 照 decodeQQLyricText：没有 '[' 且看着像 base64 才解，解完还得像歌词才认。
         */
        private fun decodeQQLyricText(text: String?): String {
            var raw = text?.trim() ?: ""
            if (raw.isEmpty()) {
                return ""
            }
            if (!raw.contains("[") && raw.replace(Regex("\\s+"), "")
                        .matches(Regex("[A-Za-z0-9+/=]+"))) {
                try {
                    val bytes = android.util.Base64.decode(
                            raw.replace(Regex("\\s+"), ""), android.util.Base64.DEFAULT)
                    val decoded = String(bytes, StandardCharsets.UTF_8)
                    if (decoded.contains("[") || decoded.matches(Regex(".*[\\u4e00-\\u9fa5].*"))) {
                        raw = decoded
                    }
                } catch (ignored: IllegalArgumentException) {
                    // 不是 base64 就按原文用。
                }
            }
            return raw.replace("\r\n", "\n").trim()
        }

        // ==================== 酷狗（Android 网关签名直连） ====================

        private const val KG_ANDROID_UA =
                "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi"
        private const val KG_SIGN_SALT = "LnT6xpN3khm36zse0QzvmgTZ3waWdRSA"
        private const val KG_TRACKER_SECRET = "185672dd44712f60bb1736df5a377e82"
        private const val KG_APPID = "3116"
        private const val KG_CLIENTVER = "11440"
        private const val KG_TRACKER_CLIENTVER = "11430"
        private const val KG_SONG_PAGE_ID = "967177915"
        private const val KG_SONG_PPID = "356753938,823673182,967485191"
        private const val KG_SONG_PID = "411"

        @Volatile
        private var kgMidCache: String? = null

        private fun kugouPlayUrl(hash: String?, albumAudioId: String?): String? {
            val cleanHash = hash?.trim()?.lowercase() ?: ""
            if (cleanHash.isEmpty()) {
                return null
            }
            val cookie = cookieFor("https://www.kugou.com/")
            val parsed = LikeFallback.parseCookie(cookie)
            val userId = digitsOr(LikeFallback.firstNonBlank(parsed, "userid", "KugooID"), "0")
            val token = LikeFallback.firstNonBlank(parsed, "token", "t")
            // 没有会话（游客）时 /v5/url 不回地址：直接放弃，等 JS 那边的游客通道。
            if ("0" == userId || token.isEmpty()) {
                return null
            }
            val mid = kgMid()
            var dfid = LikeFallback.firstNonBlank(parsed, "dfid")
            if (dfid.isEmpty()) {
                dfid = "-"
            }
            val clienttime = System.currentTimeMillis() / 1000L
            // 参数表照 KuGouMusicApi song_url：key 与 signature 的拼法一字不差。
            val params = java.util.TreeMap<String, String>()
            params.put("album_id", "0")
            params.put("album_audio_id", digitsOr(albumAudioId, "0"))
            params.put("area_code", "1")
            params.put("behavior", "play")
            params.put("hash", cleanHash)
            params.put("cmd", "26")
            params.put("pid", KG_SONG_PID)
            params.put("pidversion", "3001")
            params.put("IsFreePart", "0")
            params.put("cdnBackup", "1")
            params.put("module", "")
            params.put("page_id", KG_SONG_PAGE_ID)
            params.put("ppage_id", KG_SONG_PPID)
            params.put("quality", "128")
            params.put("ssa_flag", "is_fromtrack")
            params.put("version", KG_TRACKER_CLIENTVER)
            params.put("clientver", KG_TRACKER_CLIENTVER)
            params.put("appid", KG_APPID)
            params.put("clienttime", clienttime.toString())
            params.put("dfid", dfid)
            params.put("mid", mid)
            params.put("uuid", "-")
            params.put("userid", userId)
            params.put("token", token)
            // key 兼容官方 signKey：md5(hash + secret + appid + mid + userid)。
            val trackerKey = md5(cleanHash + KG_TRACKER_SECRET + KG_APPID + mid + userId)
            val paramsString = StringBuilder()
            for (entry in params.entries) {
                paramsString.append(entry.key).append('=').append(entry.value)
            }
            val signature = md5(KG_SIGN_SALT + paramsString + trackerKey + KG_SIGN_SALT)
            val query = StringBuilder()
            for (entry in params.entries) {
                query.append(if (query.isNotEmpty()) "&" else "")
                        .append(urlEncode(entry.key)).append('=').append(urlEncode(entry.value))
            }
            query.append("&key=").append(urlEncode(trackerKey))
                    .append("&signature=").append(urlEncode(signature))
            val connection = (URL("https://gateway.kugou.com/v5/url?" + query)
                    .openConnection()) as HttpURLConnection
            try {
                connection.connectTimeout = 8000
                connection.readTimeout = 10000
                connection.setRequestProperty("Cookie", kgLeanCookie(parsed, userId, token, dfid))
                connection.setRequestProperty("User-Agent", KG_ANDROID_UA)
                connection.setRequestProperty("dfid", dfid)
                connection.setRequestProperty("clienttime", clienttime.toString())
                connection.setRequestProperty("mid", mid)
                connection.setRequestProperty("kg-rc", "1")
                connection.setRequestProperty("kg-thash", "5d816a0")
                connection.setRequestProperty("kg-rec", "1")
                connection.setRequestProperty("kg-rf", "B9EDA08A64250DEFFBCADDEE00F8F25F")
                connection.setRequestProperty("x-router", "trackercdn.kugou.com")
                val status = connection.responseCode
                val text = LikeFallback.readAll(connection)
                if (status < 200 || status >= 300) {
                    return null
                }
                return parseKgPlayUrl(JSONObject(text))
            } finally {
                connection.disconnect()
            }
        }

        /** 照 parseKGPlayUrl：url / backupUrl / data.url 里挑第一个像 http 的。 */
        private fun parseKgPlayUrl(body: JSONObject?): String? {
            if (body == null) {
                return null
            }
            val fields = arrayOf("url", "backupUrl", "backup_url")
            for (field in fields) {
                val value = body.opt(field)
                val hit = firstHttpOf(value)
                if (hit != null) {
                    return hit
                }
            }
            val data = body.optJSONObject("data")
            if (data != null) {
                for (field in fields) {
                    val hit = firstHttpOf(data.opt(field))
                    if (hit != null) {
                        return hit
                    }
                }
            }
            return null
        }

        private fun firstHttpOf(value: Any?): String? {
            if (value is JSONArray) {
                for (i in 0 until value.length()) {
                    val item = value.optString(i, "")
                    if (item.startsWith("http://") || item.startsWith("https://")) {
                        return item
                    }
                }
                return null
            }
            if (value is String) {
                val text = value.trim()
                return if (text.startsWith("http://") || text.startsWith("https://")) text else null
            }
            return null
        }

        /**
         * 酷狗歌词的简单通道：m.kugou.com/krc/&lt;hash&gt;.lrc 直出普通 LRC 文本，
         * 不用解 KRC（那套 XOR + zlib 只在逐字轴那条路才需要，壁纸时间轴用不上）。
         */
        private fun kugouLyric(hash: String?): Lyric? {
            val cleanHash = hash?.trim() ?: ""
            if (cleanHash.isEmpty()) {
                return null
            }
            val connection = (URL("https://m.kugou.com/krc/" + cleanHash + ".lrc")
                    .openConnection()) as HttpURLConnection
            try {
                connection.connectTimeout = 8000
                connection.readTimeout = 10000
                connection.setRequestProperty("User-Agent", KG_ANDROID_UA)
                connection.setRequestProperty("Referer", "https://m.kugou.com/")
                val status = connection.responseCode
                val text = LikeFallback.readAll(connection)
                if (status < 200 || status >= 300 || text.isEmpty()) {
                    return null
                }
                return Lyric(text, "")
            } finally {
                connection.disconnect()
            }
        }

        /** 精简 cookie：KuGoo 大 Blob 会把网关请求顶爆，只带身份四件套。 */
        private fun kgLeanCookie(parsed: Map<String, String>, userId: String, token: String,
                                 dfid: String): String {
            val builder = StringBuilder()
            if ("0" != userId) {
                builder.append("userid=").append(userId).append("; KugooID=").append(userId).append("; ")
            }
            if (!token.isEmpty()) {
                builder.append("token=").append(token).append("; t=").append(token).append("; ")
            }
            if (!dfid.isEmpty() && "-" != dfid) {
                builder.append("dfid=").append(dfid).append("; ")
            }
            return builder.toString()
        }

        /** mid：官方客户端是 32 位 md5 hex；进程内生成一次就钉住（设备身份的语义）。 */
        private fun kgMid(): String {
            if (kgMidCache == null) {
                synchronized(MusicGateway::class.java) {
                    if (kgMidCache == null) {
                        val fresh = md5("mineradio_" + System.currentTimeMillis() + "_" + Math.random())
                        // 算不出来就这次先用着、**不写进缓存**：写进去（尤其是空串）之后
                        // 整个进程的酷狗请求都会带着一个空 mid，而且再也没有重算的机会。
                        // 正常情况下 MD5 不会不可用，但「缓存了一个坏值」是不可逆的。
                        if (fresh.isEmpty()) return ""
                        kgMidCache = fresh
                    }
                }
            }
            return kgMidCache!!
        }

        private fun md5(value: String): String {
            try {
                val digest = java.security.MessageDigest.getInstance("MD5")
                val bytes = digest.digest(value.toByteArray(StandardCharsets.UTF_8))
                val builder = StringBuilder()
                for (item in bytes) {
                    builder.append(String.format("%02x", item))
                }
                return builder.toString()
            } catch (error: Exception) {
                return ""
            }
        }

        private fun digitsOr(value: String?, fallback: String): String {
            val digits = value?.replace(Regex("\\D"), "") ?: ""
            return if (digits.isEmpty()) fallback else digits
        }

        // ==================== LRC → 时间轴 ====================

        /** `[mm:ss.xx]` / `[mm:ss]`；分带毫秒 1~3 位。 */
        private val TIMESTAMP = Pattern.compile("\\[(\\d{1,3}):(\\d{1,2})(?:[.:](\\d{1,3}))?\\]")

        /**
         * 把主 LRC 与翻译 LRC 拼成壁纸的时间轴：每行 start 到下一行 start，翻译按
         * 时间戳对上就带上。解不出行（纯音乐、格式不认识）回空表，调用方保持原状。
         */
        @JvmStatic
        fun parseLrc(mainLrc: String?, transLrc: String?): List<WallpaperLyricsState.TimedLine> {
            val stamps = ArrayList<LongArray>()
            val texts = ArrayList<String>()
            collectLrcLines(mainLrc, stamps, texts)
            if (stamps.isEmpty()) {
                return Collections.emptyList()
            }
            val translations = LinkedHashMap<Long, String>()
            if (transLrc != null && !transLrc.isEmpty()) {
                val transStamps = ArrayList<LongArray>()
                val transTexts = ArrayList<String>()
                collectLrcLines(transLrc, transStamps, transTexts)
                var i = 0
                while (i < transStamps.size && i < transTexts.size) {
                    val value = transTexts[i].trim()
                    if (!value.isEmpty()) {
                        translations.putIfAbsent(transStamps[i][0], value)
                    }
                    i += 1
                }
            }
            // 同一毫秒的多段（LRC 偶见）：按时间排序后并进同一行，结束时间取下一行的起点。
            val order = ArrayList<Int>()
            for (i in stamps.indices) {
                order.add(i)
            }
            order.sortWith { a, b -> stamps[a][0].compareTo(stamps[b][0]) }
            val lines = ArrayList<WallpaperLyricsState.TimedLine>()
            var index = 0
            while (index < order.size) {
                val start = stamps[order[index]][0]
                val merged = StringBuilder()
                var end = start
                val translation = translations[start]
                while (index < order.size && stamps[order[index]][0] == start) {
                    val text = texts[order[index]].trim()
                    if (!text.isEmpty()) {
                        if (merged.length > 0) {
                            merged.append(' ')
                        }
                        merged.append(text)
                    }
                    index += 1
                    // 这一段的结束时间先记下：它就是「下一行起点」的候选。
                    end = if (index < order.size) stamps[order[index]][0] else start + 8000L
                }
                val value = merged.toString().trim()
                if (!value.isEmpty()) {
                    lines.add(WallpaperLyricsState.TimedLine(value, start,
                            Math.max(end, start + 1L), translation))
                }
            }
            return lines
        }

        private fun collectLrcLines(lrc: String?, stamps: MutableList<LongArray>,
                                    texts: MutableList<String>) {
            if (lrc == null || lrc.isEmpty()) {
                return
            }
            for (rawLine in lrc.split("\n")) {
                val line = rawLine.replace("\r", "")
                // 行首连着的若干时间戳（同一句多次入场很常见），之后是这一段的文本。
                // 行首不是时间戳的（[ti:]、[offset:] 这些元数据）整行跳过。
                val matcher = TIMESTAMP.matcher(line)
                val lineStamps = ArrayList<Long>()
                var textStart = -1
                var position = 0
                while (position < line.length && line[position] == '['
                        && matcher.region(position, line.length).lookingAt()) {
                    val minutes: String = matcher.group(1)
                    val seconds: String = matcher.group(2)
                    var ms = minutes.toLong() * 60_000L + seconds.toLong() * 1000L
                    val fraction = matcher.group(3)
                    if (fraction != null) {
                        val scale = Math.pow(10.0, (3 - fraction.length).toDouble())
                        ms += (fraction.toLong() * scale).toLong()
                    }
                    lineStamps.add(Math.max(0L, ms))
                    position = matcher.end()
                    textStart = position
                }
                if (lineStamps.isEmpty()) {
                    continue
                }
                val text = if (textStart < line.length) line.substring(textStart).trim() else ""
                for (ms in lineStamps) {
                    stamps.add(longArrayOf(ms))
                    texts.add(text)
                }
            }
        }

        // ==================== 杂项 ====================

        private fun cookieFor(url: String): String? {
            try {
                return CookieManager.getInstance().getCookie(url)
            } catch (error: Throwable) {
                Log.w(TAG, "CookieManager unavailable", error)
                return null
            }
        }

        private fun csrfOf(cookie: String?): String {
            val csrf = LikeFallback.firstNonBlank(LikeFallback.parseCookie(cookie), "__csrf")
            return if (csrf.isEmpty()) "" else csrf
        }

        private fun parseSongId(songId: String?): Long {
            try {
                val id = (if (songId == null) "" else songId.trim()).toLong()
                return if (id > 0) id else -1L
            } catch (error: NumberFormatException) {
                return -1L
            }
        }

        private fun urlEncode(value: String): String {
            try {
                return java.net.URLEncoder.encode(value, "UTF-8")
            } catch (error: Exception) {
                return ""
            }
        }

        /** CgiGetVkey 的 guid：十位数字串，官方网页端就是这个形状。 */
        private fun randomGuid(): String {
            val builder = StringBuilder()
            val random = Random()
            for (i in 0 until 10) {
                builder.append(random.nextInt(10))
            }
            return builder.toString()
        }
    }
}
