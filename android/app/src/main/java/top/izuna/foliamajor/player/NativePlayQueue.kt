package top.izuna.foliamajor.player

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

// android/app/src/main/java/top/izuna/foliamajor/player/NativePlayQueue.kt
// 原生侧的播放队列：**播放链路的真相在这里，不在 WebView 里**。
//
// 之前的状态是「前台持有队列，原生只是个被驱动的执行器」：WebView 被系统冻结（锁屏、
// 切后台久了）之后 JS 不再运行，队列就没人推进了 —— 用户报的「前台冻结时暂停后无法
// 继续播放」「放完不自动下一首」「切歌单后音源不换」都是同一件事的不同侧面。
//
// 现在改成：前台只下发「播放这个队列 / 切到第几首 / 用什么循环模式」这类**意图**，
// 之后所有的推进（自动下一首、循环回绕、单曲循环、随机、地址解析失败重试）都由这里
// 自己完成，不叫醒前台也能继续。
//
// 前台回来时用 snapshot() 拉一次，按它渲染即可 —— 前台不再需要「我记得上一首是什么」
// 这类增量推断，那正是歌词 / 主题跟不上、切歌单后音源不换的根源。

/** 一首歌在原生队列里的样子。只留播放与重试真正要用的字段。 */
data class NativeQueueEntry(
    /** 稳定身份（providerId:songId），前台用它认领「这首是不是当前这首」。 */
    val songKey: String,
    val providerId: String,
    val songId: String,
    val mid: String,
    val hash: String,
    val albumAudioId: String,
    /** 前台已经解析好的地址。可为空 —— 空的时候由原生自己向平台要。 */
    val url: String,
    val title: String,
    val artist: String,
    val album: String,
    val coverUrl: String,
    val durationSec: Double,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("songKey", songKey)
        put("providerId", providerId)
        // 两套字段名都写：服务里读镜像的几处（resolveMirrorEntryAsync、
        // fetchLyricForNativePlayback）用的还是 serverSongId / providerMid 这一族，
        // 少一套那边就拿到空 —— 与 fromJson 的兼容同理，状态机的条目要能原样
        // 回到服务的旧读取点。
        put("songId", songId)
        put("serverSongId", songId)
        put("mid", mid)
        put("providerMid", mid)
        put("hash", hash)
        put("providerHash", hash)
        put("albumAudioId", albumAudioId)
        put("providerAlbumAudioId", albumAudioId)
        put("url", url)
        put("title", title)
        put("artist", artist)
        put("album", album)
        put("coverUrl", coverUrl)
        put("artworkUrl", coverUrl)
        put("durationSec", durationSec)
        put("durationMs", Math.round(durationSec * 1000))
    }

    companion object {
        /*
         * 字段名要兼容两套：Web 推的镜像 JSON（buildQueueMirrorEntry）用
         * serverSongId / providerMid / providerHash / providerAlbumAudioId /
         * durationMs / artworkUrl，而状态机自己的 toJson 用 songId / mid / hash /
         * albumAudioId / durationSec / coverUrl。只认一套的话，从 playFromQueue 或
         * 镜像推送喂进来的条目身份全是空 —— 放完一首后 playQueueEntry 把它交给
         * resolveMirrorEntryAsync，那边读 serverSongId 拿到空，直接 return：
         * 自动下一首无声卡死，而且是只在「没走过 Web 全流程」的场合才犯。
         */
        fun fromJson(o: JSONObject): NativeQueueEntry = NativeQueueEntry(
            songKey = o.optString("songKey", ""),
            providerId = o.optString("providerId", ""),
            songId = firstNonEmpty(o, "songId", "serverSongId"),
            mid = firstNonEmpty(o, "mid", "providerMid"),
            hash = firstNonEmpty(o, "hash", "providerHash"),
            albumAudioId = firstNonEmpty(o, "albumAudioId", "providerAlbumAudioId"),
            url = firstNonEmpty(o, "url", "resolvedUrl"),
            title = o.optString("title", ""),
            artist = o.optString("artist", ""),
            album = o.optString("album", ""),
            coverUrl = firstNonEmpty(o, "coverUrl", "artworkUrl"),
            durationSec = if (o.has("durationSec")) o.optDouble("durationSec", 0.0)
            else o.optLong("durationMs", 0L) / 1000.0,
        )

        /** 第一个非空字段：两套字段名里谁有值用谁。 */
        private fun firstNonEmpty(o: JSONObject, vararg names: String): String {
            for (name in names) {
                if (o.isNull(name)) continue
                val value = o.optString(name, "")
                if (value.isNotEmpty() && value != "null") return value
            }
            return ""
        }

        fun fromArray(json: String?): List<NativeQueueEntry> {
            if (json.isNullOrEmpty()) return emptyList()
            return try {
                val array = JSONArray(json)
                (0 until array.length()).mapNotNull { i ->
                    array.optJSONObject(i)?.let { runCatching { fromJson(it) }.getOrNull() }
                }
            } catch (error: Throwable) {
                Log.w("NativePlayQueue", "解析队列失败", error)
                emptyList()
            }
        }
    }
}

