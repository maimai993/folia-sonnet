package top.izuna.foliamajor.player

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

// android/app/src/main/java/top/izuna/foliamajor/player/SessionSnapshotStore.kt
//
// 会话快照的磁盘副本：**「上次听到哪儿」不该只存在 WebView 里**。
//
// WebView 的 IndexedDB 是这个应用里唯一记着「上次放的哪首、队列什么顺序、听到第几秒」
// 的地方，可它在两类场合靠不住：
//   · 用户在最近任务里把应用划掉 —— 系统连进程一起收，IndexedDB 里没来得及提交的那几笔
//     就没了，而 WebView 里的事务并不是每条都立刻落盘；
//   · 进程被回收后又从通知栏拉起来，WebView 是新的，读盘时机比脚本初始化更早。
//
// 播放链路的真相本来就该在原生（见 NativePlayQueue 的说明），队列也在原生手里，所以
// 这里只是把它顺手抄一份到 SharedPreferences：进程怎么死都不影响，重启后前台问一次
// `getQueueState` 就能拿到完整队列与秒数，不必赌 IndexedDB 还在不在。
//
// 两个 key 分开写：队列那份几百 KB、只在切歌/换队列时变；位置那份几十字节、每十秒一次。
// 合在一起的话，记一个秒数就得把整份队列重新序列化并写盘。

object SessionSnapshotStore {

    private const val TAG = "SessionSnapshotStore"
    private const val PREFS = "folia_session_snapshot"
    private const val KEY_QUEUE = "queue"
    private const val KEY_POSITION = "position"
    private const val VERSION = 1

    /** 磁盘上那份会话。`entriesJson` 是 [NativeQueueEntry] 的 JSON 数组。 */
    data class Snapshot(
        val entriesJson: String,
        val index: Int,
        val songKey: String,
        val positionMs: Long,
    )

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /**
     * 记下队列与游标。
     *
     * 用 `apply()`：这条路径在切歌时跑，`commit()` 是同步 fsync，几百 KB 写在主线程上
     * 就是一次可见的卡顿。真正需要「写完才返回」的只有收尾那一次（[savePosition] 的
     * `commit` 参数），队列本身丢一次也不过是回到上一次切歌时的顺序。
     */
    fun saveQueue(context: Context, entriesJson: String?, index: Int, songKey: String) {
        if (entriesJson.isNullOrEmpty()) return
        runCatching {
            prefs(context).edit().putString(KEY_QUEUE, JSONObject().apply {
                put("v", VERSION)
                put("entries", JSONArray(entriesJson))
                put("index", index)
                put("songKey", songKey)
                put("at", System.currentTimeMillis())
            }.toString()).apply()
        }.onFailure { Log.w(TAG, "队列快照写入失败", it) }
    }

    /**
     * 记下听到第几秒。
     *
     * `commit = true` 只给 onDestroy / onTaskRemoved 用：那之后再没有下一次机会，
     * 而写入的是几十字节，同步一次不会卡住谁。
     */
    fun savePosition(
        context: Context,
        songKey: String,
        positionMs: Long,
        commit: Boolean = false,
    ) {
        runCatching {
            val editor = prefs(context).edit().putString(KEY_POSITION, JSONObject().apply {
                put("v", VERSION)
                put("songKey", songKey)
                put("positionMs", positionMs)
                put("at", System.currentTimeMillis())
            }.toString())
            if (commit) editor.commit() else editor.apply()
        }.onFailure { Log.w(TAG, "位置快照写入失败", it) }
    }

    /** 读回来。两份都没写过、或解析不出来时返回 null（调用方按「没有会话」处理）。 */
    fun load(context: Context): Snapshot? {
        val preferences = runCatching { prefs(context) }.getOrNull() ?: return null
        val queue = runCatching { preferences.getString(KEY_QUEUE, null) }.getOrNull()
            ?.let { runCatching { JSONObject(it) }.getOrNull() }
            ?: return null
        val entries = queue.optJSONArray("entries") ?: return null
        if (entries.length() == 0) return null

        val position = runCatching { preferences.getString(KEY_POSITION, null) }.getOrNull()
            ?.let { runCatching { JSONObject(it) }.getOrNull() }
        val songKey = queue.optString("songKey", "")
        // 位置只认同一首：换过歌之后队列先落盘、位置还没跟上时，别把上一首的秒数
        // 安到这一首头上。
        val sameSong = position != null && position.optString("songKey", "") == songKey
        return Snapshot(
            entriesJson = entries.toString(),
            index = queue.optInt("index", -1),
            songKey = songKey,
            positionMs = if (sameSong) position!!.optLong("positionMs", 0L) else 0L,
        )
    }

    /** 队列被清空（用户清掉了播放队列）：下一次启动不该再把这批歌装回来。 */
    fun clear(context: Context) {
        runCatching { prefs(context).edit().clear().apply() }
            .onFailure { Log.w(TAG, "清空会话快照失败", it) }
    }
}
