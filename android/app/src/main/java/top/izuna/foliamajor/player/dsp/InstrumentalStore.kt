package top.izuna.foliamajor.player.dsp

import android.content.Context
import android.util.Log
import java.io.File
import java.security.MessageDigest

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/InstrumentalStore.kt
// 「关闭人声」用的伴奏缓存：一首歌一个文件，按 LRU 清理。
//
// 为什么要有这一层：
//   中置相消只是把「完全居中」的成分减掉，人声的混响、和声、立体声处理都会留下 ——
//   用户听到的是「声音变小了，人声还在」。要真的掐掉，只能让 SCNet 把整首歌分离一遍，
//   再播「原曲 − 人声」。分离是离线的一次性成本，所以结果必须落盘复用。
//
// 体积：伴奏用 AAC 128kbps 写（一首 4 分钟约 3.8MB），不写 WAV
//   （同样的歌 44.1k/16bit/立体声是 42MB）。一份缓存能放上百首。
//
// 为什么用文件的 mtime 当 LRU：
//   不用额外维护索引 JSON —— 那东西会和目录内容不一致（删了文件忘了改索引、
//   进程被杀在写索引的中途）。每次取用 touch 一下，mtime 天然就是最近使用时间；
//   启动时扫一遍目录就能算出总量。少一个会坏的东西。
internal object InstrumentalStore {

    private const val DIR_NAME = "instrumental"

    private const val TAG = "Instrumental"

    /**
     * 缓存上限的**天花板**。实际用多少见 [limitBytes]。
     *
     * 为什么不再写死一个数：400MB 大约一百首，对 512G 的手机来说太小，
     * 对只剩 1G 空间的手机又太大。上限跟着磁盘剩余走，两头都不会出错。
     * 2G 约五百首 —— 到这个量级，命中率已经不是瓶颈了（没人会把同一首歌
     * 听五百遍还保证不重样），再大只是白占。
     */
    const val MAX_BYTES = 2L * 1024 * 1024 * 1024

    /**
     * 无论如何给系统和其他缓存留出的余量。
     *
     * 伴奏缓存是「没了可以重算」的东西，不该把手机塞到装不下别的。
     * 300MB 是经验值：够系统做一次 OTA 的临时文件，也够其他 App 周转。
     */
    private const val RESERVED_FREE_BYTES = 300L * 1024 * 1024

    /** 缓存最多吃掉「剩余空间减余量」的几分之一。 */
    private const val SHARE = 4

    /** 生成中的临时文件后缀：崩溃/取消留下的半成品，下次启动直接扫掉。 */
    private const val TEMP_SUFFIX = ".part"

    /** 最近一次统计的缓存占用，只给界面看，不参与清理判断。 */
    @Volatile
    private var usedBytes: Long = 0L

    /** 最近一次统计的缓存首数。 */
    @Volatile
    private var usedCount: Int = 0

    /** 最近一次清理时用的上限，给界面显示。 */
    @Volatile
    private var limitBytes: Long = MAX_BYTES

    fun directory(context: Context): File =
        File(context.cacheDir, DIR_NAME).also { if (!it.exists()) it.mkdirs() }

    /**
     * 这台设备上实际生效的缓存上限。
     *
     * 取 [limitFor]：剩余空间多就放到天花板，剩余空间少就自动缩。
     * 每次调用做一次 statvfs（几十微秒），不必缓存 —— 缓存反而会在
     * 用户装了别的大东西之后给出过时的上限。
     */
    fun cacheLimitBytes(context: Context): Long {
        val free = try {
            context.cacheDir.usableSpace
        } catch (error: SecurityException) {
            // 取不到就按最保守的来：宁可少缓存，也不要因为写满磁盘把播放搞挂。
            Log.w(TAG, "读不到剩余空间，按最小上限处理", error)
            0L
        }
        return limitFor(free)
    }

    /** [cacheLimitBytes] 的纯函数版：单测直接喂剩余空间。 */
    internal fun limitFor(freeBytes: Long): Long {
        val budget = (freeBytes - RESERVED_FREE_BYTES).coerceAtLeast(0L)
        return (budget / SHARE).coerceAtMost(MAX_BYTES)
    }

    /**
     * 界面要显示的「已缓存多少」：字节数、首数、当前上限。
     *
     * 三个值都是 volatile 快照，主线程直接读；真正的重算在 [measure] 里，
     * 只发生在 trim / sweep 之后（都在后台线程）。
     */
    fun usage(): Triple<Long, Int, Long> = Triple(usedBytes, usedCount, limitBytes)

    /** 数一遍目录。只在 trim / sweep 之后调，不进播放热路径。 */
    internal fun measure(dir: File, limit: Long = limitBytes): Pair<Long, Int> {
        val files = dir.listFiles()?.filter { it.isFile && !it.name.endsWith(TEMP_SUFFIX) }.orEmpty()
        val total = files.sumOf { it.length() }
        usedBytes = total
        usedCount = files.size
        limitBytes = limit
        return total to files.size
    }

