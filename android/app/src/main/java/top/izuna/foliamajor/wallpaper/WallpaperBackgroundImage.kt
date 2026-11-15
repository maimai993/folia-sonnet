package top.izuna.foliamajor.wallpaper

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.Log

import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * 壁纸自选背景图的落盘副本。
 *
 * 之前把 base64 整串挂在进程内的歌词状态上传递，看着最省事，实际有三个地方会掉：
 * 应用进程被回收后状态清空；壁纸服务由系统按需绑定、绑定时机可能晚于应用推送；
 * 几百 KB 的字符串每次换歌都要重新过一遍桥。
 *
 * 改成**只落一个文件**：Web 侧选好图之后原生立刻解码写成 JPEG，之后谁要画都直接读文件。
 * 文件本身就是持久化，进程怎么重启都在；状态里只留一个很轻的 key（长度 + 修改时间），
 * 渲染器拿它判断「图换没换过」。
 */
class WallpaperBackgroundImage private constructor() {

    companion object {
        private const val TAG = "FoliaWallpaper"
        private const val FILE_NAME = "folia_wallpaper_background.jpg"
        /**
         * 只是防御性上限：壁纸要铺满一整屏，图本身必须比屏幕大，否则放大上去就是一团糊。
         * Web 侧已经按壁纸的用途单独压过一遍（不是封面那张 256 的小图），这里不再主动缩。
         */
        private const val MAX_EDGE = 2560
        private const val JPEG_QUALITY = 92

        /**
         * 下载时用的 UA：壁纸站按 UA 拦程序请求，用桌面 Chrome 的串最稳。
         *
         * 必须写成一行：`const val` 的初始化器要能在编译期求值，
         * 跨行的 `+` 拼接在部分版本上会直接报语法错误。
         */
        private const val DOWNLOAD_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

        private fun file(context: Context): File {
            return File(context.filesDir, FILE_NAME)
        }

        /**
         * 写入（或清除）自选背景图。
         * @return 当前图的 key；没有图时返回 null。
         */
        @JvmStatic
        fun store(context: Context?, base64: String?): String? {
            if (context == null) {
                return null
            }
            val file = file(context)
            if (base64 == null || base64.trim().isEmpty()) {
                delete(file)
                return null
            }
            val decoded = decode(base64)
            if (decoded == null) {
                Log.w(TAG, "Failed to decode the chosen wallpaper background image")
                return key(context)
            }
            val scaled = downscale(decoded)
            var written = false
            try {
                FileOutputStream(file).use { out ->
                    written = scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
                }
            } catch (error: Exception) {
                Log.w(TAG, "Failed to persist the wallpaper background image", error)
            }
            if (scaled !== decoded) {
                scaled.recycle()
            }
            decoded.recycle()
            if (!written) {
                delete(file)
            }
            return key(context)
        }

        /**
         * 从网络地址下载一张图，按指定范围裁切后存成壁纸背景（背景市场用）。
         *
         * 为什么要裁切：壁纸站上的图几乎全是横屏（16:9），而手机是竖屏。
         * cover 一下会裁掉大半个画面，主体经常被裁没 —— 所以让用户在界面上
         * 拖一个框选定要保留的范围（也可以先转 90° 把横图变成竖图）。
         *
         * @param rotationDegrees 允许 0 / 90 / 180 / 270
         * @param crop            裁切范围，取值 0..1，相对**旋转后**的图；null 表示整张保留
         * @return 成功时返回新图的 key；失败返回 null。
         */
        @JvmStatic
        fun storeFromUrl(
            context: Context?,
            url: String?,
            rotationDegrees: Int = 0,
            cropLeft: Float = 0f,
            cropTop: Float = 0f,
            cropRight: Float = 1f,
            cropBottom: Float = 1f,
        ): String? {
            if (context == null || url.isNullOrBlank()) {
                return null
            }
            val bytes = try {
                val connection = (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
                    connectTimeout = 20_000
                    readTimeout = 30_000
                    instanceFollowRedirects = true
                    // 壁纸站按 UA / Referer 拒绝直连。
                    setRequestProperty("User-Agent", DOWNLOAD_USER_AGENT)
                    setRequestProperty("Accept", "image/*,*/*;q=0.8")
                }
                try {
                    if (connection.responseCode !in 200..299) {
                        Log.w(TAG, "Wallpaper image download failed: HTTP ${connection.responseCode}")
                        return null
                    }
                    connection.inputStream.use { it.readBytes() }
                } finally {
                    connection.disconnect()
                }
            } catch (error: Throwable) {
                Log.w(TAG, "Failed to download the wallpaper background image", error)
                return null
            }
            if (bytes.isEmpty()) {
                return null
            }
            val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
            if (decoded.width < 2 || decoded.height < 2) {
                decoded.recycle()
                return null
            }
            val rotated = rotate(decoded, rotationDegrees)
            val cropped = crop(rotated, cropLeft, cropTop, cropRight, cropBottom)
            val scaled = downscale(cropped)
            if (scaled !== cropped) cropped.recycle()
            if (rotated !== decoded) {
                // rotate() 返回新图时，原图要放掉。
                if (rotated !== cropped && rotated !== scaled) rotated.recycle()
            }
            if (scaled !== decoded && decoded !== rotated) decoded.recycle()

            val file = file(context)
            var written = false
            try {
                FileOutputStream(file).use { out ->
                    written = scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
                }
            } catch (error: Exception) {
                Log.w(TAG, "Failed to persist the wallpaper background image", error)
            }
            scaled.recycle()
            if (!written) {
                delete(file)
                return null
            }
            return key(context)
        }

        /** 按 90° 的整数倍旋转；角度不合法时原样返回。 */
        private fun rotate(source: Bitmap, degrees: Int): Bitmap {
            val normalized = ((degrees % 360) + 360) % 360
            if (normalized == 0) return source
            val matrix = android.graphics.Matrix()
            matrix.postRotate(normalized.toFloat())
            return try {
                Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
            } catch (error: Throwable) {
                Log.w(TAG, "Failed to rotate the wallpaper background image", error)
                source
            }
        }

        /** 按 0..1 的相对范围裁切；范围无效或等于整张时原样返回。 */
        private fun crop(
            source: Bitmap,
            left: Float,
            top: Float,
            right: Float,
            bottom: Float,
        ): Bitmap {
            val l = left.coerceIn(0f, 1f)
            val t = top.coerceIn(0f, 1f)
            val r = right.coerceIn(0f, 1f)
            val b = bottom.coerceIn(0f, 1f)
            if (r - l < 0.02f || b - t < 0.02f) {
                // 太小说明参数坏了，整张保留比给一张碎图好。
                return source
            }
            val x = Math.round(l * source.width)
            val y = Math.round(t * source.height)
            val w = Math.round((r - l) * source.width).coerceAtLeast(1)
            val h = Math.round((b - t) * source.height).coerceAtLeast(1)
            return try {
                Bitmap.createBitmap(source, x, y, w, h)
            } catch (error: Throwable) {
                Log.w(TAG, "Failed to crop the wallpaper background image", error)
                source
            }
        }

        /** 图换没换过的判据：文件长度 + 修改时间。够轻，也不必另存一份指纹。 */
        @JvmStatic
        fun key(context: Context?): String? {
            if (context == null) {
                return null
            }
            val file = file(context)
            if (!file.exists() || file.length() <= 0) {
                return null
            }
            return "${file.length()}@${file.lastModified()}"
        }

        /** 读回背景图。调用方负责 recycle。 */
        @JvmStatic
        fun load(context: Context?): Bitmap? {
            if (context == null) {
                return null
            }
            val file = file(context)
            if (!file.exists()) {
                return null
            }
            return BitmapFactory.decodeFile(file.absolutePath)
        }

        private fun delete(file: File) {
            try {
                if (file.exists() && !file.delete()) {
                    Log.w(TAG, "Failed to delete the wallpaper background image")
                }
            } catch (error: RuntimeException) {
                Log.w(TAG, "Failed to delete the wallpaper background image", error)
            }
        }

        private fun decode(base64: String): Bitmap? {
            return try {
                val comma = base64.indexOf(',')
                val payload = if (comma >= 0) base64.substring(comma + 1) else base64
                val bytes = Base64.decode(payload, Base64.DEFAULT)
                val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                if (bitmap == null || bitmap.width < 2 || bitmap.height < 2) {
                    null
                } else {
                    bitmap
                }
            } catch (error: Throwable) {
                Log.w(TAG, "Failed to decode the wallpaper background image", error)
                null
            }
        }

        private fun downscale(source: Bitmap): Bitmap {
            val edge = Math.max(source.width, source.height)
            if (edge <= MAX_EDGE) {
                return source
            }
            val ratio = MAX_EDGE.toFloat() / edge
            return Bitmap.createScaledBitmap(source,
                    Math.max(1, Math.round(source.width * ratio)),
                    Math.max(1, Math.round(source.height * ratio)), true)
        }
    }
}
