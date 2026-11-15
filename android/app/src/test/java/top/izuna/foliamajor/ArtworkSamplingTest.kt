package top.izuna.foliamajor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// android/app/src/test/java/top/izuna/foliamajor/ArtworkSamplingTest.kt
// 通知封面按目标尺寸采样解码的纯计算（#352）。

class ArtworkSamplingTest {

    @Test
    fun `小图不采样`() {
        assertEquals(1, ArtworkSampling.sampleSize(300, 300, 512))
        assertEquals(1, ArtworkSampling.sampleSize(512, 512, 512))
    }

    @Test
    fun `采样倍数是 2 的幂 且解码后最长边仍不小于目标`() {
        // 1024 / 2 = 512 刚好够，不能再采
        assertEquals(2, ArtworkSampling.sampleSize(1024, 1024, 512))
        // 1023 / 2 = 511 < 512，再采会糊
        assertEquals(1, ArtworkSampling.sampleSize(1023, 1023, 512))
        assertEquals(4, ArtworkSampling.sampleSize(2048, 1500, 512))
        // 8000 / 16 = 500 < 512，会糊；8000 / 8 = 1000 才是最大的合法采样
        assertEquals(8, ArtworkSampling.sampleSize(8000, 8000, 512))
        for (edge in listOf(600, 1000, 2000, 4000, 8000, 12000)) {
            val s = ArtworkSampling.sampleSize(edge, edge / 2, 512)
            assertEquals("必须是 2 的幂", 0, s and (s - 1))
            assertTrue("采样后最长边不能小于目标", edge / s >= 512 || s == 1)
        }
    }

    @Test
    fun `按最长边采样 不管是横图还是竖图`() {
        assertEquals(ArtworkSampling.sampleSize(4000, 100, 512), ArtworkSampling.sampleSize(100, 4000, 512))
    }

    @Test
    fun `非法尺寸不采样也不崩`() {
        assertEquals(1, ArtworkSampling.sampleSize(0, 0, 512))
        assertEquals(1, ArtworkSampling.sampleSize(-1, 100, 512))
        assertEquals(1, ArtworkSampling.sampleSize(1000, 1000, 0))
    }

    @Test
    fun `缩放等比 最长边正好是目标`() {
        assertEquals(Pair(512, 256), ArtworkSampling.scaledSize(1024, 512, 512))
        assertEquals(Pair(256, 512), ArtworkSampling.scaledSize(512, 1024, 512))
        assertEquals(Pair(512, 512), ArtworkSampling.scaledSize(2048, 2048, 512))
    }

    @Test
    fun `不超过目标就原样 极端长宽比也不会缩成零`() {
        assertEquals(Pair(300, 200), ArtworkSampling.scaledSize(300, 200, 512))
        val (w, h) = ArtworkSampling.scaledSize(100_000, 1, 512)
        assertEquals(512, w)
        assertTrue(h >= 1)
    }

    @Test
    fun `超大像素或未知尺寸不解码`() {
        assertTrue(ArtworkSampling.isDecodable(4000, 4000))
        assertFalse(ArtworkSampling.isDecodable(0, 0))
        assertFalse(ArtworkSampling.isDecodable(-1, 500))
        // 20000 x 20000 = 4 亿像素 > 上限
        assertFalse(ArtworkSampling.isDecodable(20_000, 20_000))
        // 乘法不能溢出 Int
        assertFalse(ArtworkSampling.isDecodable(Int.MAX_VALUE, Int.MAX_VALUE))
    }

    @Test
    fun `采样后的峰值内存远小于整图解码`() {
        val w = 8000
        val h = 8000
        val full = w.toLong() * h * 4
        val s = ArtworkSampling.sampleSize(w, h, 512)
        val sampled = (w / s).toLong() * (h / s) * 4
        assertEquals("整图 ARGB_8888 是 256,000,000 字节（约 244MiB）", 256_000_000L, full)
        // 8 倍采样 = 1000x1000x4 ≈ 3.8MB，比整图小 64 倍
        assertTrue("采样后应小于 5MB", sampled < 5L * 1024 * 1024)
        assertTrue("至少小 50 倍", full / sampled >= 50)
    }
}
