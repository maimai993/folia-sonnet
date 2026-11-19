package top.izuna.foliamajor

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

// android/app/src/test/java/top/izuna/foliamajor/ArtworkDiskCacheTest.kt
// 通知封面磁盘缓存单元测试（#348）。

class ArtworkDiskCacheTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun `存取命中返回一致字节`() {
        val cache = ArtworkDiskCache(tempFolder.newFolder("art"))
        val key = ArtworkDiskCache.urlKey("https://cdn.example.com/cover.jpg")
        val payload = byteArrayOf(1, 2, 3, 4, 5, 6)

        cache.put(key, payload)

        assertArrayEquals(payload, cache.get(key))
        assertEquals(1, cache.entryCount())
    }

    @Test
    fun `读取超限旧条目时返回未命中并删除`() {
        val dir = tempFolder.newFolder("art")
        val cache = ArtworkDiskCache(dir)
        cache.put("oversized", byteArrayOf(1))
        // 目录里还有内部用的 .seq（#441 的单调序号），这里只关心条目文件本身。
        val file = dir.listFiles()!!.single { it.name.endsWith(".img") }
        java.io.RandomAccessFile(file, "rw").use {
            it.setLength(20L * 1024L * 1024L)
        }

        assertNull(cache.get("oversized"))
        assertFalse(file.exists())
    }

    @Test
    fun `单条字节上限本身可写可读 超出则不覆盖旧条目`() {
        val cache = ArtworkDiskCache(tempFolder.newFolder("art"))
        val bytes = ByteArray(ArtworkDiskCache.MAX_ENTRY_BYTES) { 7 }
        cache.put("boundary", bytes)
        assertArrayEquals(bytes, cache.get("boundary"))

        cache.put("boundary", ByteArray(ArtworkDiskCache.MAX_ENTRY_BYTES + 1))
        assertArrayEquals(bytes, cache.get("boundary"))
    }

    @Test
    fun `初始化清理上次进程留下的临时文件但保留封面和无关文件`() {
        val dir = tempFolder.newFolder("art")
        ArtworkDiskCache(dir).put("kept", byteArrayOf(1, 2))
        val orphan = File(dir, "art-abandoned.tmp").apply { writeText("partial") }
        val unrelated = File(dir, "other.tmp").apply { writeText("untouched") }

        val reopened = ArtworkDiskCache(dir)

        assertFalse(orphan.exists())
        assertTrue(unrelated.exists())
        assertArrayEquals(byteArrayOf(1, 2), reopened.get("kept"))
    }

    @Test
    fun `超过原图直存阈值的合法编码字节仍可缓存`() {
        val cache = ArtworkDiskCache(tempFolder.newFolder("art"))
        val encoded = ByteArray(1024 * 1024 + 4096) { (it % 251).toByte() }
        assertTrue(encoded.size > ArtworkDiskCache.MAX_RAW_CACHE_BYTES)
        cache.put("png", encoded)
        assertArrayEquals(encoded, cache.get("png"))
    }

    @Test
    fun `同目录新实例初始化不会删除仍在写入的临时文件`() {
        val dir = tempFolder.newFolder("art")
        val writing = CountDownLatch(1)
        val finishWrite = CountDownLatch(1)
        val initStarted = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        val cache = ArtworkDiskCache(dir, clockMs = {
            writing.countDown()
            check(finishWrite.await(10, TimeUnit.SECONDS))
            1000L
        }, onError = { _, _ -> })
        try {
            val put = pool.submit { cache.put("same", byteArrayOf(7, 8)) }
            assertTrue(writing.await(10, TimeUnit.SECONDS))
            val opened = pool.submit<ArtworkDiskCache> {
                initStarted.countDown()
                ArtworkDiskCache(dir)
            }
            assertTrue(initStarted.await(10, TimeUnit.SECONDS))
            finishWrite.countDown()
            put.get(10, TimeUnit.SECONDS)
            assertArrayEquals(byteArrayOf(7, 8), opened.get(10, TimeUnit.SECONDS).get("same"))
        } finally {
            finishWrite.countDown()
            pool.shutdownNow()
        }
    }

    @Test
    fun `缓存写入内存不足记下原错误并清理临时文件`() {
        val dir = tempFolder.newFolder("art")
        val failure = OutOfMemoryError("synthetic cache pressure")
        val reported = mutableListOf<Throwable>()
        val cache = ArtworkDiskCache(dir, clockMs = { throw failure }, onError = { op, error ->
            assertEquals("write", op)
            reported.add(error)
        })

        cache.put("oom", byteArrayOf(1, 2))

        assertEquals(listOf(failure), reported)
        // 只数条目与临时文件；.seq 是内部序号（#441），不算缓存内容。
        assertEquals(0, dir.listFiles()!!.count { !it.name.startsWith(".") })
    }

    @Test
    fun `空键空字节与本地协议不进缓存`() {
        val dir = tempFolder.newFolder("art")
        val cache = ArtworkDiskCache(dir)

        assertNull(ArtworkDiskCache.urlKey(null))
        assertNull(ArtworkDiskCache.urlKey("   "))
        assertNull(ArtworkDiskCache.urlKey("blob:https://app/123"))
        assertNull(ArtworkDiskCache.urlKey("BLOB:https://app/123"))
        assertNull(ArtworkDiskCache.urlKey("data:image/png;base64,AAA"))
        assertNull(ArtworkDiskCache.urlKey("DATA:image/png;base64,AAA"))
        assertNotNull(ArtworkDiskCache.urlKey("https://cdn.example.com/a.jpg"))
        assertNotNull(ArtworkDiskCache.urlKey("http://127.0.0.1:8080/cover"))

        assertNull(ArtworkDiskCache.songKey(null))
        assertNull(ArtworkDiskCache.songKey(""))
        assertNotEquals(ArtworkDiskCache.songKey("netease:1"), "song:netease:1")
        assertTrue(ArtworkDiskCache.songKey("netease:1")!!.startsWith("song:"))
        assertTrue(ArtworkDiskCache.songKey("netease:1")!!.endsWith(":netease:1"))

        cache.put(null, byteArrayOf(1))
        cache.put("  ", byteArrayOf(1))
        cache.put("url:a", ByteArray(0))
        assertEquals(0, cache.entryCount())
        assertNull(cache.get(null))
        assertNull(cache.get("  "))
    }

    @Test
    fun `超过条目上限按最近访问时间淘汰`() {
        val now = AtomicLong(10_000L)
        val cache = ArtworkDiskCache(
            cacheDir = tempFolder.newFolder("art"),
            maxEntries = 2,
            maxTotalBytes = 1024L * 1024L,
            onError = { _, _ -> },
        )

        cache.put("k1", byteArrayOf(1))
        now.addAndGet(1_000L)
        cache.put("k2", byteArrayOf(2))

        // 访问一次 k1，使其变为最近使用；随后写入 k3 应淘汰 k2 而不是 k1
        now.addAndGet(1_000L)
        assertArrayEquals(byteArrayOf(1), cache.get("k1"))

        now.addAndGet(1_000L)
        cache.put("k3", byteArrayOf(3))

        assertEquals(2, cache.entryCount())
        assertArrayEquals(byteArrayOf(1), cache.get("k1"))
        assertNull(cache.get("k2"))
        assertArrayEquals(byteArrayOf(3), cache.get("k3"))
    }

    @Test
    fun `注入的钟改了写盘时间戳后 仍按真实写入顺序淘汰`() {
        val dir = tempFolder.newFolder("art")
        // 服务注入的是 elapsedRealtime（开机以来毫秒，远小于墙钟），重启后会从很小的值重新开始。
        // 读写共用这样一个「钟」，淘汰的先后必须仍然是真实的写入 / 访问先后。
        val elapsed = AtomicLong(3_000L)
        val cache = ArtworkDiskCache(
            cacheDir = dir,
            maxEntries = 2,
            maxTotalBytes = 1024L * 1024L,
            clockMs = { elapsed.get() },
            onError = { _, _ -> },
        )

        cache.put("k1", byteArrayOf(1))
        elapsed.addAndGet(1_000L)
        cache.put("k2", byteArrayOf(2))
        assertEquals(2, cache.entryCount())

        // 模拟「换了另一个钟」：重启后 elapsedRealtime 从零开始，接下来的时间戳比盘上的都小。
        // 再访问一次 k1 —— 它必须成为最近使用的，而不是被这个更小的钟推到最旧。
        elapsed.set(5L)
        assertArrayEquals(byteArrayOf(1), cache.get("k1"))
        elapsed.set(501L)
        cache.put("k3", byteArrayOf(3))

        // k1 是最近一次真实访问的，不能被淘汰；最旧的是 k2
        assertEquals(2, cache.entryCount())
        assertArrayEquals(byteArrayOf(1), cache.get("k1"))
        assertNull(cache.get("k2"))
        assertArrayEquals(byteArrayOf(3), cache.get("k3"))
    }

    @Test
    fun `超过总字节上限时淘汰旧项 且超大单项不会清空缓存`() {
        val now = AtomicLong(10_000L)
        val cache = ArtworkDiskCache(
            cacheDir = tempFolder.newFolder("art"),
            maxEntries = 10,
            maxTotalBytes = 10L,
            clockMs = { now.get() },
            onError = { _, _ -> },
        )

        cache.put("k1", ByteArray(6) { 1 })
        now.addAndGet(1_000L)
        cache.put("k2", ByteArray(4) { 2 })
        assertEquals(2, cache.entryCount())

        // 写入 6 字节，总计 16 > 10，应淘汰最旧的 k1，保留 k2 + k3（共 10 字节）
        now.addAndGet(1_000L)
        cache.put("k3", ByteArray(6) { 3 })
        assertNull(cache.get("k1"))
        assertArrayEquals(ByteArray(4) { 2 }, cache.get("k2"))
        assertArrayEquals(ByteArray(6) { 3 }, cache.get("k3"))

        // 超过总上限的单项被忽略，不能把现有缓存全部挤掉
        now.addAndGet(1_000L)
        cache.put("huge", ByteArray(11) { 9 })
        assertNull(cache.get("huge"))
        assertEquals(2, cache.entryCount())
    }

    @Test
    fun `移除清空与零字节损坏文件自愈`() {
        val dir = tempFolder.newFolder("art")
        val cache = ArtworkDiskCache(dir)

        cache.put("k1", byteArrayOf(10, 20))
        cache.put("k2", byteArrayOf(30, 40))
        cache.remove("k1")
        assertNull(cache.get("k1"))
        assertArrayEquals(byteArrayOf(30, 40), cache.get("k2"))

        // 零字节坏文件读出应返回 null 并自动删掉
        val imgFiles = dir.listFiles { f -> f.name.endsWith(".img") }!!
        assertEquals(1, imgFiles.size)
        imgFiles[0].writeBytes(ByteArray(0))
        assertNull(cache.get("k2"))
        assertFalse(imgFiles[0].exists())

        cache.put("k3", byteArrayOf(50))
        cache.clear()
        assertEquals(0, cache.entryCount())
    }

    @Test
    fun `写入后不残留临时文件且并发读写安全`() {
        val dir = tempFolder.newFolder("art")
        val cache = ArtworkDiskCache(dir, maxEntries = 32, maxTotalBytes = 1024L * 1024L)
        val pool = Executors.newFixedThreadPool(4)
        val latch = CountDownLatch(24)

        for (i in 0 until 24) {
            pool.execute {
                try {
                    val key = "url:https://example.com/${i % 6}.jpg"
                    val data = ByteArray(128) { (i % 6).toByte() }
                    cache.put(key, data)
                    val got = cache.get(key)
                    if (got != null) {
                        assertEquals(128, got.size)
                    }
                } finally {
                    latch.countDown()
                }
            }
        }
        assertTrue(latch.await(10, TimeUnit.SECONDS))
        pool.shutdownNow()

        val leftovers = dir.listFiles { f: File -> f.name.endsWith(".tmp") } ?: emptyArray()
        assertEquals(0, leftovers.size)
        for (i in 0 until 6) {
            assertArrayEquals(ByteArray(128) { i.toByte() }, cache.get("url:https://example.com/$i.jpg"))
        }
    }
}
