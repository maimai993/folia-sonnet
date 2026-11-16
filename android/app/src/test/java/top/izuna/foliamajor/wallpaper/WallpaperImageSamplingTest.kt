package top.izuna.foliamajor.wallpaper

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream

// 壁纸背景图解码前的纯计算（#364）：字节上限、像素上限、按裁切后目标尺寸选采样倍数。
class WallpaperImageSamplingTest {
    private fun sample(w: Int, h: Int, rotation: Int = 0, l: Float = 0f, t: Float = 0f, r: Float = 1f, b: Float = 1f) =
        WallpaperImageSampling.sampleSize(w, h, rotation, l, t, r, b)

    @Test
    fun smallImagesAreNotSampled() {
        assertEquals(1, sample(1920, 1080))
        assertEquals(1, sample(2560, 2560))
        // 5119 / 2 = 2559 < 2560：再采一次就比目标小了，不能采。
        assertEquals(1, sample(5119, 3000))
    }

    @Test
    fun hugeImagesAreSampledButNeverBelowTarget() {
        assertEquals(2, sample(9000, 9000))
        assertEquals(2, sample(7680, 4320))
        assertEquals(4, sample(10240, 6000))
        assertEquals(8, sample(20480, 20480))
        // 采样后最长边仍不小于目标。
        for (edge in intArrayOf(2561, 5120, 9000, 20000)) {
            val s = sample(edge, edge / 2)
            assertTrue("edge $edge sample $s", edge / s >= WallpaperImageSampling.MAX_EDGE || s == 1)
        }
    }

    @Test
    fun cropKeepsEnoughResolutionForTheCroppedBlock() {
        // 9000x9000 只留左上 25%：裁切块只有 2250 像素，一点都不能采，否则放大后糊。
        assertEquals(1, sample(9000, 9000, l = 0f, t = 0f, r = 0.25f, b = 0.25f))
        // 横图只留中间一半宽：8000 * 0.5 = 4000 →采一次到 2000 < 2560，不采。
        assertEquals(1, sample(8000, 4000, l = 0.25f, r = 0.75f))
        // 整张保留时 16000 的横图可以采 4 倍（16000/4 = 4000 ≥ 2560，/8 = 2000 <）。
        assertEquals(4, sample(16000, 8000))
    }

    @Test
    fun rotationSwapsTheAxesTheCropIsMeasuredOn() {
        // 源图 8000x4000，转 90° 后是 4000x8000。裁切给的是转后的范围：
        // 上半（0..0.5）→ 4000x4000，最长边 4000，采一次到 2000 < 2560，不采。
        assertEquals(1, sample(8000, 4000, rotation = 90, t = 0f, b = 0.5f))
        // 同一个范围不转的话：8000x2000，最长边 8000，可以采 2 倍（4000 ≥ 2560）。
        assertEquals(2, sample(8000, 4000, rotation = 0, t = 0f, b = 0.5f))
        // 负角度与 360 以上等价。
        assertEquals(sample(8000, 4000, rotation = 90, t = 0f, b = 0.5f), sample(8000, 4000, rotation = -270, t = 0f, b = 0.5f))
        assertEquals(sample(8000, 4000, rotation = 0), sample(8000, 4000, rotation = 360))
    }

    @Test
    fun invalidCropFallsBackToTheWholeImage() {
        // 与 crop() 一致：范围太小说明参数坏了，整张保留。
        assertEquals(2, sample(9000, 9000, l = 0.5f, r = 0.51f))
        assertEquals(2, sample(9000, 9000, l = 0.9f, r = 0.1f))
        // 越界值先夹到 0..1。
        assertEquals(2, sample(9000, 9000, l = -5f, t = -5f, r = 5f, b = 5f))
    }

    @Test
    fun degenerateInputsDoNotSample() {
        assertEquals(1, sample(0, 0))
        assertEquals(1, sample(-1, 100))
        assertEquals(1, WallpaperImageSampling.sampleSize(9000, 9000, 0, 0f, 0f, 1f, 1f, 0))
    }

    @Test
    fun sourcePixelLimit() {
        assertTrue(WallpaperImageSampling.isDecodable(9000, 9000))
        assertTrue(WallpaperImageSampling.isDecodable(10000, 10000))
        assertFalse(WallpaperImageSampling.isDecodable(10001, 10000))
        assertFalse(WallpaperImageSampling.isDecodable(30000, 30000))
        assertFalse(WallpaperImageSampling.isDecodable(0, 100))
        assertFalse(WallpaperImageSampling.isDecodable(100, -1))
        // 乘法用 Long：65536 * 65536 在 Int 里会溢出成 0。
        assertFalse(WallpaperImageSampling.isDecodable(65536, 65536))
    }

    @Test
    fun copyLimitedCopiesEverythingUnderTheLimit() {
        val data = ByteArray(300_000) { (it % 251).toByte() }
        val out = ByteArrayOutputStream()
        val copied = WallpaperImageSampling.copyLimited(ByteArrayInputStream(data), out, 300_000)
        assertEquals(300_000L, copied)
        assertTrue(data.contentEquals(out.toByteArray()))
        assertEquals(0L, WallpaperImageSampling.copyLimited(ByteArrayInputStream(ByteArray(0)), ByteArrayOutputStream(), 10))
    }

    @Test
    fun copyLimitedStopsAsSoonAsTheLimitIsCrossed() {
        var served = 0L
        val endless = object : InputStream() {
            override fun read(): Int = 0
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                served += len
                return len
            }
        }
        val out = ByteArrayOutputStream()
        try {
            WallpaperImageSampling.copyLimited(endless, out, 200_000)
            fail("an endless body must hit the limit")
        } catch (error: WallpaperImageSampling.TooLargeException) {
            assertEquals(200_000L, error.limit)
        }
        // 没有把超出的那一块写出去，也没有无限读：最多多读一个缓冲区。
        assertTrue("wrote ${out.size()}", out.size() <= 200_000)
        assertTrue("served $served", served <= 200_000 + 64 * 1024)
    }

    @Test
    fun exactlyTheLimitIsAllowed() {
        val out = ByteArrayOutputStream()
        assertEquals(1000L, WallpaperImageSampling.copyLimited(ByteArrayInputStream(ByteArray(1000)), out, 1000))
    }
}
