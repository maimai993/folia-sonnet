package top.izuna.foliamajor.wallpaper

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

// 壁纸背景图「解码之前」的纯计算：下载字节上限、源图像素上限、按裁切后的目标尺寸选 inSampleSize（#364）。
// 不依赖 Android 类，JVM 单测直接跑；真正的解码在 WallpaperBackgroundImage。

object WallpaperImageSampling {
    /** 壁纸背景图落盘的最长边。 */
    const val MAX_EDGE = 2560

    /**
     * 下载字节上限。壁纸原图常见几 MB 到几十 MB，几百 MB 的「壁纸」多半是错的地址
     * （返回了视频 / 打包下载页）；下载是流式落盘到临时文件，不进堆，所以这里只为挡住灌满存储。
     */
    const val MAX_DOWNLOAD_BYTES = 64L * 1024 * 1024

    /**
     * 解码前允许的源图像素上限（宽 × 高）。
     *
     * 采样解码对基线 JPEG 只吃目标图大小的内存，但渐进式 JPEG、交错 PNG、无损 WebP 在原生层
     * 仍要接近整图的内存，而那是**原生内存**，Java 的 OutOfMemoryError 接不住，会被系统直接杀进程。
     * 100M 像素（约 10000×10000）远超真实壁纸（常见 ≤ 8K），超过的图宁可不要。
     */
    const val MAX_SOURCE_PIXELS = 100L * 1000L * 1000L

    /**
     * 采样后**整张**解码结果的像素上限。
     *
     * inSampleSize 作用在整张源图上，而裁切是解码之后才做的：只按裁切块选倍数的话，
     * 9000×9000 只留 25% 时倍数是 1，要解出 81M 像素（约 324MB）。所以另设一道按整张解码结果算的预算：
     * 25M 像素（约 100MB，ARGB_8888）。整张保留时按目标边长选出的倍数本来就不会超过它
     * （最长边小于 2×2560 即至多 26M 像素量级），它只在「大图 + 小裁切块」时起作用，
     * 代价是这种情况下裁切块的分辨率会低于它在源图里的真实分辨率。
     */
    const val MAX_DECODE_PIXELS = 25L * 1000L * 1000L

    /** 下载超过 [MAX_DOWNLOAD_BYTES] 时抛出；调用方据此留下说得清原因的日志。 */
    class TooLargeException(val limit: Long) : IOException("body exceeds $limit bytes")

    /** 把 [input] 流式拷到 [output]，累计超过 [limit] 字节就停并抛 [TooLargeException]。返回实际拷贝的字节数。 */
    fun copyLimited(input: InputStream, output: OutputStream, limit: Long = MAX_DOWNLOAD_BYTES): Long {
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) return total
            total += read
            if (total > limit) throw TooLargeException(limit)
            output.write(buffer, 0, read)
        }
    }

    /** 尺寸是否值得解码：未知（≤0）、或像素数超过上限都不解。 */
    fun isDecodable(width: Int, height: Int): Boolean =
        width > 0 && height > 0 && width.toLong() * height.toLong() <= MAX_SOURCE_PIXELS

    /**
     * 选 inSampleSize：2 的幂（BitmapFactory 只认 2 的幂）。先在**保证裁切后那块的最长边仍不小于 [targetEdge]**
     * 的前提下取最大值 —— 之后再精确缩到目标，不会糊；再按整张解码结果的像素预算
     * （[MAX_DECODE_PIXELS]）往上加，防止「大图只留一小块」时仍整张全分辨率解码。
     *
     * 裁切范围是相对**旋转后**的图给的（0..1），所以裁切块在源图里占多少像素要先按旋转换算：
     * 旋转 90/270 时旋转后的宽是源图的高。范围无效（太小）时与 `crop()` 一样当作整张保留。
     */
    fun sampleSize(
        width: Int,
        height: Int,
        rotationDegrees: Int,
        cropLeft: Float,
        cropTop: Float,
        cropRight: Float,
        cropBottom: Float,
        targetEdge: Int = MAX_EDGE,
    ): Int {
        if (width <= 0 || height <= 0 || targetEdge <= 0) return 1
        val quarter = ((rotationDegrees % 360) + 360) % 360
        val rotatedWidth = if (quarter == 90 || quarter == 270) height else width
        val rotatedHeight = if (quarter == 90 || quarter == 270) width else height
        val l = cropLeft.coerceIn(0f, 1f)
        val t = cropTop.coerceIn(0f, 1f)
        val r = cropRight.coerceIn(0f, 1f)
        val b = cropBottom.coerceIn(0f, 1f)
        val valid = r - l >= 0.02f && b - t >= 0.02f
        val cropWidth = if (valid) (r - l) * rotatedWidth else rotatedWidth.toFloat()
        val cropHeight = if (valid) (b - t) * rotatedHeight else rotatedHeight.toFloat()
        val edge = Math.max(cropWidth, cropHeight)
        var sample = 1
        while (edge / (sample * 2) >= targetEdge) sample *= 2
        // 再按整张解码结果的内存预算往上加（见 MAX_DECODE_PIXELS）；倍数只会变大，内存只会更省。
        while ((width.toLong() / sample) * (height.toLong() / sample) > MAX_DECODE_PIXELS) sample *= 2
        return sample
    }
}
