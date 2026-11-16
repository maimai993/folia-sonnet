package top.izuna.foliamajor

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        assertEquals("song:netease:1", ArtworkDiskCache.songKey("netease:1"))

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
            clockMs = { now.get() },
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
    fun `超过总字节上限时淘汰旧项 且超大单项不会清空缓存`() {
        val now = AtomicLong(10_000L)
        val cache = ArtworkDiskCache(
            cacheDir = tempFolder.newFolder("art"),
            maxEntries = 10,
            maxTotalBytes = 10L,
            clockMs = { now.get() },
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
