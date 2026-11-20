package top.izuna.foliamajor

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Log

import org.json.JSONObject

import java.io.File
import java.nio.charset.StandardCharsets
import java.security.KeyStore

import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 一小段**不该落明文**的数据（平台 cookie、账号 token），用 Android Keystore 里这一应用专属的
 * AES-GCM 密钥加密后写文件。FoliaSecureStore.kt
 *
 * 为什么复用 [YtmSessionStore] 那一套而不是引 androidx.security（EncryptedSharedPreferences）：
 *   1. 仓库里已经有这条加密落盘的路（YtmSessionStore，YouTube Music 会话），同一套密钥来源、
 *      同一种文件格式、同样的"解不开就丢掉"策略，多一条并行机制只会多一处要记着维护的地方；
 *   2. EncryptedSharedPreferences 的新版本被官方标为 deprecated，而它的价值（钥匙串 + 键值壳）
 *      我们用不上 —— 这里存的都是"整段替换"的小 JSON；
 *   3. 不新增依赖，`npm run check:versions` 与离线构建都不用跟着动。
 *
 * 密钥长在系统 Keystore 里，出不了这一应用；文件放在 noBackupFilesDir（不进云备份、不进换机迁移），
 * 因为密文换个设备也解不开，带过去只会让用户看到一条"读不出来"。
 *
 * 明文只在加解密那一刻存在于内存。日志里不记值。
 *
 * 与 [YtmSessionStore] 的差别只有两处：键名 / 文件名可由调用方给（一个平台的 cookie、一个账号的
 * token 各占一份），以及"文件不在"与"解不开"分开回答 —— 前者的返回值里 `found = false`，
 * 后者 `decrypted = false`，调用方据此决定要不要清掉明文旧数据。
 */
internal object FoliaSecureStore {

    /**
     * 一次读取的结果。
     *
     * - `found = false`：从来没有存过（或已经删掉）。
     * - `found = true, decrypted = true`：`text` 是原文。
     * - `found = true, decrypted = false`：文件在，但解不开（换过设备、Keystore 被重置、密文坏了）。
     *   这时 `text` 是 null：调用方**不要**把它当成"没有"，也不要据此降级成明文。
     */
    class Stored(val found: Boolean, val decrypted: Boolean, val text: String?)

    /** 文件格式：1 字节版本号 + 12 字节 IV + AES/GCM 密文（tag 在最后 16 字节）。 */
    private const val FORMAT_VERSION = 1
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128
    /** 一份存下来的数据的上限：cookie 是整串，8KB 顶天。 */
    private const val TEXT_LIMIT = 16384
    private const val FILE_LIMIT = 65536
    private const val TAG = "FoliaSecureStore"

    /** 每条数据一把密钥：别名里带上 slot，互不影响，删一条不会误伤别家。 */
    private fun keyAlias(slot: String): String = "folia_secure_$slot"

    private fun file(context: Context, slot: String): File {
        val safe = slot.replace(Regex("[^A-Za-z0-9_.-]"), "_")
        return File(context.noBackupFilesDir, "folia_secure_$safe.bin")
    }

