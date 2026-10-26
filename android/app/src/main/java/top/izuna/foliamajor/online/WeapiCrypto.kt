package top.izuna.foliamajor.online

import android.util.Base64

import java.math.BigInteger
import java.nio.charset.StandardCharsets
import java.security.SecureRandom

import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 网易云 weapi 通道的加密，照抄 {@code src/nativeBridge/api/weapi.js}。
 *
 * 只服务红心兜底这一件事：请求体 AES-128-CBC 加两次（第一次用固定 preset key，
 * 第二次用随机 16 位 key），随机 key 再用无填充 RSA 加密成 encSecKey。
 *
 * RSA 那步在 Java 里反而比 JS 简单：BigInteger.modPow 就是现成的模幂，
 * 不用自己实现 BigInt 运算。
 */
class WeapiCrypto private constructor() {

    companion object {
        private const val IV = "0102030405060708"
        private const val PRESET_KEY = "0CoJUm6Qyw8W8jud"
        private const val BASE62 =
                "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        /**
         * weapi 的 RSA 公钥模数（1024 bit / 256 位十六进制）。必须与官方一致：
         * 写错服务端解不开 encSecKey，回「HTTP 200 + 空 body」——
         * 网页端整页空白的那个老坑（memory 26）就是它写坏的样子。
         */
        private val RSA_MODULUS = BigInteger(
                "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76" +
                        "d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46b" +
                        "ee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7",
                16)
        private val RSA_EXP = BigInteger.valueOf(65537)
        private val RANDOM = SecureRandom()

        /** @return 长度 2：[params, encSecKey]，两个都按表单值原样发送（发送方再 URL 编码）。 */
        @JvmStatic
        @Throws(Exception::class)
        fun encrypt(json: String): Array<String> {
            val secret = StringBuilder()
            for (i in 0 until 16) {
                secret.append(BASE62[RANDOM.nextInt(BASE62.length)])
            }
            val key = secret.toString()
            val params = aes(aes(json, PRESET_KEY), key)
            // JS 侧是把随机 key 逐字符反序后按大端字节累加成大整数。key 全是 base62 字符
            // （ASCII < 0x80），直接按无符号大端字节解释即可；用 new BigInteger(1, bytes)
            // 防止最高位是 1 时被当成补码负数。
            val reversed = StringBuilder(key).reverse().toString()
                    .toByteArray(StandardCharsets.US_ASCII)
            val hex = BigInteger(1, reversed).modPow(RSA_EXP, RSA_MODULUS).toString(16)
            val encSecKey = StringBuilder(256)
            for (i in hex.length until 256) {
                encSecKey.append('0')
            }
            encSecKey.append(hex)
            return arrayOf(params, encSecKey.toString())
        }

        private fun aes(text: String, key: String): String {
            val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
            cipher.init(Cipher.ENCRYPT_MODE,
                    SecretKeySpec(key.toByteArray(StandardCharsets.UTF_8), "AES"),
                    IvParameterSpec(IV.toByteArray(StandardCharsets.UTF_8)))
            // 与 CryptoJS 的 OpenSSL 兼容输出（base64）一致：这里就是裸密文的 base64，
            // 没有 "Salted__" 前缀——JS 侧传的是 key 字符串而非 passphrase，不走 EVP_BytesToKey。
            return Base64.encodeToString(cipher.doFinal(text.toByteArray(StandardCharsets.UTF_8)),
                    Base64.NO_WRAP)
        }
    }
}
