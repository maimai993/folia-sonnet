package top.izuna.foliamajor.player.transition.analysis

import android.content.Context
import org.json.JSONObject
import top.izuna.foliamajor.player.transition.TrackProfile
import java.io.File
import java.math.BigInteger
import java.security.MessageDigest

// android/app/src/main/java/top/izuna/foliamajor/player/transition/analysis/ProfileCache.kt
// 分析结果缓存：内存 LRU + 磁盘 JSON。
//
// 预取阶段（播放前几分钟）就把下几首分析完，换歌那一刻只做规划 + 执行，
// 不在交接点上做任何解码 —— 这是「强力」里延迟那一半的保证。
// 磁盘缓存放在 cacheDir，系统可在存储紧张时回收，不占用户数据目录。

class ProfileCache(private val context: Context) {

    companion object {
        private const val MEMORY_CAPACITY = 128
        private const val DISK_CAPACITY = 512
        private const val TTL_MS = 30L * 24L * 60L * 60L * 1_000L
        private const val DIR = "transition-profiles"
    }

    private val memory = object : LinkedHashMap<String, TrackProfile>(MEMORY_CAPACITY, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, TrackProfile>?): Boolean =
            size > MEMORY_CAPACITY
    }

    private val dir: File get() = File(context.cacheDir, DIR).apply { if (!exists()) mkdirs() }

    @Synchronized
    fun get(key: String): TrackProfile? {
        memory[key]?.let { return it }
        val file = fileFor(key)
        if (!file.exists()) return null
        return runCatching {
            val profile = TrackProfile.fromJson(JSONObject(file.readText()))
            if (System.currentTimeMillis() - profile.analysedAtMs > TTL_MS) {
                file.delete()
                null
            } else {
                memory[key] = profile
                profile
            }
        }.getOrNull()
    }

    @Synchronized
    fun put(profile: TrackProfile) {
        memory[profile.key] = profile
        runCatching {
            fileFor(profile.key).writeText(profile.toJson().toString())
            trimDisk()
        }
    }

    @Synchronized
    fun clear() {
        memory.clear()
        runCatching { dir.listFiles()?.forEach { it.delete() } }
    }

    fun size(): Int = memory.size

    private fun trimDisk() {
        val files = dir.listFiles()?.sortedByDescending { it.lastModified() } ?: return
        if (files.size <= DISK_CAPACITY) return
        files.drop(DISK_CAPACITY).forEach { runCatching { it.delete() } }
    }

    private fun fileFor(key: String): File = File(dir, md5(key) + ".json")

    private fun md5(value: String): String = runCatching {
        val digest = MessageDigest.getInstance("MD5").digest(value.toByteArray())
        BigInteger(1, digest).toString(16).padStart(32, '0')
    }.getOrDefault(Integer.toHexString(value.hashCode()))
}