    /**
     * 这首歌的缓存键。
     *
     * 用 songKey（平台 + 歌曲 id）而不是 URL：同一首歌的直链会过期、会换 CDN，
     * 拿 URL 当键等于每次播放都重新分离一遍。没有 songKey 时才退回 URL。
     */
    fun keyFor(url: String, songKey: String?): String {
        val seed = if (!songKey.isNullOrBlank()) songKey else url
        val digest = MessageDigest.getInstance("SHA-1").digest(seed.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }.take(32)
    }

    /** 已经生成好的那一轨；没有则 null。取用会刷新 mtime，让它晚一点被清掉。 */
    fun find(context: Context, key: String, mode: VocalTrackMode = VocalTrackMode.INSTRUMENTAL): File? {
        val file = targetFor(context, key, mode)
        if (!file.isFile || file.length() <= 0L) return null
        file.setLastModified(System.currentTimeMillis())
        return file
    }

    /**
     * 两轨都齐了没有：预分析用它判断这首歌还要不要重跑。
     *
     * 刻意不走 [find] —— 那会刷新 mtime，等于「只是查一下」就把两首歌顶到 LRU 最新，
     * 真正的老文件反而被留下来了。
     */
    fun bothReady(context: Context, key: String): Boolean =
        VocalTrackMode.entries.all {
            val file = targetFor(context, key, it)
            file.isFile && file.length() > 0L
        }

    fun tempFor(context: Context, key: String, mode: VocalTrackMode = VocalTrackMode.INSTRUMENTAL): File =
        File(directory(context), "$key${mode.suffix}$TEMP_SUFFIX")

    fun targetFor(context: Context, key: String, mode: VocalTrackMode = VocalTrackMode.INSTRUMENTAL): File =
        File(directory(context), "$key${mode.suffix}")

    /**
     * 把临时文件转正。
     *
     * rename 是原子的：要么看到完整文件，要么看不到 —— 不会出现「播到一半发现文件是半截」。
     */
    fun commit(temp: File, target: File): Boolean {
        if (!temp.isFile || temp.length() <= 0L) return false
        target.delete()
        return temp.renameTo(target)
    }

    /**
     * 「设置 → 存储 → 删除人声分离缓存」：把两轨正式文件与半成品一起删掉，重算用量。
     *
     * 只清这个目录，不碰 IndexedDB 里的分析曲线 —— 那是另一类缓存，由存储页的
     * analysis 分类自己管。删完必须 measure 一次，否则界面还显示旧的「N 首 · XX MB」。
     */
    fun clearAll(context: Context) {
        val dir = directory(context)
        clearDirectory(dir)
        measure(dir, cacheLimitBytes(context))
    }

    /** [clearAll] 的目录版：单测直接在临时目录上跑。只删文件，目录本身留着复用。 */
    internal fun clearDirectory(dir: File) {
        dir.listFiles()?.forEach { file ->
            if (file.isFile) file.delete()
        }
    }

    /** 清掉崩溃留下的半成品与孤儿文件。启动时调一次就够。 */
    fun sweep(context: Context) {
        val dir = directory(context)
        sweepDirectory(dir)
        measure(dir, cacheLimitBytes(context))
    }

    /** [sweep] 的目录版：单测直接在临时目录上跑。 */
    internal fun sweepDirectory(dir: File) {
        dir.listFiles()?.forEach { file ->
            if (file.name.endsWith(TEMP_SUFFIX)) {
                file.delete()
            }
        }
    }

    /**
     * 按 LRU 把总量压到 [limitBytes] 以下（不传就按这台设备的实际上限）。
     *
     * 排序只看 mtime：find() 会刷新它，所以「正在用的这首」永远排最后。
     * 删的时候跳过 [keep]（当前这首的正式文件），哪怕它是最旧的。
     */
    fun trim(context: Context, limitBytes: Long? = null, keep: File? = null) {
        val dir = directory(context)
        val limit = limitBytes ?: cacheLimitBytes(context)
        trimDirectory(dir, limit, keep)
        measure(dir, limit)
    }

    /** [trim] 的目录版：单测直接在临时目录上跑。 */
    internal fun trimDirectory(dir: File, limitBytes: Long = MAX_BYTES, keep: File? = null) {
        val files = dir.listFiles()?.filter { it.isFile && !it.name.endsWith(TEMP_SUFFIX) } ?: return
        var total = files.sumOf { it.length() }
        if (total <= limitBytes) return
        val oldestFirst = files.sortedBy { it.lastModified() }
        for (file in oldestFirst) {
            if (total <= limitBytes) break
            if (keep != null && file.absolutePath == keep.absolutePath) continue
            val size = file.length()
            if (file.delete()) total -= size
        }
    }
}
