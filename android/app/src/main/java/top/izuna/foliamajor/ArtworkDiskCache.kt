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
            val file = fileFor(key)
            if (!file.isFile) return null
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
            // 更新最近访问时间，淘汰时按 LRU 保留近期常听的封面。
            runCatching { file.setLastModified(clockMs()) }
            return bytes
        }
    }

    /**
     * 写一条，并把它记为「刚用过」。
     *
     * 落盘时间戳取 [touchTimestamp]：文件**已经存在于盘上**时，它必须留在自己原来的时间域里
     * （原来就比 [clockMs] 现在给的旧、或者反而更新，都不会跳序），所以推到
     * `max(clockMs(), 原 mtime)`；新文件用 [clockMs] 的值。
     *
     * 以前这里直接写 [clockMs]：服务注入的是 `SystemClock.elapsedRealtime()`（开机以来的毫秒），
     * 而 [trimLocked] 按 `File.lastModified()`（墙钟）排序 —— 两套时间域。结果重启之后整批条目
     * 看起来都老得多，刚写过的条目排序全乱，最近常听的反而先被淘汰。
     * 现在写盘用的时间戳与文件 mtime 同域，跨重启、跨实例都按真实访问先后淘汰。
     */
    fun put(key: String?, bytes: ByteArray) {
        if (key.isNullOrBlank() || bytes.isEmpty()) return
        if (maxEntries <= 0 || bytes.size > MAX_ENTRY_BYTES || bytes.size.toLong() > maxTotalBytes) return
        synchronized(lock) {
            var temp: File? = null
            try {
                if (!cacheDir.exists() && !cacheDir.mkdirs()) return
                temp = File.createTempFile(TEMP_PREFIX, TEMP_SUFFIX, cacheDir)
                temp.writeBytes(bytes)
                val target = fileFor(key)
                val previous = if (target.isFile) target.lastModified() else 0L
                val stamp = touchTimestamp(target)
                temp.setLastModified(stamp)
                if (target.exists()) target.delete()
                if (!temp.renameTo(target)) {
                    temp.copyTo(target, overwrite = true)
                    target.setLastModified(stamp)
                    temp.delete()
                }
                // 覆盖同一首歌时，文件系统可能给新文件一个**比旧文件还新**的 mtime（ext4 这类
                // 秒级时间戳、写入与读回同一秒）。读的时候会把 mtime 推到现在，所以这种文件
                // 会在下一次淘汰时骗过 LRU：把刚覆盖的那个当成很久没用过的删掉。
                // 这里直接钉住：覆盖 = 刚刚用过，mtime 不许倒退。
                if (target.isFile && target.lastModified() < previous) {
                    target.setLastModified(previous)
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
            runCatching { fileFor(key).delete() }
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

    /** 写入/访问时要打在文件上的时间戳：已有文件的 mtime 比自己新时，保住它原来的位置。 */
    private fun touchTimestamp(target: File): Long {
        val provided = clockMs()
        if (!target.isFile) return provided
        val previous = target.lastModified()
        if (previous <= 0L) return provided
        return if (provided > previous) provided else previous
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
            if (file.name.endsWith(ENTRY_SUFFIX)) {
                images.add(file)
            }
        }
        images.sortWith(compareByDescending<File> { it.lastModified() }.thenBy { it.name })
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

    private fun fileFor(key: String): File = File(cacheDir, sha256Hex(key) + ENTRY_SUFFIX)

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
