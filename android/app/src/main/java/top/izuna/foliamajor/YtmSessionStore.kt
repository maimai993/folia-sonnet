package top.izuna.foliamajor

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import android.util.AtomicFile

import org.json.JSONObject

import java.io.File
import java.io.FileOutputStream
import java.io.FileInputStream
import java.nio.charset.StandardCharsets
import java.security.KeyStore

import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * YouTube Music 会话的落盘：cookie 与登录用的 UA，用 Android Keystore 里这一应用专属的 AES-GCM
 * 密钥加密后写进一个文件（NoBackupFilesDir，不进云端备份）。只在登录账号对过话之后由 JS 侧
 * 调 saveSession 写入；登出 clearSession 抹掉文件。
 *
 * 密钥长在系统 Keystore 里（setUserAuthenticationRequired 不设——会话在锁屏下也要能用），
 * 出不了这一应用。密文坏了（换了应用数据、Keystore 被重置、文件被改）解不开就整个丢掉记一行：
 * 情愿让用户再登一次，也不把半个会话交回去。
 *
 * 明文只在加密/解密的那一刻存在于内存；文件里除了密文没有别的。日志里没有 cookie 与 UA 的值。
 */
internal class YtmSessionStore private constructor() {
    /** 存着的会话：两个都有才算数。 */
    class YtmSession(val cookie: String, val userAgent: String)

    companion object {
        private const val TAG = "FoliaYtmStore"
        private const val KEY_ALIAS = "folia_ytm_session"
        /** 密文文件的格式：1 字节版本号 + 12 字节 IV + AES/GCM 密文（tag 并在最后 16 字节）。 */
        private const val FORMAT_VERSION = 1
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
        /** cookie 一份 8KB 顶天（JS 侧同一上限），超长的一律不存。 */
        private const val COOKIE_LIMIT = 8192
        private const val UA_LIMIT = 256

        private fun file(context: Context): File {
            return File(context.noBackupFilesDir, "folia_ytm_session.bin")
        }

        /** Keystore 里那一把应用的密钥；还没有就现造一把（AES-256、GCM、只在这一应用内）。 */
        @Throws(Exception::class)
        private fun key(create: Boolean): SecretKey {
            val store = KeyStore.getInstance("AndroidKeyStore")
            store.load(null)
            val entry = store.getEntry(KEY_ALIAS, null)
            if (entry is KeyStore.SecretKeyEntry) {
                return entry.secretKey
            }
            if (!create) throw IllegalStateException("Session key is missing")
            val spec = KeyGenParameterSpec.Builder(KEY_ALIAS,
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

        /** 读回存着的会话；没有存、或密文解不开（密钥换了、文件坏了），都答 null。 */
        @JvmStatic
        @Synchronized
        internal fun read(context: Context): YtmSession? {
            val file = file(context)
            val sealed: ByteArray
            try {
                sealed = readFile(file)
            } catch (error: Exception) {
                return null // 还没有存过
            }
            if (sealed.size < 1 + IV_BYTES + TAG_BITS / 8 || sealed[0].toInt() != FORMAT_VERSION) {
                Log.w(TAG, "the stored YouTube Music session is truncated; it is discarded")
                clear(context)
                return null
            }
            return try {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(TAG_BITS, sealed, 1, IV_BYTES))
                val plain = cipher.doFinal(sealed, 1 + IV_BYTES, sealed.size - 1 - IV_BYTES)
                decode(plain)
            } catch (error: Exception) {
                // 密钥对不上（这台设备重置过 Keystore）或密文被改：整个丢掉，让用户再登一次。
                Log.w(TAG, "the stored YouTube Music session could not be opened; it is discarded")
                clear(context)
                null
            }
        }

        /** 会话存下去；cookie 与 UA 都得有、都不超长，写完整个文件才算。 */
        @JvmStatic
        @Synchronized
        internal fun write(context: Context, cookie: String?, userAgent: String?): Boolean {
            if (!validHeader(cookie, COOKIE_LIMIT) || !validHeader(userAgent, UA_LIMIT)) {
                return false
            }
            try {
                val plain = encode(cookie, userAgent)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                // Android Keystore requires provider-generated IVs when randomized encryption is required.
                cipher.init(Cipher.ENCRYPT_MODE, key(true))
                val iv = cipher.iv
                if (iv == null || iv.size != IV_BYTES) return false
                val sealed = cipher.doFinal(plain)
                val target = AtomicFile(file(context))
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
                return true
            } catch (error: Exception) {
                Log.w(TAG, "the YouTube Music session could not be stored; sign-in must not be committed", error)
                return false
            }
        }

        /** 抹掉存着的会话文件；文件不在了也是「抹掉了」。 */
        @JvmStatic
        @Synchronized
        internal fun clear(context: Context): Boolean {
            val file = file(context)
            var keyGone = false
            try {
                val store = KeyStore.getInstance("AndroidKeyStore")
                store.load(null)
                store.deleteEntry(KEY_ALIAS)
                keyGone = !store.containsAlias(KEY_ALIAS)
            } catch (error: Exception) {
                Log.w(TAG, "the YouTube Music session key could not be removed")
            }
            AtomicFile(file).delete()
            val gone = !file.exists()
            if (!gone) Log.w(TAG, "the stored YouTube Music session file could not be removed")
            return gone && keyGone
        }

        // ---- 明文的打包（JSON：cookie、userAgent、存入时间）。只在这两个方法之间来去。 ----

        @Throws(Exception::class)
        private fun encode(cookie: String?, userAgent: String?): ByteArray {
            val `object` = JSONObject()
            `object`.put("driver", FORMAT_VERSION)
            `object`.put("cookie", cookie)
            `object`.put("userAgent", userAgent)
            `object`.put("storedAt", System.currentTimeMillis())
            return `object`.toString().toByteArray(StandardCharsets.UTF_8)
        }

        @Throws(Exception::class)
        private fun decode(plain: ByteArray): YtmSession? {
            val `object` = JSONObject(String(plain, StandardCharsets.UTF_8))
            val cookie = `object`.optString("cookie", "")
            if (`object`.optInt("driver", 0) != FORMAT_VERSION || !validHeader(cookie, COOKIE_LIMIT)) return null
            val userAgent = `object`.optString("userAgent", "")
            if (!validHeader(userAgent, UA_LIMIT)) return null
            return YtmSession(cookie, userAgent)
        }

        private fun validHeader(value: String?, limit: Int): Boolean {
            if (value == null || value.isEmpty() || value.length > limit) return false
            for (i in value.indices) {
                val c = value[i]
                if (c.code < 32 || c.code > 126) return false
            }
            return true
        }

        @Throws(Exception::class)
        private fun readFile(file: File): ByteArray {
            AtomicFile(file).openRead().use { reader ->
                val length = reader.channel.size()
                if (length < 1 || length > 65536) throw java.io.IOException("Invalid session file size")
                val data = ByteArray(length.toInt())
                var offset = 0
                while (offset < data.size) {
                    val count = reader.read(data, offset, data.size - offset)
                    if (count < 0) throw java.io.IOException("Truncated session")
                    offset += count
                }
                return data
            }
        }
    }
}
