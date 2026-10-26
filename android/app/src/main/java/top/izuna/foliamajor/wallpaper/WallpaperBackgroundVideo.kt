package top.izuna.foliamajor.wallpaper

import android.content.Context
import android.net.Uri
import android.util.Log

import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream

/**
 * 壁纸视频背景的落盘副本。
 *
 * 和自选图片同一套思路（见 WallpaperBackgroundImage）：**只落一个文件**，
 * 状态里不留内容、也不留 content:// 的 URI。
 *
 * 为什么必须拷进来而不是直接拿 URI 去播：
 *  · `ACTION_OPEN_DOCUMENT` 给的那份读权限，进程一死就没了，而壁纸服务是系统按需绑定的，
 *    绑定时机完全可能晚于那次授权 —— 直接读 URI 会随机失败（"设好了却黑屏"）；
 *  · 用户随时可能在相册里把那个视频删掉，URI 还在、内容没了。
 * 拷一份进私有目录，这两件事都不再发生，代价只是多占一份磁盘。
 *
 * 视频为什么不能像图片那样转成 base64 过桥：动辄几十 MB，桥上过一趟既慢又吃内存，
 * 而且壁纸服务跟应用不在同一次推送里 —— 所以这里只做「原生自己拷、自己读」。
 */
class WallpaperBackgroundVideo private constructor() {

    companion object {
        private const val TAG = "FoliaWallpaper"
        private const val FILE_NAME = "folia_wallpaper_background.mp4"
        /**
         * 防御性上限。视频壁纸本来就是个耗电的东西，再允许用户塞一部电影进来没什么意义；
         * 超过这个大小直接拒绝并告诉用户，免得拷贝半天才失败。
         */
        private const val MAX_BYTES = 512L * 1024L * 1024L

        private fun file(context: Context): File {
            return File(context.filesDir, FILE_NAME)
        }

        /**
         * 把用户选中的视频拷进私有目录。
         *
         * @return 成功时返回新文件的 key；失败返回 null（旧的那个已经被删掉，不会留下坏文件）。
         */
        @JvmStatic
        fun store(context: Context?, uri: Uri?): String? {
            if (context == null || uri == null) {
                return null
            }
            val target = file(context)
            // 先删旧的：拷贝失败时不该留着上一份在画面上继续播。
            delete(target)
            val temp = File(context.filesDir, FILE_NAME + ".part")
            delete(temp)
            var ok = false
            try {
                val input = context.contentResolver.openInputStream(uri)
                if (input == null) {
                    Log.w(TAG, "Could not open the chosen wallpaper video")
                    return null
                }
                input.use { stream ->
                    var written = 0L
                    val buffer = ByteArray(256 * 1024)
                    FileOutputStream(temp).use { out ->
                        var read = stream.read(buffer)
                        while (read > 0) {
                            out.write(buffer, 0, read)
                            written += read
                            if (written > MAX_BYTES) {
                                Log.w(TAG, "The chosen wallpaper video is too large")
                                return null
                            }
                            read = stream.read(buffer)
                        }
                    }
                    if (written <= 0L) {
                        return null
                    }
                    ok = temp.renameTo(target)
                }
            } catch (error: Throwable) {
                Log.w(TAG, "Failed to copy the chosen wallpaper video", error)
            } finally {
                if (!ok) {
                    delete(temp)
                }
            }
            return if (ok) key(context) else null
        }

        /** 视频换没换过的判据：文件长度 + 修改时间（和图片那套一致）。 */
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

        /** 当前视频文件的绝对路径；没有就返回 null。 */
        @JvmStatic
        fun path(context: Context?): String? {
            if (context == null) {
                return null
            }
            val file = file(context)
            if (!file.exists() || file.length() <= 0) {
                return null
            }
            return file.absolutePath
        }

        @JvmStatic
        fun clear(context: Context?) {
            if (context == null) {
                return
            }
            delete(file(context))
        }

        private fun delete(file: File) {
            try {
                if (file.exists() && !file.delete()) {
                    Log.w(TAG, "Failed to delete the wallpaper background video")
                }
            } catch (error: RuntimeException) {
                Log.w(TAG, "Failed to delete the wallpaper background video", error)
            }
        }
    }
}
