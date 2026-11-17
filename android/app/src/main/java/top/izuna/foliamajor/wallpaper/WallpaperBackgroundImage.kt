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
        private const val DOWNLOAD_TEMP_PREFIX = "wallpaper_download_"
        /**
         * 只是防御性上限：壁纸要铺满一整屏，图本身必须比屏幕大，否则放大上去就是一团糊。
         * Web 侧已经按壁纸的用途单独压过一遍（不是封面那张 256 的小图），这里不再主动缩。
         */
        private const val MAX_EDGE = WallpaperImageSampling.MAX_EDGE
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
            // 与 storeFromUrl 共用同一把锁：两边写同一个固定文件名，交错写会得到损坏的 JPEG。
            synchronized(WallpaperBackgroundImage::class.java) {
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
            /*
             * 整段兜住 Throwable：这个函数跑在插件里的裸 Thread 上（没有 try/catch），
             * OutOfMemoryError 是 Error，漏出去就是未捕获异常、应用崩溃（#364）。
             * 失败一律返回 null 并留下说得清原因的日志，不带走进程。
             */
            var temp: File? = null
            try {
                // 唯一文件名：背景市场的自动轮换与手动应用可能同时来下载，固定名字会互相踩。
                sweepStaleDownloads(context.cacheDir)
                temp = File.createTempFile(DOWNLOAD_TEMP_PREFIX, ".tmp", context.cacheDir)
                if (!download(url, temp)) {
                    return null
                }
                val scaled = decodeSampled(temp, rotationDegrees, cropLeft, cropTop, cropRight, cropBottom)
                    ?: return null
                // 落盘这一步与 store() 共用同一把锁：两边写的是 filesDir 下同一个固定文件名，
                // 交错写会得到损坏的 JPEG。解码和下载在锁外，不会因为慢网络挡住别人。
                synchronized(WallpaperBackgroundImage::class.java) {
                    val file = file(context)
                    var written = false
                    try {
                        FileOutputStream(file).use { out ->
                            written = scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
                        }
                    } catch (error: Exception) {
                        Log.w(TAG, "Failed to persist the wallpaper background image", error)
                    } finally {
                        scaled.recycle()
                    }
                    if (!written) {
                        delete(file)
                        return null
                    }
                    return key(context)
                }
            } catch (error: OutOfMemoryError) {
                // 单独点名：这是「大图撑爆」而不是「下载失败」，排查时要一眼看出来。同一张图再来一次结果一样。
                Log.w(TAG, "Wallpaper image decode ran out of memory; the source is too large", error)
                return null
            } catch (error: Throwable) {
                Log.w(TAG, "Failed to store the wallpaper background image from a url", error)
                return null
            } finally {
                temp?.let { delete(it) }
            }
        }

        /** 进程在下载途中被杀会遗留临时文件（每个最多 64MB）：下一次下载开始前清掉陈旧的。 */
        private fun sweepStaleDownloads(dir: File) {
            val cutoff = System.currentTimeMillis() - 10 * 60_000L
            try {
                dir.listFiles { f -> f.name.startsWith(DOWNLOAD_TEMP_PREFIX) && f.lastModified() < cutoff }
                    ?.forEach { delete(it) }
            } catch (error: RuntimeException) {
                Log.w(TAG, "Failed to sweep stale wallpaper downloads", error)
            }
        }

        /**
         * 流式下载到 [target]，不把整张图读进堆；超过 [WallpaperImageSampling.MAX_DOWNLOAD_BYTES] 就放弃。
         * @return 下载完整、非空时为 true。
         */
        private fun download(url: String, target: File): Boolean {
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
                    return false
                }
                // 声明的长度已经超限就不必开始读（没声明或声明错时由 copyLimited 兜底）。
                val declared = connection.contentLengthLong
                if (declared > WallpaperImageSampling.MAX_DOWNLOAD_BYTES) {
                    Log.w(TAG, "Wallpaper image skipped: declared $declared bytes exceeds ${WallpaperImageSampling.MAX_DOWNLOAD_BYTES}")
                    return false
                }
                val copied = try {
                    connection.inputStream.use { input ->
                        FileOutputStream(target).use { out -> WallpaperImageSampling.copyLimited(input, out) }
                    }
                } catch (error: WallpaperImageSampling.TooLargeException) {
                    Log.w(TAG, "Wallpaper image skipped: body exceeds ${error.limit} bytes")
                    return false
                }
                if (copied <= 0L) {
                    Log.w(TAG, "Wallpaper image download returned an empty body")
                    return false
                }
                return true
            } catch (error: Throwable) {
                if (error is OutOfMemoryError) throw error
                Log.w(TAG, "Failed to download the wallpaper background image", error)
                return false
            } finally {
                connection.disconnect()
            }
        }

        /**
         * 把 [source] 解码成已旋转、已裁切、最长边不超过 [WallpaperImageSampling.MAX_EDGE] 的位图。
         *
         * 先 inJustDecodeBounds 量出尺寸：像素数超上限的不解（见 [WallpaperImageSampling.MAX_SOURCE_PIXELS]）；
         * 再选 inSampleSize：既保证裁切后那一块仍够清晰，也把**整张**解码结果压在像素预算内
         * （[WallpaperImageSampling.MAX_DECODE_PIXELS]，解码解的是整张，不是裁切块）。
         * 中间位图用完立刻放掉，同一时刻最多两张在内存里。解不了返回 null，原因写进日志。
         */
        private fun decodeSampled(
            source: File,
            rotationDegrees: Int,
            cropLeft: Float,
            cropTop: Float,
            cropRight: Float,
            cropBottom: Float,
        ): Bitmap? {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(source.absolutePath, bounds)
            val width = bounds.outWidth
            val height = bounds.outHeight
            if (width < 2 || height < 2) {
                Log.w(TAG, "Wallpaper image skipped: not a decodable image (mime=${bounds.outMimeType}, ${source.length()} bytes)")
                return null
            }
            if (!WallpaperImageSampling.isDecodable(width, height)) {
                Log.w(TAG, "Wallpaper image skipped: source too large ${width}x$height " +
                        "(limit ${WallpaperImageSampling.MAX_SOURCE_PIXELS} px, mime=${bounds.outMimeType})")
                return null
            }
            val options = BitmapFactory.Options().apply {
                inSampleSize = WallpaperImageSampling.sampleSize(
                    width, height, rotationDegrees, cropLeft, cropTop, cropRight, cropBottom)
            }
            val decoded = BitmapFactory.decodeFile(source.absolutePath, options)
            if (decoded == null) {
                Log.w(TAG, "Wallpaper image skipped: decoder returned no bitmap (${width}x$height, mime=${bounds.outMimeType})")
                return null
            }
            if (decoded.width < 2 || decoded.height < 2) {
                decoded.recycle()
                return null
            }
            // 每一步返回的要么是新图要么是原图（无需处理时原样返回）：新图出现后立刻放掉上一张，
            // 最终返回的那一张交给调用方。任何一步抛出（含 OOM）时，手里还没放掉的也要放掉。
            var current = decoded
            try {
                val rotated = rotate(current, rotationDegrees)
                if (rotated !== current) { current.recycle(); current = rotated }
                val cropped = crop(current, cropLeft, cropTop, cropRight, cropBottom)
                if (cropped !== current) { current.recycle(); current = cropped }
                val scaled = downscale(current)
                if (scaled !== current) { current.recycle(); current = scaled }
                return current
            } catch (error: Throwable) {
                current.recycle()
                throw error
            }
        }

        /** 按 90° 的整数倍旋转；角度不合法时原样返回。 */
        private fun rotate(source: Bitmap, degrees: Int): Bitmap {
            val normalized = ((degrees % 360) + 360) % 360
            if (normalized == 0) return source
            val matrix = android.graphics.Matrix()
            matrix.postRotate(normalized.toFloat())
            return try {
                Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
            } catch (error: Exception) {
                // 只吞普通异常；OutOfMemoryError 向上抛，让调用方点名记录，而不是悄悄落一张没转的图。
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
            // x、y 先夹进图里，宽高再夹到不越界：两个 round() 各自进位时 x + w 可能比图宽大 1，
            // createBitmap 会因此抛 IllegalArgumentException，整张当成功落盘却没裁切。
            val x = Math.round(l * source.width).coerceIn(0, source.width - 1)
            val y = Math.round(t * source.height).coerceIn(0, source.height - 1)
            val w = Math.round((r - l) * source.width).coerceIn(1, source.width - x)
            val h = Math.round((b - t) * source.height).coerceIn(1, source.height - y)
            return try {
                Bitmap.createBitmap(source, x, y, w, h)
            } catch (error: Exception) {
                // 同 rotate()：不吞 OutOfMemoryError。
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
                // 与 storeFromUrl 同一道闸：先量尺寸，超像素上限的不解，其余按壁纸最长边采样（#364）。
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                if (bounds.outWidth > 0 && bounds.outHeight > 0
                        && !WallpaperImageSampling.isDecodable(bounds.outWidth, bounds.outHeight)) {
                    Log.w(TAG, "Wallpaper image skipped: source too large ${bounds.outWidth}x${bounds.outHeight}")
                    return null
                }
                val options = BitmapFactory.Options().apply {
                    inSampleSize = WallpaperImageSampling.sampleSize(
                        bounds.outWidth, bounds.outHeight, 0, 0f, 0f, 1f, 1f)
                }
                val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
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