    /** Keystore 里这一条数据的密钥；还没有就现造一把（AES-256、GCM、只在这一应用内）。 */
    @Throws(Exception::class)
    private fun key(slot: String, create: Boolean): SecretKey {
        val alias = keyAlias(slot)
        val store = KeyStore.getInstance("AndroidKeyStore")
        store.load(null)
        val entry = store.getEntry(alias, null)
        if (entry is KeyStore.SecretKeyEntry) return entry.secretKey
        if (!create) throw IllegalStateException("Secure store key is missing")
        val spec = KeyGenParameterSpec.Builder(alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build()
        val generator = KeyGenerator.getInstance("AES", "AndroidKeyStore")
        generator.init(spec)
        return generator.generateKey()
    }

    /** 读回一条；文件不存在答 found = false，解不开答 decrypted = false。 */
    @Synchronized
    internal fun read(context: Context, slot: String): Stored {
        val file = file(context, slot)
        if (!file.exists()) return Stored(false, false, null)
        val sealed = try {
            readFile(file)
        } catch (error: Exception) {
            Log.w(TAG, "secure slot $slot could not be read; it is discarded")
            clear(context, slot)
            return Stored(true, false, null)
        }
        if (sealed.size < 1 + IV_BYTES + TAG_BITS / 8 || sealed[0].toInt() != FORMAT_VERSION) {
            Log.w(TAG, "secure slot $slot is truncated; it is discarded")
            clear(context, slot)
            return Stored(true, false, null)
        }
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(slot, false), GCMParameterSpec(TAG_BITS, sealed, 1, IV_BYTES))
            val plain = cipher.doFinal(sealed, 1 + IV_BYTES, sealed.size - 1 - IV_BYTES)
            val text = String(plain, StandardCharsets.UTF_8)
            if (text.isEmpty() || text.length > TEXT_LIMIT) throw IllegalStateException("invalid secure slot size")
            Stored(true, true, text)
        } catch (error: Exception) {
            // 密钥对不上（这台设备重置过 Keystore）或密文被改：整个丢掉，让用户重新登录一次。
            Log.w(TAG, "secure slot $slot could not be opened; it is discarded")
            clear(context, slot)
            Stored(true, false, null)
        }
    }

    /**
     * 写一条。返回 false = 没写进去（Keystore 不可用、IO 失败）。
     *
     * **写失败不降级成明文**：调用方要把这个 false 当作"这次没存上"上报，让功能退回到
     * 本次会话有效，而不是偷偷落一份明文出去。
     */
    @Synchronized
    internal fun write(context: Context, slot: String, text: String?): Boolean {
        if (text == null || text.isEmpty() || text.length > TEXT_LIMIT) return false
        val file = file(context, slot)
        return try {
            val plain = text.toByteArray(StandardCharsets.UTF_8)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            // Android Keystore 要求随机加密时由它自己给 IV。
            cipher.init(Cipher.ENCRYPT_MODE, key(slot, true))
            val iv = cipher.iv
            if (iv == null || iv.size != IV_BYTES) return false.also { Log.w(TAG, "secure slot $slot got no IV") }
            val sealed = cipher.doFinal(plain)
            file.parentFile?.mkdirs()
            val target = AtomicFile(file)
            val out = target.startWrite()
            try {
                out.write(FORMAT_VERSION)
                out.write(iv)
                out.write(sealed)
                target.finishWrite(out)
            } catch (error: Exception) {
                target.failWrite(out)
                throw error
            }
            true
        } catch (error: Exception) {
            Log.w(TAG, "secure slot $slot could not be stored", error)
            false
        }
    }

    /**
     * 抹掉一条，连密钥一起。返回文件是否已经不在了。
     *
     * 删密钥是为了"真的删干净"：密文留着也解不开，但留着只会让下次读到 decrypted = false 再清一遍。
     */
    @Synchronized
    internal fun clear(context: Context, slot: String): Boolean {
        try {
            val store = KeyStore.getInstance("AndroidKeyStore")
            store.load(null)
            store.deleteEntry(keyAlias(slot))
        } catch (error: Exception) {
            Log.w(TAG, "secure slot $slot key could not be removed")
        }
        val file = file(context, slot)
        AtomicFile(file).delete()
        return !file.exists()
    }

    @Throws(Exception::class)
    private fun readFile(file: File): ByteArray {
        AtomicFile(file).openRead().use { reader ->
            val length = reader.channel.size()
            if (length < 1 || length > FILE_LIMIT) throw java.io.IOException("Invalid secure slot size")
            val data = ByteArray(length.toInt())
            var offset = 0
            while (offset < data.size) {
                val count = reader.read(data, offset, data.size - offset)
                if (count < 0) throw java.io.IOException("Truncated secure slot")
                offset += count
            }
            return data
        }
    }

    /** 只给单测与排查用：这条数据有没有落过盘。 */
    internal fun exists(context: Context, slot: String): Boolean = file(context, slot).exists()

    /** 打包一份键值表（多字段一起存的槽位用）。字段值都按字符串存。 */
    internal fun encode(values: Map<String, String?>): String = JSONObject().apply {
        put("v", FORMAT_VERSION)
        values.forEach { (key, value) -> put(key, value ?: "") }
        put("storedAt", System.currentTimeMillis())
    }.toString()

    /** 解一份键值表；不是这一版格式的答 null。 */
    internal fun decode(text: String): JSONObject? = try {
        val parsed = JSONObject(text)
        if (parsed.optInt("v", 0) == FORMAT_VERSION) parsed else null
    } catch (error: Exception) {
        Log.w(TAG, "secure slot content is not JSON")
        null
    }
}
