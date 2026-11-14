package top.izuna.foliamajor

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.util.Log

import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.Locale

/**
 * 歌词后方「视频层」那个本地视频的落盘副本。
 *
 * 为什么必须拷一份进私有目录（和壁纸视频同一个道理，见 wallpaper/WallpaperBackgroundVideo）：
 *  · WebView 里没有 File System Access API（`showOpenFilePicker`），挑文件只能退回
 *    `<input type=file>` —— 拿到的 File 只够转成 `blob:` 地址，**进程一死就失效**，
 *    于是每次重启都要重挑一遍视频（正是这一层要修的事）；
 *  · `ACTION_OPEN_DOCUMENT` 给的那份读权限随进程一起没，`content://` 也播不了
 *    （WebView 的 <video> 不认它），拿原始 URI 去播就是「重开就没了」。
 *
 * 拷进私有目录之后，这两件事都不再发生：副本跟着 App 走，用户把相册里的原视频删掉也不影响。
 * 代价只是多占一份磁盘，所以这里只留**一个**文件（换一个就删掉上一个）。
 *
 * 视频同样不能走 base64 过桥（动辄几十上百 MB），所以是「原生自己拷、自己喂」：
 * 字节留在这里，Web 侧只拿一个回环地址（LocalAudioServer 的 /video-layer/ 路由）。
 */
class VideoLayerFile private constructor() {

