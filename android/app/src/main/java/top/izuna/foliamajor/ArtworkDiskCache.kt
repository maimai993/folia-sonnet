package top.izuna.foliamajor

import android.content.Context
import java.io.File
import java.security.MessageDigest

// android/app/src/main/java/top/izuna/foliamajor/ArtworkDiskCache.kt
// 通知栏封面的磁盘缓存（#348）。
//
// 放在应用 cacheDir 下（系统存储紧张时可自行回收，不占用用户数据目录）。
// 切歌时先查这里，命中直接解码贴图，断网或后台被节流也能出封面；网络拿到新图后异步写盘。
//
// 两套键，各服务一件事：
//   · `url:` 由封面地址推出，**同一次网络尝试**在下载前用它短路（签名 URL 换一次就换一个键）；
//   · `song:` 由 Web 层给的 songKey 推出，断网 / 后台节流时靠它出封面，也是「同一首已经拿到过
//     封面」的唯一凭据（见 ArtworkFetchTracker）。
// 两套键存的字节可能不同（原始字节 / 512px 重编码），所以键里带内容版本号，改写法时整体作废旧条目。

class ArtworkDiskCache internal constructor(
    private val cacheDir: File,
    private val maxEntries: Int = DEFAULT_MAX_ENTRIES,
    private val maxTotalBytes: Long = DEFAULT_MAX_TOTAL_BYTES,
    private val clockMs: () -> Long = { System.currentTimeMillis() },
    private val onError: (String, Throwable) -> Unit = { _, _ -> },
) {
    constructor(
        cacheDir: File,
        maxEntries: Int = DEFAULT_MAX_ENTRIES,
        maxTotalBytes: Long = DEFAULT_MAX_TOTAL_BYTES,
        onError: (String, Throwable) -> Unit = { _, _ -> },
    ) : this(cacheDir, maxEntries, maxTotalBytes, { System.currentTimeMillis() }, onError)

    // Service 重建时旧后台写入可能仍在执行；同目录的实例必须共用清理/写入锁。
    private val lock = synchronized(directoryLocks) {
        directoryLocks.getOrPut(cacheDir.canonicalPath) { Any() }
    }

    init {
        // 进程可能在临时文件改名之前退出；首次使用前回收孤儿文件和超额旧条目。
        synchronized(lock) {
            try {
                trimLocked()
            } catch (error: Exception) {
                onError("initialize", error)
            }
        }
    }

    /**
     * 读一条。命中时把**真实 mtime** 推到现在 —— 淘汰顺序只看 mtime（见 [put]）。
     *
     * [clockMs] 只决定「把 mtime 推到这个值」；它和被读文件原来的 mtime 处在同一个时间域里
     * （见 [put]），所以这里写入的值紧挨着文件里已有的顺序，不会破坏 LRU。
     */
    fun get(key: String?): ByteArray? {
        if (key.isNullOrBlank()) return null
        synchronized(lock) {
            val file = findEntry(key) ?: return null
            val bytes = try {
                val length = file.length()
                if (length <= 0L || length > MAX_ENTRY_BYTES) {
                    file.delete()
                    return null
                }
                // 即使长度检查后文件被改大，最多也只读取上限 + 1 字节用于拒绝。
                file.inputStream().use { stream ->
                    val out = java.io.ByteArrayOutputStream(length.toInt())
                    val buffer = ByteArray(8 * 1024)
                    var total = 0
                    while (true) {
                        val count = stream.read(buffer, 0, minOf(buffer.size, MAX_ENTRY_BYTES + 1 - total))
                        if (count < 0) break
                        total += count
                        if (total > MAX_ENTRY_BYTES) return@use null
                        out.write(buffer, 0, count)
                    }
                    out.toByteArray()
                }
            } catch (error: OutOfMemoryError) {
                // 磁盘缓存是可选兜底；低内存时当未命中，不能让在途请求永远悬挂。
                onError("read", error)
                null
            } catch (error: Exception) {
                onError("read", error)
                null
            }
            if (bytes == null || bytes.isEmpty()) {
                runCatching { file.delete() }
                return null
            }
            /*
             * 记成「刚用过」：换一个更大的序号（改名），而不是推 mtime。
             *
             * 改名的代价很便宜（同一目录内的 inode 操作），而且不受时间域影响 —— 见 [fileFor]。
             * 改名失败就保持原样：这一条下次淘汰时按旧序号算，只是不够新，不会丢数据。
             */
            runCatching {
                val bumped = fileFor(key, nextSeqLocked())
                if (!file.renameTo(bumped)) {
                    // 目标已存在（并发写入了更新的那条）就保留对方那份，删掉自己这份旧的。
                    if (bumped.isFile) file.delete()
                }
            }
            return bytes
        }
    }

    /**
     * 写一条，并把它记为「刚用过」。
     *
     * 「刚用过」在文件名里体现：每次都写一个**更大的序号**，见 [fileFor] 里为什么不用 mtime。
     * 同一条旧文件（旧序号）写成新的之后立刻删掉，缓存里同一个 key 只留一份。
     */
    fun put(key: String?, bytes: ByteArray) {
        if (key.isNullOrBlank() || bytes.isEmpty()) return
        if (maxEntries <= 0 || bytes.size > MAX_ENTRY_BYTES || bytes.size.toLong() > maxTotalBytes) return
        synchronized(lock) {
            var temp: File? = null
            try {
                if (!cacheDir.exists() && !cacheDir.mkdirs()) return
                // mtime 不再参与淘汰排序（见 [fileFor]），但仍在落盘之前取一次：
                // 一是让「这个文件是什么时候落的盘」在文件管理器/调试时仍然可读，
                // 二是 clockMs 本身是调用方观察写入时机的钩子，失败要发生在写入之前
                //    （这样 OOM 时不会有半个条目留在盘上，临时文件由 finally 清掉）。
                val stamp = clockMs()
                temp = File.createTempFile(TEMP_PREFIX, TEMP_SUFFIX, cacheDir)
                temp.writeBytes(bytes)
                temp.setLastModified(stamp)
                val previous = findEntry(key)
                val target = fileFor(key, nextSeqLocked())
                if (!temp.renameTo(target)) {
                    temp.copyTo(target, overwrite = true)
                    temp.setLastModified(stamp)
                    temp.delete()
                }
                // 序号必须唯一：万一撞上（理论上不会），保留既有那份，别把刚写的删了。
                if (previous != null && previous != target && previous.isFile) {
                    runCatching { previous.delete() }
                }
                trimLocked()
            } catch (error: OutOfMemoryError) {
                onError("write", error)
            } catch (error: Exception) {
                onError("write", error)
            } finally {
                if (temp != null && temp.exists()) {
                    runCatching { temp.delete() }
                }
            }
        }
    }

    fun remove(key: String?) {
        if (key.isNullOrBlank()) return
        synchronized(lock) {
            runCatching { findEntry(key)?.delete() }
        }
    }

    fun clear() {
        synchronized(lock) {
            runCatching {
                cacheDir.listFiles()?.forEach { runCatching { it.delete() } }
            }
        }
    }

    fun entryCount(): Int = synchronized(lock) {
        cacheDir.listFiles { file -> file.isFile && file.name.endsWith(ENTRY_SUFFIX) }?.size ?: 0
    }

    private fun trimLocked() {
        val entries = cacheDir.listFiles() ?: return
        val images = ArrayList<File>()
        for (file in entries) {
            if (!file.isFile) continue
            if (file.name.startsWith(TEMP_PREFIX) && file.name.endsWith(TEMP_SUFFIX)) {
                runCatching { file.delete() }
                continue
            }
            // 序号文件不是条目，别删也别计数。
            if (file.name == SEQ_FILE || file.name == SEQ_FILE + TEMP_SUFFIX) continue
            if (file.name.endsWith(ENTRY_SUFFIX)) {
                images.add(file)
            }
        }
        // 按序号降序：新的在前，留下的都是最近用过的。老格式（无序号）当 0，排最后。
        images.sortWith(compareByDescending<File> { seqOf(it) }.thenBy { it.name })
        var keptCount = 0
        var keptBytes = 0L
        for (file in images) {
            val len = file.length()
            if (keptCount < maxEntries && keptBytes + len <= maxTotalBytes) {
                keptCount++
                keptBytes += len
            } else {
                runCatching { file.delete() }
            }
        }
    }

    /**
     * 一个键对应的条目文件。
     *
     * 文件名是 `<sha256(key)>_<序号>.img`，**排序键是那个序号**，不是 mtime。
     *
     * 为什么不用 mtime（#441）：服务注入的 `clockMs` 是 `SystemClock.elapsedRealtime()`
     * （开机以来毫秒，重启后归零），而 mtime 是墙钟。两者混用之后，`max(clockMs, previous)`
     * 这种「保住旧值」的策略并不成立 —— 旧的大数会永远压住新写入的小数：
     *
     *     put k1 (clock=3000) → mtime 3000
     *     put k2 (clock=4000) → mtime 4000
     *     get k1 (clock=5)    → max(5, 3000) = 3000   ← 刚读过，却排第二
     *     put k3 (clock=501)  → 新文件 → mtime 501    ← 最新，却排最后
     *
     * 结果淘汰的是 k3。序号不受时间域影响：每次读写都取一个更大的数，跨重启照样单调。
     */
    private fun fileFor(key: String, seq: Long): File =
        File(cacheDir, sha256Hex(key) + SEQ_SEPARATOR + seq + ENTRY_SUFFIX)

    /** 这个键现有的条目文件（0 或 1 个；序号最大的是最新的）。 */
    private fun findEntry(key: String): File? {
        val prefix = sha256Hex(key) + SEQ_SEPARATOR
        val candidates = cacheDir.listFiles { file ->
            file.isFile && file.name.startsWith(prefix) && file.name.endsWith(ENTRY_SUFFIX)
        } ?: return null
        return candidates.maxByOrNull { seqOf(it) }
    }

    /** 文件名里的序号；老格式（没有序号）一律当 0，也就是最旧。 */
    private fun seqOf(file: File): Long {
        val name = file.name
        if (!name.endsWith(ENTRY_SUFFIX)) return 0L
        val body = name.substring(0, name.length - ENTRY_SUFFIX.length)
        val at = body.lastIndexOf(SEQ_SEPARATOR)
        if (at < 0) return 0L
        return body.substring(at + 1).toLongOrNull() ?: 0L
    }

    /**
     * 取下一个序号并落盘。
     *
     * 存在 `.seq` 里而不是只放内存：进程重启后必须接着往上走，否则新写入的条目会被当成
     * 比旧条目还老（那正是 #441 的原始症状）。读不到就退回「盘上已有的最大序号 + 1」，
     * 保证不会倒退。
     */
    private fun nextSeqLocked(): Long {
        val seqFile = File(cacheDir, SEQ_FILE)
        val stored = runCatching { seqFile.readText().trim().toLong() }.getOrNull() ?: 0L
        val onDisk = cacheDir.listFiles()?.maxOfOrNull { seqOf(it) } ?: 0L
        val next = maxOf(stored, onDisk) + 1L
        runCatching {
            // 临时文件 + rename：写到一半被杀不会留下半个数字。
            val temp = File(cacheDir, SEQ_FILE + TEMP_SUFFIX)
            temp.writeText(next.toString())
            if (seqFile.exists()) seqFile.delete()
            if (!temp.renameTo(seqFile)) {
                seqFile.writeText(next.toString())
                temp.delete()
            }
        }
        return next
    }

    private fun sha256Hex(value: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
        val out = StringBuilder(digest.size * 2)
        for (b in digest) {
            val v = b.toInt() and 0xFF
            out.append(HEX_CHARS[v ushr 4])
            out.append(HEX_CHARS[v and 0x0F])
        }
        return out.toString()
    }

    companion object {
        private const val DIR_NAME = "artwork-cache"
        private const val ENTRY_SUFFIX = ".img"
        private const val TEMP_PREFIX = "art-"
        private const val TEMP_SUFFIX = ".tmp"
        /** 条目名里 sha 与序号之间的分隔符（#441）。 */
        private const val SEQ_SEPARATOR = "_"
        /** 持久化的单调序号，用来替代 mtime 做 LRU 排序（#441）。 */
        private const val SEQ_FILE = ".seq"
        private const val HEX_CHARS = "0123456789abcdef"

        /**
         * 缓存内容的版本号，进键名。
         *
         * `song:` 存的字节随来源不同而不同（见 [songKey]），改这套写法时把它加一，
         * 旧条目自然全部 miss、被 LRU 淘汰，不用另写清盘逻辑。
         */
        private const val CACHE_LAYOUT = "v2"

        const val DEFAULT_MAX_ENTRIES = 256
        const val DEFAULT_MAX_TOTAL_BYTES = 32L * 1024L * 1024L

        /**
         * 原始字节不超过此阈值时直接原样落盘，免去二次编解码；更大的图已经采样缩到 512px，
         * 写盘前按目标尺寸重编码，防止几百张大图把磁盘缓存顶满。
         */
        const val MAX_RAW_CACHE_BYTES = 512 * 1024

        // 512px RGBA 无损 PNG 最坏约 1MiB；允许编码后的合法封面，但不读任意大旧文件。
        const val MAX_ENTRY_BYTES = 2 * 1024 * 1024
        private val directoryLocks = mutableMapOf<String, Any>()

        fun create(context: Context, onError: (String, Throwable) -> Unit = { _, _ -> }): ArtworkDiskCache =
            ArtworkDiskCache(File(context.applicationContext.cacheDir, DIR_NAME), onError = onError)

        fun urlKey(url: String?): String? {
            if (url.isNullOrBlank()) return null
            if (url.startsWith("blob:", ignoreCase = true) || url.startsWith("data:", ignoreCase = true)) {
                return null
            }
            return "url:$CACHE_LAYOUT:$url"
        }

        /**
         * 一首歌的封面缓存键。
         *
         * **只服务通知栏尺寸**：两套键存的字节不保证相同 —— `url:` 键在下载到的源图不超过
         * [MAX_RAW_CACHE_BYTES] 时存原始字节，更大的图存 512px 采样重编码；`song:` 键
         * （服务里 `cacheBitmapForSongAsync` 与 `executeArtworkFetch` 写它）**总是** 512px
         * 采样重编码。读的时候一律再过一次 `ArtworkDecoder.decodeSampled`：512px 的图进 512px
         * 的目标不会缩小，多的只是一次解码。
         *
         * 别拿这个键当原图喂给壁纸、分享、导出那些要更大尺寸的地方 —— 要在尺寸上区分，
         * 就在键名里加尺寸，不要改这一份的含义。
         */
        fun songKey(songKey: String?): String? {
            if (songKey.isNullOrBlank()) return null
            return "song:$CACHE_LAYOUT:$songKey"
        }

        /** 原图直存的上限；超过它的图按通知栏尺寸重编码后再进 `song:` 键。 */
        fun keepsRawBytes(rawSize: Int): Boolean = rawSize <= MAX_RAW_CACHE_BYTES
    }
}