/**
 * 循环模式。与 Web 侧 `useAudioSettingsStore` 的取值保持一致，但它**归原生所有** ——
 * 前台改了模式就下发一次，之后由原生自己按它决定放完之后往哪走。
 */
enum class NativeLoopMode(val wire: String) {
    /** 顺序播放：放完最后一首就停。 */
    OFF("off"),

    /** 列表循环：放到最后一首绕回第一首。 */
    ALL("all"),

    /** 单曲循环：同一首反复，不换曲目。 */
    ONE("one");

    companion object {
        fun fromWire(value: String?): NativeLoopMode =
            entries.firstOrNull { it.wire == value } ?: OFF
    }
}

/**
 * 一首歌确实放不了（地址重试过也拿不到）时该怎么做。
 *
 * 抽成纯函数是因为这个决定有两条边界容易写错：设置关掉时不该自作主张跳过，
 * 而设置开着时也不能无限跳 —— 整个歌单都无版权的情况会一路把队列扫空，
 * 用户只看到「自己一直在跳歌」。
 */
enum class UnplayableDecision {
    /** 跳到下一首继续。 */
    SKIP_NEXT,

    /** 停下，保留当前这首，让人自己决定。 */
    STOP,
}

/**
 * @param autoSkip 设置里的「自动跳过无法播放的歌曲」
 * @param consecutiveSkips 已经连续跳过多少首了（任何一首成功起播都会清零）
 */
fun decideOnUnplayable(
    autoSkip: Boolean,
    consecutiveSkips: Int,
    maxConsecutiveSkips: Int = 5,
): UnplayableDecision = when {
    !autoSkip -> UnplayableDecision.STOP
    consecutiveSkips >= maxConsecutiveSkips -> UnplayableDecision.STOP
    else -> UnplayableDecision.SKIP_NEXT
}

/**
 * 队列状态机。**不碰 ExoPlayer、不碰线程**：它只回答「下一首是哪首」「该不该停」，
 * 由 FoliaPlaybackService 在它给出的答案上做真正的换源。这样它可以脱离播放器单测。
 */
class NativePlayQueue {    private val entries = mutableListOf<NativeQueueEntry>()
    private var index = -1

    var loopMode: NativeLoopMode = NativeLoopMode.OFF
        private set

    /** 随机播放。开启时前进方向取随机下标，后退仍按顺序（与 Web 层一致）。 */
    var shuffle: Boolean = false
        private set

    fun setLoopMode(mode: NativeLoopMode) {
        loopMode = mode
    }

    fun setShuffle(enabled: Boolean) {
        shuffle = enabled
    }

    fun size(): Int = entries.size

    fun currentIndex(): Int = index

    fun current(): NativeQueueEntry? = entries.getOrNull(index)

    fun all(): List<NativeQueueEntry> = entries.toList()

