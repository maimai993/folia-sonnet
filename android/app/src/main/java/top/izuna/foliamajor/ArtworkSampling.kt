package top.izuna.foliamajor

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log

// 当前文件：通知封面的「按目标尺寸采样解码」（#352）。
//
// 以前是整张解码再缩放：一张 8000×8000 的封面解码出来要 256MB，OutOfMemoryError 被宽泛的 catch 吞掉，
// 表现只是「没有封面」。这里先用 inJustDecodeBounds 量出尺寸，再用 inSampleSize 直接解成目标大小附近，
// 峰值内存只有目标图的几倍。采样与尺寸的纯计算在 [ArtworkSampling]，JVM 单测直接跑。

object ArtworkSampling {
    /** 通知封面的目标边长（像素）。 */
    const val NOTIFICATION_TARGET_EDGE = 512

    /**
     * 下载的封面字节上限。超过就不要了：封面是几十到几百 KB 的东西，几十 MB 的「封面」
     * 要么是错的地址（返回了视频 / 原图下载页），要么是攻击；读进内存之前先挡掉。
     */
    const val MAX_ARTWORK_BYTES = 16 * 1024 * 1024

    /** 解码出来的像素上限（宽 × 高）。再大的图连 bounds 之后的采样图都可能撑爆，直接放弃。 */
    const val MAX_SOURCE_PIXELS = 256L * 1024L * 1024L

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
     * 把图片字节解码成最长边约 [targetEdge] 的位图；解不了（不是图片 / 太大 / 内存不够）返回 null，
     * 并留下**说得清原因**的日志。不会抛出，也不会让 OutOfMemoryError 把进程带走。
     */
    fun decodeSampled(bytes: ByteArray, targetEdge: Int = ArtworkSampling.NOTIFICATION_TARGET_EDGE): Bitmap? {
        if (bytes.isEmpty()) return null
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            val width = bounds.outWidth
            val height = bounds.outHeight
            if (!ArtworkSampling.isDecodable(width, height)) {
                Log.w(TAG, "Cover skipped: unusable size ${width}x$height (${bytes.size} bytes)")
                return null
            }
            val options = BitmapFactory.Options().apply {
                inSampleSize = ArtworkSampling.sampleSize(width, height, targetEdge)
            }
            val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: return null
            val (scaledWidth, scaledHeight) = ArtworkSampling.scaledSize(decoded.width, decoded.height, targetEdge)
            if (scaledWidth == decoded.width && scaledHeight == decoded.height) {
                decoded
            } else {
                val scaled = Bitmap.createScaledBitmap(decoded, scaledWidth, scaledHeight, true)
                if (scaled !== decoded) decoded.recycle()
                scaled
            }
        } catch (error: OutOfMemoryError) {
            // 单独点名：这是「大图撑爆」而不是「没有封面」，排查时要一眼看出来。
            Log.w(TAG, "Cover decode ran out of memory (${bytes.size} bytes, target $targetEdge)", error)
            null
        } catch (error: Throwable) {
            Log.w(TAG, "Cover decode failed (${bytes.size} bytes)", error)
            null
        }
    }
}
