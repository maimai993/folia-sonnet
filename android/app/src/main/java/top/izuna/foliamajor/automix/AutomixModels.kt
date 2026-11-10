package top.izuna.foliamajor.automix

import android.content.Context
import android.util.Log
import java.io.File
import java.security.MessageDigest

/**
 * Automix 两个分析模型的「本地化」与状态。
 *
 * 这两个权重内置在 APK 的 `assets/models/` 里（约 182MB，构建时打包，
 * 见 app/build.gradle 里 aaptOptions.noCompress 的说明），所以这里没有任何下载逻辑 ——
 * 用户装上 App 就已经拥有它们。
 *
 * 但 ONNX Runtime 要的是一个**真实文件路径**，AssetManager 给不了可 mmap 的 fd
 * （`assets/models/htdemucs-v2.onnx` 在 APK 里是 zip 的一条记录）。
 * 所以首次用到某个模型时，把它原样拷贝到应用私有的 `files/models/` 下，
 * 之后就一直用那份。因为没有压缩，这一步就是一次字节拷贝。
 *
 * 文件是否完好的判断只看大小：内置资产的完整性由 APK 签名保证
 * （签名覆盖整个 zip，包括 asset 记录），再算一次 100MB+ 的 SHA256
 * 只是让首次启动多等几秒。sha256 仍然保留在清单里，供调试与将来校验用。
 */
object AutomixModels {

    private const val TAG = "AutomixModels"
    private const val ASSET_DIR = "models"

    /** JS 侧看到的模型名，也是 assets 里的文件名前缀。 */
    const val BEAT_THIS = "beat_this"
    const val HTDEMUCS = "htdemucs"

    /**
     * 清单：名字 → （asset 文件名，字节数，sha256）。
     *
     * 字节数与上游 shared/modelManifest.json 一致；对不上就说明打包出了问题，
     * 与其让 ONNX Runtime 报一个难懂的 "invalid model"，不如在这里明确失败。
     */
    private data class Entry(val file: String, val bytes: Long, val sha256: String)

    private val ENTRIES = mapOf(
        BEAT_THIS to Entry(
            file = "beat_this.onnx",
            bytes = 83077778L,
            sha256 = "c5c1466e08abdb03fdeb50668a06f244b787d564c212490482231a9cfbe9ccbd",
        ),
        HTDEMUCS to Entry(
            file = "htdemucs-v2.onnx",
            bytes = 107902864L,
            sha256 = "a8f542ef3a140d4879156c1b2b0bcad4b29254dcdbf0fd1ec578e3c9cdca925c",
        ),
    )

    /**
     * 这个构建支持哪些模型。
     *
     * 目前 arm64 与 armeabi-v7a 都支持：onnxruntime-android 的 AAR 自带这两种 ABI。
     * 留成一个函数是因为将来若真的裁掉某个 ABI，这里是唯一要改的地方。
     */
    fun supportedNames(): List<String> = ENTRIES.keys.toList()

    /** 模型在私有目录里的落点。 */
    fun fileFor(context: Context, name: String): File {
        val entry = ENTRIES[name] ?: error("unknown model: $name")
        return File(modelsDir(context), entry.file)
    }

    private fun modelsDir(context: Context): File {
        val dir = File(context.filesDir, "models")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    /** 预期的字节数，供 UI 显示与进度换算。 */
    fun bytesOf(name: String): Long = ENTRIES[name]?.bytes ?: 0L

    /**
     * 这个模型的权重是否已经落到私有目录。
     *
     * 只比大小：见类注释里为什么不算哈希。大小不对的半截文件会被 [ensureLocal]
     * 覆盖掉，所以这里返回 false 是安全的。
     */
    fun isReady(context: Context, name: String): Boolean {
        val entry = ENTRIES[name] ?: return false
        val file = File(modelsDir(context), entry.file)
        return file.isFile && file.length() == entry.bytes
    }

    /**
     * 确保模型在私有目录里存在且完整，返回那个文件。
     *
     * 阻塞调用，可能拷贝 100MB+，必须在后台线程上跑。
     *
     * @param onProgress 已拷贝字节数 / 总字节数，只在真的拷的时候回调。
     */
    fun ensureLocal(
        context: Context,
        name: String,
        onProgress: ((received: Long, total: Long) -> Unit)? = null,
    ): File {
        val entry = ENTRIES[name] ?: error("unknown model: $name")
        val target = File(modelsDir(context), entry.file)

        if (target.isFile && target.length() == entry.bytes) return target

        // 大小不对说明上次拷到一半被打断（进程被杀、空间不足），删掉重来。
        if (target.exists()) {
            Log.w(TAG, "${entry.file} 大小不符（${target.length()} != ${entry.bytes}），重新拷贝")
            target.delete()
        }

        Log.i(TAG, "把 ${entry.file} 从 assets 拷到 ${target.absolutePath}")
        /*
         * 先写到 .part 再改名：这样中途被杀不会留下一个「大小恰好对」的残file。
         * 虽然下面会校验大小，但改名是原子的，比事后补救更干净。
         */
        val part = File(target.absolutePath + ".part")
        var copied = 0L
        context.assets.open("$ASSET_DIR/${entry.file}").use { input ->
            part.outputStream().buffered(1 shl 20).use { output ->
                val buffer = ByteArray(1 shl 20)
                while (true) {
                    val read = input.read(buffer)
                    if (read <= 0) break
                    output.write(buffer, 0, read)
                    copied += read
                    onProgress?.invoke(copied, entry.bytes)
                }
            }
        }
        if (copied != entry.bytes) {
            part.delete()
            error("${entry.file} 拷贝不完整：$copied != ${entry.bytes}")
        }
        if (!part.renameTo(target)) {
            part.delete()
            error("无法把 ${entry.file} 放到 ${target.absolutePath}")
        }
        Log.i(TAG, "${entry.file} 就绪（$copied 字节）")
        return target
    }

    /** 把已经装好的模型删掉，腾出空间。下次用到会重新从 assets 拷。 */
    fun remove(context: Context, name: String): Boolean {
        val entry = ENTRIES[name] ?: return false
        val file = File(modelsDir(context), entry.file)
        return !file.exists() || file.delete()
    }

    /** 调试/校验用：算文件的 SHA256。 */
    fun sha256Of(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered(1 shl 20).use { input ->
            val buffer = ByteArray(1 shl 20)
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** 期望的 SHA256，供校验用。 */
    fun expectedSha256(name: String): String? = ENTRIES[name]?.sha256
}