    companion object {
        private const val TAG = "FoliaVideoLayer"
        private const val DIRECTORY_NAME = "video-layer"
        /** 固定的文件名（扩展名跟着真身走）：一次只有一个视频，URL 也就永远是同一个。 */
        private const val BASE_NAME = "layer"
        private const val PREFERENCES = "folia_video_layer"
        /** 用户看到的名字：文件名是拼出来的、给 URL 用的，两个不是一回事。 */
        private const val KEY_DISPLAY_NAME = "displayName"
        /** 存下来的扩展名：`file()` 要靠它拼出文件名，而它决定的是喂给 <video> 的 Content-Type。 */
        private const val KEY_EXTENSION = "extension"
        /** 防御性上限：和壁纸视频一致，超过就直接拒绝，免得拷半天才失败。 */
        private const val MAX_BYTES = 512L * 1024L * 1024L

        /** 磁盘上这一份（有或没有都返回：文件不存在时 isFile() 为 false）。 */
        @JvmStatic
        fun file(context: Context?): File? {
            if (context == null) return null
            val dir = directory(context)
            val name = BASE_NAME + storedExtension(context)
            return File(dir, name)
        }

        private fun directory(context: Context): File {
            val dir = File(context.filesDir, DIRECTORY_NAME)
            if (!dir.exists() && !dir.mkdirs()) {
                Log.w(TAG, "Could not create the video layer directory")
            }
            return dir
        }

        /**
         * 把用户挑中的视频拷进私有目录。
         *
         * @return 成功时返回这一份的 key（变了就说明换过视频）；失败返回 null，
         *         旧的那个已经被删掉 —— 宁可没有视频，也不留一个坏的在上面。
         */
        @JvmStatic
        fun store(context: Context?, uri: Uri?, displayName: String?, mimeType: String?): String? {
            if (context == null || uri == null) return null
            clear(context)
            val extension = extensionFor(mimeType, displayName)
            val target = File(directory(context), BASE_NAME + extension)
            val temp = File(directory(context), BASE_NAME + extension + ".part")
            delete(temp)
            val previous = file(context)
            if (previous != null && previous != target) delete(previous)
            var ok = false
            try {
                val input: InputStream? = context.contentResolver.openInputStream(uri)
                if (input == null) {
                    Log.w(TAG, "Could not open the chosen video")
                    return null
                }
                input.use { `in` ->
                    var written = 0L
                    val buffer = ByteArray(256 * 1024)
                    FileOutputStream(temp).use { out ->
                        while (true) {
                            val read = `in`.read(buffer)
                            if (read <= 0) break
                            out.write(buffer, 0, read)
                            written += read.toLong()
                            if (written > MAX_BYTES) {
                                Log.w(TAG, "The chosen video is too large")
                                return null
                            }
                        }
                    }
                    if (written <= 0L) return null
                    ok = temp.renameTo(target)
                }
            } catch (error: Throwable) {
                Log.w(TAG, "Failed to copy the chosen video", error)
            } finally {
                if (!ok) delete(temp)
            }
            if (!ok) return null
            preferences(context)
                .edit()
                .putString(KEY_DISPLAY_NAME, if (displayName == null || displayName.isEmpty()) "video" else displayName)
                .putString(KEY_EXTENSION, extension)
                .apply()
            return key(context)
        }

        /** 换没换过的判据：文件长度 + 修改时间（和壁纸那套一致）。没有就返回 null。 */
        @JvmStatic
        fun key(context: Context?): String? {
            val file = file(context)
            if (file == null || !file.isFile || file.length() <= 0) return null
            return file.length().toString() + "@" + file.lastModified().toString()
        }

        /** 用户在设置里看到的那个名字（挑的时候的原始文件名）。 */
        @JvmStatic
        fun displayName(context: Context?): String? {
            if (context == null) return null
            val file = file(context)
            if (file == null || !file.isFile) return null
            return preferences(context).getString(KEY_DISPLAY_NAME, "video")
        }

        /** 给 <video> 的 Content-Type。按扩展名推：这一层只放我们自己拷进来的那一个文件。 */
        @JvmStatic
        fun mimeType(context: Context?): String {
            if (context == null) return "video/mp4"
            return mimeOf(storedExtension(context))
        }

        @JvmStatic
        fun clear(context: Context?) {
            if (context == null) return
            val dir = directory(context)
            val children = dir.listFiles()
            if (children != null) {
                for (child in children) delete(child)
            }
            preferences(context).edit().clear().apply()
        }

        private fun preferences(context: Context): SharedPreferences {
            return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        }

        private fun storedExtension(context: Context): String {
            val stored = preferences(context).getString(KEY_EXTENSION, null)
            return if (stored == null || stored.isEmpty()) ".mp4" else stored
        }

        /**
         * 扩展名按 ContentResolver 报的类型定，名字只作兜底。
         *
         * 为什么不直接用原始文件名：名字里的空格、中文、emoji 进 URL 都要转义，而扩展名
         * 决定的是 Content-Type —— 报 `video/webm` 却存成 `.mp4`，播放器拿到的类型就错了。
         */
        private fun extensionFor(mimeType: String?, displayName: String?): String {
            val mime = if (mimeType == null) "" else mimeType.lowercase(Locale.ROOT)
            if (mime.contains("webm")) return ".webm"
            if (mime.contains("mp4") || mime.contains("m4v")) return ".mp4"
            if (mime.contains("quicktime")) return ".mov"
            if (mime.contains("ogg")) return ".ogv"
            if (mime.contains("matroska")) return ".mkv"
            if (mime.contains("x-ms-wmv") || mime.contains("x-msvideo")) return ".wmv"
            if (mime.contains("3gpp")) return ".3gp"
            val name = if (displayName == null) "" else displayName.lowercase(Locale.ROOT)
            val dot = name.lastIndexOf('.')
            val fromName = if (dot >= 0) name.substring(dot) else ""
            if (isKnownVideoExtension(fromName)) return fromName
            return ".mp4"
        }

        private fun isKnownVideoExtension(extension: String): Boolean {
            return ".mp4" == extension || ".m4v" == extension || ".webm" == extension
                || ".mov" == extension || ".ogv" == extension || ".mkv" == extension
                || ".wmv" == extension || ".3gp" == extension
        }

        private fun mimeOf(extension: String?): String {
            val lower = if (extension == null) "" else extension.lowercase(Locale.ROOT)
            if (".webm" == lower) return "video/webm"
            if (".mov" == lower) return "video/quicktime"
            if (".ogv" == lower) return "video/ogg"
            if (".mkv" == lower) return "video/x-matroska"
            if (".wmv" == lower) return "video/x-ms-wmv"
            if (".3gp" == lower) return "video/3gpp"
            return "video/mp4"
        }

        private fun delete(file: File) {
            try {
                if (file.exists() && !file.delete()) {
                    Log.w(TAG, "Failed to delete " + file.name)
                }
            } catch (error: RuntimeException) {
                Log.w(TAG, "Failed to delete " + file.name, error)
            }
        }
    }
}
