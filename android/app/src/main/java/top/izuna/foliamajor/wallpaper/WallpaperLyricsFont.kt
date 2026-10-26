package top.izuna.foliamajor.wallpaper

import android.content.Context
import android.graphics.Typeface
import android.net.Uri
import android.util.Base64
import android.util.Log

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream

/**
 * 壁纸歌词的自选字体。
 *
 * 渲染器原先写死了 sans-serif，用户没法换。字体文件不进 SharedPreferences、
 * 也不在歌词状态里传 base64 —— 一个中文字体动辄好几 MB，桥上过一趟不现实，
 * localStorage 也装不下。做法与背景图一致：**只落一个文件**，文件本身就是持久化，
 * 状态里只留一个 key（长度 + 修改时间），渲染器按 key 变化重新加载 Typeface。
 */
class WallpaperLyricsFont private constructor() {

    companion object {
        private const val TAG = "FoliaWallpaper"
        /** 「单独」模式那份：用户用系统文件选择器挑的。 */
        private const val FILE_CUSTOM = "folia_wallpaper_font.ttf"
        /**
         * 「跟随播放页」那份：网页把播放页那个字体的字节托管过来的。
         *
         * 分两个文件是必须的：共用一个的话，切到「跟随」会把用户自己挑的字体删掉，
         * 切回来还得重新挑一遍（而且设置里「已选字体」会静默变成没选）。
         */
        private const val FILE_FOLLOW = "folia_wallpaper_font_follow.ttf"

        private fun file(context: Context): File {
            return File(context.filesDir, FILE_CUSTOM)
        }

        private fun followFile(context: Context): File {
            return File(context.filesDir, FILE_FOLLOW)
        }

        /**
         * 此刻该读哪一份。
         *
         * 判据是「字体来路」那个开关（wp.lyricsFontCustom）。缺这个 key（还没推过配置）
         * 时按「单独」处理：老用户自己挑过的字体不该悄悄失效。
         */
        @JvmStatic
        fun activeFile(context: Context): File {
            val tuning = WallpaperLyricsState.tuning()
            val custom = if (tuning == null) null else tuning["wp.lyricsFontCustom"]
            val isCustom = custom == null || custom >= 0.5f
            return if (isCustom) file(context) else followFile(context)
        }

        /** 写入（或清除）「单独」那份；返回它的 key，没有时返回 null。 */
        @JvmStatic
        fun store(context: Context?, base64: String?): String? {
            return write(context, file(context!!), base64, "c")
        }

        /** 写入（或清除）「跟随播放页」那份：网页托管过来的字节。 */
        @JvmStatic
        fun storeFollow(context: Context?, base64: String?): String? {
            return write(context, followFile(context!!), base64, "f")
        }

        private fun write(context: Context?, file: File, base64: String?, slot: String): String? {
            if (context == null) {
                return null
            }
            if (base64 == null || base64.trim().isEmpty()) {
                delete(file)
                return null
            }
            var written = false
            try {
                val bytes = decode(base64)
                if (bytes != null && bytes.isNotEmpty()) {
                    FileOutputStream(file).use { out ->
                        out.write(bytes)
                        written = true
                    }
                }
            } catch (error: Exception) {
                Log.w(TAG, "Failed to persist the wallpaper lyrics font", error)
            }
            return verify(context, file, written, slot)
        }

        /**
         * 从系统文件选择器给的 URI 直接拷进私有目录。
         *
         * 一个中文字体动辄好几 MB，转成 base64 再过 Capacitor 的桥不现实（又慢又占内存），
         * 所以让用户用系统的文件选择器选，原生拿到 URI 自己拷。
         */
        @JvmStatic
        fun copyFrom(context: Context?, uri: Uri?): String? {
            if (context == null || uri == null) {
                return null
            }
            val file = file(context)
            return copyInto(context, file, uri, "c")
        }

        private fun copyInto(context: Context, file: File, uri: Uri, slot: String): String? {
            var written = false
            var input: InputStream? = null
            try {
                input = context.contentResolver.openInputStream(uri)
                if (input != null) {
                    FileOutputStream(file).use { out ->
                        val buffer = ByteArray(64 * 1024)
                        var read = input.read(buffer)
                        while (read > 0) {
                            out.write(buffer, 0, read)
                            read = input.read(buffer)
                        }
                        written = true
                    }
                }
            } catch (error: Exception) {
                Log.w(TAG, "Failed to copy the chosen lyrics font", error)
            } finally {
                if (input != null) {
                    try {
                        input.close()
                    } catch (ignored: IOException) {
                        // 关闭失败不影响结果。
                    }
                }
            }
            return verify(context, file, written, slot)
        }

        /**
         * 拷完/写完之后做一次校验：用户可能选错文件（.zip、.txt 甚至视频）。
         * 这时把文件删掉并当没设过，避免「设置里显示已选字体，壁纸却还是系统字体」的错觉。
         */
        private fun verify(context: Context, file: File, written: Boolean, slot: String): String? {
            if (!written) {
                delete(file)
                return null
            }
            if (loadFile(file) == null) {
                Log.w(TAG, "The chosen lyrics font is not a usable font file, dropping it")
                delete(file)
                return null
            }
            /*
             * key 带上槽位前缀：两份文件碰巧同长度同修改时间时（极小的概率，但换字体
             * 时真撞上就是「改了不生效」），渲染器会以为没换过而不重新加载。
             */
            return slot + ":" + file.length() + "@" + file.lastModified()
        }

        /** 字体换没换过的判据：槽位 + 文件长度 + 修改时间。 */
        @JvmStatic
        fun key(context: Context?): String? {
            if (context == null) {
                return null
            }
            return keyOf(null, activeFile(context))
        }

        private fun keyOf(slot: String?, file: File?): String? {
            if (file == null || !file.exists() || file.length() <= 0) {
                return null
            }
            val prefix = if (slot == null)
                (if (file.name.endsWith("_follow.ttf")) "f" else "c")
            else
                slot
            return prefix + ":" + file.length() + "@" + file.lastModified()
        }

        /**
         * 读回字体。文件可能不是合法字体（用户选错了文件），那时返回 null，
         * 渲染器回落到系统 sans-serif，不让整个壁纸跟着崩。
         */
        @JvmStatic
        fun load(context: Context?): Typeface? {
            if (context == null) {
                return null
            }
            return loadFile(activeFile(context))
        }

        /**
         * 读一份字体文件。
         *
         * 读哪一份由「字体来路」那个开关决定（见 activeFile）。来路是**写**那一侧的事，
         * 读这里只看文件本身 —— 早先我在这里按模式挡了一次是错的：`store()` 写完会调
         * `verify()` → `load()`，挡一下等于「推下来的字体被判成坏文件、当场删掉」。
         */
        private fun loadFile(file: File?): Typeface? {
            if (file == null || !file.exists()) {
                return null
            }
            return try {
                val typeface = Typeface.createFromFile(file.absolutePath)
                // createFromFile 对坏文件不抛异常，而是回落到默认字体；用它自己比一次即可识别。
                if (typeface == null || typeface == Typeface.DEFAULT) {
                    null
                } else {
                    typeface
                }
            } catch (error: Throwable) {
                Log.w(TAG, "Failed to load the wallpaper lyrics font", error)
                null
            }
        }

        private fun delete(file: File) {
            try {
                if (file.exists() && !file.delete()) {
                    Log.w(TAG, "Failed to delete the wallpaper lyrics font")
                }
            } catch (error: RuntimeException) {
                Log.w(TAG, "Failed to delete the wallpaper lyrics font", error)
            }
        }

        private fun decode(base64: String): ByteArray? {
            return try {
                val comma = base64.indexOf(',')
                val payload = if (comma >= 0) base64.substring(comma + 1) else base64
                Base64.decode(payload, Base64.DEFAULT)
            } catch (error: Throwable) {
                Log.w(TAG, "Failed to decode the wallpaper lyrics font", error)
                null
            }
        }
    }
}
