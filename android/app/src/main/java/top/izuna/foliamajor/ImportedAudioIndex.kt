package top.izuna.foliamajor

import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * 私有目录里那批「导入的音频」的索引。
 *
 * ## 为什么要这一层
 *
 * 以前副本名是 `imported-<净化后的原文件名>-<哈希>.<ext>`，哈希由
 * `(displayName + ':' + fileSize)` 算出来。这套做法有一个去不掉的问题：
 * **名字取决于导入那一刻的两个值，而这两个值每次来源都不一定一样**。
 *
 * provider 报的大小和实际写出的大小差一个字节、某些 ROM 返回的 displayName
 * 带不带路径前缀、中文净化后撞名 —— 任何一处不同，哈希就变，于是磁盘上明明躺着
 * 那个文件，播放侧算出来的名字却对不上，回 404。用户看到的就是
 * 「文件在，但播不了」，而且重新导入也不一定好。
 *
 * 现在改成：文件名只由**自增 id** 决定（`1.mp3`、`2.flac`），原名、大小、
 * 导入时间全部记进本文件旁边的 `index.json`。id 一旦分配就不再变，
 * 文件名因此是稳定的 —— 与原名怎么净化、大小怎么报、编码怎么解，全都无关。
 *
 * ## 兼容
 *
 * 老库里那些 `imported-` 开头的文件继续按原样服务（playback 侧传的仍是老 ref），
 * 这个索引只负责新导入的东西。`resolve()` 两边都认。
 */
object ImportedAudioIndex {
    private const val TAG = "ImportedAudioIndex"
    private const val INDEX_FILE = "imported-audio-index.json"
    private const val NEXT_ID_KEY = "nextId"
    private const val ENTRIES_KEY = "entries"

    /**
     * 新格式 ref 的前缀。
     *
     * 必须带前缀：MediaStore 那一路的 ref 是纯数字媒体 id，裸数字会两边撞车。
     */
    const val REF_PREFIX = "local-"

    /** 把 id 变成播放用的 ref（`local-3`）。 */
    fun refFor(id: Long): String = REF_PREFIX + id

    /** 一条记录：id 决定磁盘文件名，originalName 只用来显示/找回。 */
    data class Entry(
        val id: Long,
        /** 原始文件名（未净化），给「从 MediaStore 找回」用。 */
        val originalName: String,
        /** 磁盘上的实际文件名，如 `3.flac`。 */
        val fileName: String,
        val fileSize: Long,
        val importedAt: Long,
    )

    private val lock = Any()

    private fun indexFile(directory: File): File = File(directory, INDEX_FILE)

    @Suppress("UNCHECKED_CAST")
    private fun readRaw(directory: File): JSONObject {
        val file = indexFile(directory)
        if (!file.isFile) return JSONObject()
        return try {
            JSONObject(file.readText())
        } catch (error: Exception) {
            // 索引坏了不能让整个本地曲库陪葬：当作空索引重建，文件本身还在。
            Log.w(TAG, "index unreadable, rebuilding: " + file.absolutePath, error)
            JSONObject()
        }
    }

    private fun writeRaw(directory: File, root: JSONObject) {
        try {
            val tmp = File(directory, INDEX_FILE + ".tmp")
            tmp.writeText(root.toString())
            val target = indexFile(directory)
            if (target.exists()) target.delete()
            tmp.renameTo(target)
        } catch (error: Exception) {
            Log.w(TAG, "failed to persist index", error)
        }
    }

    /** 读出所有条目（id -> Entry）。 */
    fun entries(directory: File): Map<Long, Entry> = synchronized(lock) {
        val root = readRaw(directory)
        val array = root.optJSONArray(ENTRIES_KEY) ?: return emptyMap()
        val result = LinkedHashMap<Long, Entry>()
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val id = item.optLong("id", -1)
            if (id < 0) continue
            result[id] = Entry(
                id = id,
                originalName = item.optString("originalName", ""),
                fileName = item.optString("fileName", ""),
                fileSize = item.optLong("fileSize", 0),
                importedAt = item.optLong("importedAt", 0),
            )
        }
        return result
    }

    /**
     * 给一份新副本分配 id 并登记。
     *
     * 先把文件以临时名写好、再调这里拿最终名，最后改名 —— 这样不会出现
     * 「索引里有、磁盘上没有」或反过来的窗口。
     */
    fun register(
        directory: File,
        tempFile: File,
        originalName: String,
        extension: String,
    ): Entry? = synchronized(lock) {
        val root = readRaw(directory)
        val currentNext = root.optLong(NEXT_ID_KEY, 1).coerceAtLeast(1)
        var id = currentNext
        // 极端情况下（索引被删过）id 可能已占用，往后找空位。
        while (File(directory, id.toString() + extension).exists()) id += 1

        val fileName = id.toString() + extension
        val target = File(directory, fileName)
        if (!tempFile.renameTo(target)) {
            Log.w(TAG, "failed to rename " + tempFile.absolutePath + " -> " + target.absolutePath)
            tempFile.delete()
            return null
        }

        val entry = Entry(
            id = id,
            originalName = originalName,
            fileName = fileName,
            fileSize = target.length(),
            importedAt = System.currentTimeMillis(),
        )
        val array = root.optJSONArray(ENTRIES_KEY) ?: org.json.JSONArray()
        array.put(JSONObject().apply {
            put("id", entry.id)
            put("originalName", entry.originalName)
            put("fileName", entry.fileName)
            put("fileSize", entry.fileSize)
            put("importedAt", entry.importedAt)
        })
        root.put(ENTRIES_KEY, array)
        root.put(NEXT_ID_KEY, id + 1)
        writeRaw(directory, root)
        return entry
    }

    /**
     * 按 ref 找到磁盘上的文件。
     *
     * 认三种形态：
     *   · `local-<id>`（新格式）——查索引拿真实文件名；
     *   · `imported-xxx`（旧格式）——老副本，名字本身就是文件名；
     *   · 其它 —— 直接当文件名兜底。
     */
    fun resolve(directory: File, ref: String): File? {
        if (ref.isEmpty()) return null
        // 新格式：local-<id>
        if (ref.startsWith(REF_PREFIX)) {
            val asId = ref.substring(REF_PREFIX.length).trim().toLongOrNull()
            if (asId != null) {
                val entry = entries(directory)[asId]
                if (entry != null) {
                    val file = File(directory, entry.fileName)
                    if (file.isFile) return file
                }
                /*
                 * 索引里没有记录（索引被删 / 写失败）时，按 id 后缀在目录里找一次。
                 * 磁盘上的名字是 `<id>.<ext>`，所以比对的是「主干是否等于 id」。
                 */
                directory.listFiles()?.forEach { candidate ->
                    if (!candidate.isFile) return@forEach
                    val base = candidate.name.substringBeforeLast('.')
                    if (base == asId.toString()) return candidate
                }
            }
            return null
        }
        // 旧格式（imported-xxx）或显式文件名
        val direct = File(directory, ref)
        if (direct.isFile) return direct
        return null
    }

    /** 删掉一篇副本时，连带把索引记录去掉。 */
    fun forget(directory: File, ref: String) = synchronized(lock) {
        val id = ref.trim().toLongOrNull() ?: return
        val root = readRaw(directory)
        val array = root.optJSONArray(ENTRIES_KEY) ?: return
        val kept = org.json.JSONArray()
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            if (item.optLong("id", -1) != id) kept.put(item)
        }
        root.put(ENTRIES_KEY, kept)
        writeRaw(directory, root)
    }
}
