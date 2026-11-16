package top.izuna.foliamajor

import android.content.Context
import java.io.File
import java.security.MessageDigest

// android/app/src/main/java/top/izuna/foliamajor/ArtworkDiskCache.kt
// 通知栏封面的磁盘缓存（#348）。
//
// 放在应用 cacheDir 下（系统存储紧张时可自行回收，不占用用户数据目录）。
// 切歌时先查这里，命中直接解码贴图，断网或后台被节流也能出封面；网络拿到新图后异步写盘。

class ArtworkDiskCache(
    private val cacheDir: File,
    private val maxEntries: Int = DEFAULT_MAX_ENTRIES,
    private val maxTotalBytes: Long = DEFAULT_MAX_TOTAL_BYTES,
    private val clockMs: () -> Long = { System.currentTimeMillis() },
    private val onError: (String, Throwable) -> Unit = { _, _ -> },
) {
    private val lock = Any()

    fun get(key: String?): ByteArray? {
        if (key.isNullOrBlank()) return null
        synchronized(lock) {
            val file = fileFor(key)
            if (!file.isFile) return null
            val bytes = try {
                file.readBytes()
            } catch (error: Throwable) {
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

    fun put(key: String?, bytes: ByteArray) {
        if (key.isNullOrBlank() || bytes.isEmpty()) return
        if (maxEntries <= 0 || bytes.size.toLong() > maxTotalBytes) return
        synchronized(lock) {
            var temp: File? = null
            try {
                if (!cacheDir.exists() && !cacheDir.mkdirs()) return
                temp = File.createTempFile(TEMP_PREFIX, TEMP_SUFFIX, cacheDir)
                temp.writeBytes(bytes)
                val now = clockMs()
                temp.setLastModified(now)
                val target = fileFor(key)
                if (target.exists()) target.delete()
                if (!temp.renameTo(target)) {
                    temp.copyTo(target, overwrite = true)
                    target.setLastModified(now)
                    temp.delete()
                }
                trimLocked()
            } catch (error: Throwable) {
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

        const val DEFAULT_MAX_ENTRIES = 256
        const val DEFAULT_MAX_TOTAL_BYTES = 32L * 1024L * 1024L

        /**
         * 原始字节不超过此阈值时直接原样落盘，免去二次编解码；更大的图已经采样缩到 512px，
         * 写盘前按目标尺寸重编码，防止几百张大图把磁盘缓存顶满。
         */
        const val MAX_RAW_CACHE_BYTES = 512 * 1024

        fun create(context: Context, onError: (String, Throwable) -> Unit = { _, _ -> }): ArtworkDiskCache =
            ArtworkDiskCache(File(context.applicationContext.cacheDir, DIR_NAME), onError = onError)

        fun urlKey(url: String?): String? {
            if (url.isNullOrBlank()) return null
            if (url.startsWith("blob:", ignoreCase = true) || url.startsWith("data:", ignoreCase = true)) {
                return null
            }
            return "url:$url"
        }

        fun songKey(songKey: String?): String? {
            if (songKey.isNullOrBlank()) return null
            return "song:$songKey"
        }
    }
}
