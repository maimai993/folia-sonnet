package top.izuna.foliamajor

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log

// 当前文件：通知封面的「按目标尺寸采样解码」（#352）。
//
// 以前是整张解码再缩放：一张 9000×9000 的封面解码出来要 300MB 左右，超过 App 堆上限就
// OutOfMemoryError，被宽泛的 catch 吞掉，表现只是「没有封面」。这里先用 inJustDecodeBounds 量出尺寸，
// 再用 inSampleSize 直接解成目标大小附近，峰值内存只有目标图的几倍。
// 采样与尺寸的纯计算在 [ArtworkSampling]，JVM 单测直接跑。

/**
 * 一次封面加载的结果。
 *
 * 区分「永久失败」与「临时失败」是为了别白白重试：地址对、但图本身不能用（太大 / 不是图片）的，
 * 再下载十次结果也一样，还白耗流量；网络抖动才值得退避重试。
 */
sealed class ArtworkLoad {
    class Loaded(val bitmap: Bitmap) : ArtworkLoad()

    /** 这个地址的内容本身不可用，重试没有意义。[reason] 写进日志。 */
    class Permanent(val reason: String) : ArtworkLoad()

    /** 取不到（网络 / 服务端暂时的问题），值得退避重试。 */
    object Transient : ArtworkLoad()
}

object ArtworkSampling {
    /** 通知封面的目标边长（像素）。 */
    const val NOTIFICATION_TARGET_EDGE = 512

    /**
     * 下载的封面字节上限。超过就不要了：封面是几十到几百 KB 的东西，几十 MB 的「封面」
     * 要么是错的地址（返回了视频 / 原图下载页），要么是攻击；读进内存之前先挡掉。
     * 32MB 给 5000×5000 级的无损 PNG 留足余量（旧代码没有字节上限，这里不能把它们变成无封面）。
     */
    const val MAX_ARTWORK_BYTES = 32 * 1024 * 1024

    /**
     * 解码前允许的源图像素上限（宽 × 高）。
     *
     * 基线 JPEG 与非交错 PNG 采样解码只吃目标图大小的内存，但渐进式 JPEG（整图系数缓冲）、
     * 交错 PNG、无损 WebP 在原生层仍要接近整图的内存：像素越多越危险，而且那是**原生内存**，
     * Java 的 OutOfMemoryError 接不住，会被系统直接杀进程。100M 像素（约 10000×10000）
     * 足够覆盖真实封面（常见 ≤ 3000×3000），超过的图宁可不要。
     */
    const val MAX_SOURCE_PIXELS = 100L * 1000L * 1000L

    /**
     * 选 inSampleSize：2 的幂（BitmapFactory 只认 2 的幂），在**保证解码结果最长边不小于 [targetEdge]**
     * 的前提下取最大值 —— 采样图再用 [scaledSize] 精确缩到目标，不会糊。
     */
    fun sampleSize(width: Int, height: Int, targetEdge: Int): Int {
        if (width <= 0 || height <= 0 || targetEdge <= 0) return 1
        val edge = Math.max(width, height)
        var sample = 1
        while (edge / (sample * 2) >= targetEdge) sample *= 2
        return sample
    }

    /** 把 [width]×[height] 等比缩到最长边 [targetEdge]；已经不超过就原样返回。 */
    fun scaledSize(width: Int, height: Int, targetEdge: Int): Pair<Int, Int> {
        val edge = Math.max(width, height)
        if (edge <= targetEdge || edge <= 0) return Pair(width, height)
        val ratio = targetEdge.toFloat() / edge
        return Pair(
            Math.max(1, Math.round(width * ratio)),
            Math.max(1, Math.round(height * ratio)),
        )
    }

    /** 尺寸是否值得解码：未知（≤0）、或像素数超过上限都不解。 */
    fun isDecodable(width: Int, height: Int): Boolean =
        width > 0 && height > 0 && width.toLong() * height.toLong() <= MAX_SOURCE_PIXELS
}

object ArtworkDecoder {
    private const val TAG = "ArtworkDecoder"

    /**
     * 把图片字节解码成最长边约 [targetEdge] 的位图。不会抛出，也不会让 OutOfMemoryError 把进程带走；
     * 解不了的返回 [ArtworkLoad.Permanent]（内容本身不可用，别重试），并留下**说得清原因**的日志。
     */
    fun decodeSampled(bytes: ByteArray, targetEdge: Int = ArtworkSampling.NOTIFICATION_TARGET_EDGE): ArtworkLoad {
        if (bytes.isEmpty()) return ArtworkLoad.Permanent("empty body")
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            val width = bounds.outWidth
            val height = bounds.outHeight
            if (width <= 0 || height <= 0) {
                // 200 返回了 HTML 错误页 / 不支持的格式：bounds 量不出尺寸。
                val reason = "not a decodable image (mime=${bounds.outMimeType}, ${bytes.size} bytes)"
                Log.w(TAG, "Cover skipped: $reason")
                return ArtworkLoad.Permanent(reason)
            }
            if (!ArtworkSampling.isDecodable(width, height)) {
                val reason = "source too large ${width}x$height (limit ${ArtworkSampling.MAX_SOURCE_PIXELS} px, mime=${bounds.outMimeType})"
                Log.w(TAG, "Cover skipped: $reason")
                return ArtworkLoad.Permanent(reason)
            }
            val options = BitmapFactory.Options().apply {
                inSampleSize = ArtworkSampling.sampleSize(width, height, targetEdge)
            }
            val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
            if (decoded == null) {
                val reason = "decoder returned no bitmap (${width}x$height, mime=${bounds.outMimeType})"
                Log.w(TAG, "Cover skipped: $reason")
                return ArtworkLoad.Permanent(reason)
            }
            val (scaledWidth, scaledHeight) = ArtworkSampling.scaledSize(decoded.width, decoded.height, targetEdge)
            if (scaledWidth == decoded.width && scaledHeight == decoded.height) {
                ArtworkLoad.Loaded(decoded)
            } else {
                val scaled = Bitmap.createScaledBitmap(decoded, scaledWidth, scaledHeight, true)
                if (scaled !== decoded) decoded.recycle()
                ArtworkLoad.Loaded(scaled)
            }
        } catch (error: OutOfMemoryError) {
            // 单独点名：这是「大图撑爆」而不是「没有封面」，排查时要一眼看出来。同一张图再来一次结果一样。
            Log.w(TAG, "Cover decode ran out of memory (${bytes.size} bytes, target $targetEdge)", error)
            ArtworkLoad.Permanent("out of memory while decoding")
        } catch (error: Throwable) {
            Log.w(TAG, "Cover decode failed (${bytes.size} bytes)", error)
            ArtworkLoad.Permanent("decode failed: ${error.javaClass.simpleName}")
        }
    }
}
