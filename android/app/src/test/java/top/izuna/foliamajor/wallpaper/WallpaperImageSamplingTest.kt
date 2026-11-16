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
        // 裁切块只有 2250 像素：按清晰度一点都不能采。9000x9000 整张有 81M 像素，
        // 超过解码预算（见下一个用例）才被迫采一次到 4500x4500，块仍有 1125 像素、整张只有 20M 像素。
        assertEquals(2, sample(9000, 9000, l = 0f, t = 0f, r = 0.25f, b = 0.25f))
        // 不超预算时按清晰度来：5000x5000（25M，刚好在预算内）只留左上 25%，一点都不采。
        assertEquals(1, sample(5000, 5000, l = 0f, t = 0f, r = 0.25f, b = 0.25f))
        // 横图只留中间一半宽：8000 * 0.5 = 4000 →采一次到 2000 < 2560，按清晰度不采；
        // 但整张 32M 像素超预算，所以被迫采 2 倍。
        assertEquals(2, sample(8000, 4000, l = 0.25f, r = 0.75f))
        // 整张保留时 16000 的横图可以采 4 倍（16000/4 = 4000 ≥ 2560，/8 = 2000 <）。
        assertEquals(4, sample(16000, 8000))
    }

    @Test
    fun wholeDecodeStaysWithinThePixelBudget() {
        // 解码解的是整张，不是裁切块：无论裁切成什么样，采样后的整张像素数都不能超预算。
        val sizes = listOf(1 to 1, 2560 to 2560, 5119 to 3000, 9000 to 9000, 10000 to 10000, 16000 to 6000, 3000 to 30000)
        val crops = listOf(
            floatArrayOf(0f, 0f, 1f, 1f), floatArrayOf(0f, 0f, 0.25f, 0.25f),
            floatArrayOf(0.25f, 0.25f, 0.75f, 0.75f), floatArrayOf(0f, 0f, 0.5f, 1f),
        )
        for ((w, h) in sizes) for (c in crops) for (rotation in intArrayOf(0, 90, 180, 270)) {
            val s = sample(w, h, rotation, c[0], c[1], c[2], c[3])
            val decoded = (w.toLong() / s) * (h.toLong() / s)
            assertTrue("${w}x$h rot=$rotation crop=${c.toList()} sample=$s decoded=$decoded",
                s == 1 || decoded <= WallpaperImageSampling.MAX_DECODE_PIXELS)
            // 倍数永远是 2 的幂，BitmapFactory 只认 2 的幂。
            assertEquals(0, s and (s - 1))
        }
        // 预算内的整张不被多采：5119x3000 = 15M 像素，不采。
        assertEquals(1, sample(5119, 3000))
    }

    @Test
    fun rotationSwapsTheAxesTheCropIsMeasuredOn() {
        // 源图 10000x2500（25M 像素，刚好在解码预算内），单看清晰度这一项。
        // 转 90° 后是 2500x10000，裁切给的是转后的范围：上半（0..0.5）→ 2500x5000，
        // 最长边 5000，再采一次到 2500 < 2560，所以不采。
        assertEquals(1, sample(10000, 2500, rotation = 90, t = 0f, b = 0.5f))
        // 同一个范围不转：10000x1250，最长边 10000，采 2 倍到 5000 ≥ 2560，采 4 倍到 2500 < 2560，停在 2。
        assertEquals(2, sample(10000, 2500, rotation = 0, t = 0f, b = 0.5f))
        // 负角度与 360 以上等价。
        assertEquals(sample(10000, 2500, rotation = 90, t = 0f, b = 0.5f), sample(10000, 2500, rotation = -270, t = 0f, b = 0.5f))
        assertEquals(sample(8000, 4000, rotation = 0), sample(8000, 4000, rotation = 360))
    }

    @Test
    fun invalidCropFallsBackToTheWholeImage() {
        // 与 crop() 一致：范围太小说明参数坏了，整张保留（9000x9000 整张得 2）。
        assertEquals(2, sample(9000, 9000, l = 0.5f, r = 0.51f))
        assertEquals(2, sample(9000, 9000, l = 0.9f, r = 0.1f))
        // 越界值先夹到 0..1。
        assertEquals(2, sample(9000, 9000, l = -5f, t = -5f, r = 5f, b = 5f))
        // 无效范围与整张保留给出同一个倍数。
        assertEquals(sample(9000, 9000), sample(9000, 9000, l = 0.5f, r = 0.51f))
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