    /**
     * 换一个队列并从 [startIndex] 开始。
     *
     * **这是「换歌单」该走的路**：整份替换、下标重置、播放状态由调用方重新建立。
     * 不在旧队列上做增量修补 —— 用户说的「先清空播放队列再从头拉」就是这件事。
     */
    fun replace(newEntries: List<NativeQueueEntry>, startIndex: Int) {
        entries.clear()
        entries.addAll(newEntries)
        index = if (entries.isEmpty()) -1 else startIndex.coerceIn(0, entries.size - 1)
    }

    /** 原地改下标（前台点某一首）。越界不收。 */
    fun seekTo(target: Int): NativeQueueEntry? {
        if (target !in entries.indices) return null
        index = target
        return entries[target]
    }

    /** 前台在队列里插歌 / 删歌之后整份同步，保留下标指向的仍是同一首歌（能对上才保）。 */
    fun syncEntries(newEntries: List<NativeQueueEntry>) {
        val currentKey = current()?.songKey
        entries.clear()
        entries.addAll(newEntries)
        if (entries.isEmpty()) {
            index = -1
            return
        }
        val kept = if (currentKey == null) -1 else entries.indexOfFirst { it.songKey == currentKey }
        index = if (kept >= 0) kept else index.coerceIn(0, entries.size - 1)
    }

    /**
     * 「这一首放完了，接下来怎么办」。返回 null 表示**该停了**（顺序播放走到头）。
     *
     * 单曲循环时返回**当前这一首**（不换曲目，只是重播），调用方据此走 seek(0) 而不是
     * 换源 —— 这正是原来无缝回绕被误当成「没有下一首」的地方。
     */
    fun onFinished(): NativeQueueEntry? {
        val cur = current() ?: return null
        if (loopMode == NativeLoopMode.ONE) return cur
        val next = pickNext(direction = +1) ?: return null
        index = next
        return entries[next]
    }

    /**
     * 「下一首会是谁」——只看不动。
     *
     * 交叉淡化要在**放完之前**就决定换不换（换到哪一首、地址有没有），而 [onFinished]
     * 会推进下标。提前问一句得有个不动状态机的问法，否则问一次就等于切了一首。
     */
    fun peekNext(): NativeQueueEntry? {
        if (loopMode == NativeLoopMode.ONE) return current()
        val next = pickNext(direction = +1) ?: return null
        return entries.getOrNull(next)
    }

    /**
     * 用户按「下一首 / 上一首」。**与 onFinished 分开**：手按时单曲循环也该真的换一首，
     * 否则按了没反应。到边界时回绕（与 Web 层一致），队列只有一首就停在原地。
     */
    fun onSkip(direction: Int): NativeQueueEntry? {
        if (entries.isEmpty()) return null
        val next = pickNext(direction) ?: return current()
        index = next
        return entries[next]
    }

    /** 下一首 / 上一首该落在哪一格；顺序播放越过边界回 null。 */
    private fun pickNext(direction: Int): Int? {
        if (entries.isEmpty()) return null
        if (entries.size == 1) return if (loopMode == NativeLoopMode.OFF && direction > 0) null else 0
        if (shuffle && direction > 0) {
            // 随机不重复当前那一格；只有一首时上面已经返回，这里 size >= 2。
            var candidate = index
            while (candidate == index) {
                candidate = (0 until entries.size).random()
            }
            return candidate
        }
        val target = index + direction
        return when {
            target < 0 -> if (loopMode == NativeLoopMode.OFF) null else entries.size - 1
            target >= entries.size -> if (loopMode == NativeLoopMode.OFF) null else 0
            else -> target
        }
    }

    /** 给前台渲染用的快照。前台按它整体重画，不做增量推断。 */
    fun snapshot(): JSONObject = JSONObject().apply {
        put("entries", JSONArray().also { array -> entries.forEach { array.put(it.toJson()) } })
        put("index", index)
        put("loopMode", loopMode.wire)
        put("shuffle", shuffle)
        put("size", entries.size)
        put("revision", revision)
    }

    /**
     * 每次队列内容或下标变化都 +1。前台拿它判断「快照是不是新的」，
     * 不用逐字段比 —— 那又回到了增量推断。
     */
    var revision: Long = 0
        private set

    fun bumpRevision() {
        revision += 1
    }
}
