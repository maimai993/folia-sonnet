package top.izuna.foliamajor

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.ArrayList
import java.util.Arrays
import java.util.Base64

import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 汽水加密音频的解密器 —— electron/qishui/qishui-audio-decryptor/ 的 Java 移植。
 *
 * 上游是三份纯 JS：decrypt-utils.js（spade_a 密钥还原 + AES-128-CTR + mp4 表解析）、
 * mp4-box.js（box 扫描）、track-decryptor.js（编排）。这里只移植 decrypt 实际用到的
 * 部分；逐样本偏移、enca→mp4a、flac 剥壳等逻辑与上游一致，方便日后对表同步。
 *
 * spade_a 的两种形态上游都认：纯 hex 直接当密钥；base64 走 decryptSpade 还原。
 */
class QishuiAudioDecryptor private constructor() {

    /** 与上游 TrackDecryptor.decrypt 同形的返回：解密后的整曲与格式信息。 */
    class Result(
        val buffer: ByteArray,
        val flac: Boolean,
        val sampleCount: Int,
        val offsetSource: String
    )

    companion object {
        @JvmStatic
        fun resolveKey(spadeA: String?): ByteArray {
            if (spadeA == null || spadeA.isEmpty()) {
                throw IllegalArgumentException("spade_a is required for decryption.")
            }
            val keyHex = if (spadeA.matches(Regex("^[0-9a-fA-F]+$"))) spadeA else decryptSpadeA(spadeA)
            if (keyHex == null || keyHex.isEmpty()) {
                throw IllegalStateException("Failed to resolve decryption key from spade_a.")
            }
            return hexToBytes(keyHex)
        }

        // ─── spade_a → 密钥 ──────────────────────────────────────────────────

        private fun bitCount(value: Int): Int {
            var current = value
            current = current - ((current shr 1) and 0x55555555)
            current = (current and 0x33333333) + ((current shr 2) and 0x33333333)
            return (((current + (current shr 4)) and 0x0f0f0f0f) * 0x01010101) shr 24
        }

        private fun decodeBase36(charCode: Int): Int {
            if (charCode >= 48 && charCode <= 57) return charCode - 48
            if (charCode >= 97 && charCode <= 122) return charCode - 97 + 10
            return 0xff
        }

        private fun decryptSpadeInner(spadeKey: ByteArray): ByteArray {
            val result = ByteArray(spadeKey.size)
            val working = ByteArray(spadeKey.size + 2)
            working[0] = 0xfa.toByte()
            working[1] = 0x55.toByte()
            System.arraycopy(spadeKey, 0, working, 2, spadeKey.size)

            for (index in 0 until result.size) {
                // 与上游一致的 Java 语义：JS 的 ^ 与 - 都在 32 位有符号数上跑，
                // 但字节值 <= 0xff、working[index] <= 0xff，这里按无符号解读即可。
                var value = ((spadeKey[index].toInt() and 0xff) xor (working[index].toInt() and 0xff)) - bitCount(index) - 21
                while (value < 0) {
                    value += 0xff
                }
                result[index] = (value and 0xff).toByte()
            }
            return result
        }

        private fun decryptSpade(spadeKeyBytes: ByteArray?): String {
            if (spadeKeyBytes == null || spadeKeyBytes.size < 3) return ""
            val paddingLength = (spadeKeyBytes[0].toInt() xor spadeKeyBytes[1].toInt() xor spadeKeyBytes[2].toInt()) - 48
            // JS 里三个字节异或可能为负（有符号 byte）；paddingLength 用前先归一。
            val padding = if (paddingLength < 0) paddingLength + 256 else paddingLength
            if (spadeKeyBytes.size < padding + 2) return ""

            val innerInput = Arrays.copyOfRange(spadeKeyBytes, 1, spadeKeyBytes.size - padding)
            val tempBuffer = decryptSpadeInner(innerInput)
            if (tempBuffer.size == 0) return ""

            val skipBytes = decodeBase36(tempBuffer[0].toInt() and 0xff)
            val decodedMessageLength = spadeKeyBytes.size - padding - 2
            val endIndex = 1 + decodedMessageLength - skipBytes
            if (endIndex > tempBuffer.size || endIndex < 1) return ""
            return String(tempBuffer, 1, endIndex - 1, StandardCharsets.UTF_8)
        }

        private fun decryptSpadeA(spadeA: String): String {
            try {
                return decryptSpade(Base64.getDecoder().decode(spadeA))
            } catch (error: IllegalArgumentException) {
                return ""
            }
        }

        private fun hexToBytes(hex: String?): ByteArray {
            if (hex == null || hex.length % 2 != 0) {
                throw IllegalArgumentException("Hex string length must be even.")
            }
            val out = ByteArray(hex.length / 2)
            for (i in 0 until out.size) {
                out[i] = hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
            }
            return out
        }

        private fun aesCtrDecrypt(key: ByteArray, iv: ByteArray, encrypted: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/CTR/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
            return cipher.doFinal(encrypted)
        }

        // ─── mp4 box ──────────────────────────────────────────────────────────

        private class Box(val size: Long, val type: String, val offset: Int, val end: Int) {

            fun isEmpty(): Boolean {
                return size == 0L
            }

            fun contentStart(): Int {
                return offset + 8
            }
        }

        private fun emptyBox(): Box {
            return Box(0, "", 0, 0)
        }

        private fun uint32be(data: ByteArray, offset: Int): Int {
            return ((data[offset].toInt() and 0xff) shl 24) or ((data[offset + 1].toInt() and 0xff) shl 16) or
                ((data[offset + 2].toInt() and 0xff) shl 8) or (data[offset + 3].toInt() and 0xff)
        }

        private fun boxType(data: ByteArray, offset: Int): String {
            return String(data, offset + 4, 4, StandardCharsets.US_ASCII)
        }

        private fun findBox(buffer: ByteArray, type: String, start: Int, end: Int): Box {
            var position = start
            while (position < end) {
                if (position + 8 > end) break
                val size = uint32be(buffer, position).toLong() and 0xffffffffL
                if (size < 8 || position + size > end) break
                if (boxType(buffer, position) == type) {
                    val boxEnd = position + size.toInt()
                    return Box(size, type, position, boxEnd)
                }
                position += size.toInt()
            }
            return emptyBox()
        }

        // ─── stbl 表解析 ──────────────────────────────────────────────────────

        private fun parseStsz(data: ByteArray): LongArray {
            val sampleSize = uint32be(data, 4).toLong() and 0xffffffffL
            val count = uint32be(data, 8).toLong() and 0xffffffffL
            val sizes = LongArray(count.toInt())
            if (sampleSize != 0L) {
                Arrays.fill(sizes, sampleSize)
                return sizes
            }
            var index = 0
            while (index < count) {
                sizes[index] = uint32be(data, 12 + index * 4).toLong() and 0xffffffffL
                index++
            }
            return sizes
        }

        private class StscEntry(val firstChunk: Long, val samplesPerChunk: Long)

        private fun parseStsc(data: ByteArray): List<StscEntry> {
            val entryCount = uint32be(data, 4)
            val entries = ArrayList<StscEntry>(entryCount)
            for (index in 0 until entryCount) {
                val base = 8 + index * 12
                entries.add(StscEntry(uint32be(data, base).toLong() and 0xffffffffL, uint32be(data, base + 4).toLong() and 0xffffffffL))
            }
            return entries
        }

        private fun parseStco(data: ByteArray): LongArray {
            val entryCount = uint32be(data, 4)
            val offsets = LongArray(entryCount)
            for (index in 0 until entryCount) {
                offsets[index] = uint32be(data, 8 + index * 4).toLong() and 0xffffffffL
            }
            return offsets
        }

        private fun parseCo64(data: ByteArray): LongArray {
            val entryCount = uint32be(data, 4)
            val offsets = LongArray(entryCount)
            val wrap = ByteBuffer.wrap(data).order(ByteOrder.BIG_ENDIAN)
            for (index in 0 until entryCount) {
                offsets[index] = wrap.getLong(8 + index * 8)
            }
            return offsets
        }

        /** 按 ISO/IEC 14496-12 的 stsc + stco + stsz 展开每个样本的真实文件偏移。 */
        private fun computeSampleOffsets(sampleSizes: LongArray?, stscEntries: List<StscEntry>?, chunkOffsets: LongArray?): LongArray {
            if (sampleSizes == null || sampleSizes.size == 0) return LongArray(0)
            if (chunkOffsets == null || chunkOffsets.size == 0) return LongArray(0)

            val total = sampleSizes.size
            val entries: MutableList<StscEntry> = if (stscEntries != null && stscEntries.isNotEmpty())
                ArrayList(stscEntries) else ArrayList()
            entries.sortWith(Comparator { left, right -> left.firstChunk.compareTo(right.firstChunk) })

            val offsets = LongArray(total)
            var sampleIndex = 0

            var chunkIndex = 0
            while (chunkIndex < chunkOffsets.size && sampleIndex < total) {
                var samplesPerChunk = if (entries.isNotEmpty()) entries[0].samplesPerChunk else 0L
                for (entry in entries) {
                    if (entry.firstChunk <= chunkIndex + 1) samplesPerChunk = entry.samplesPerChunk
                }
                if (samplesPerChunk <= 0) return LongArray(0)

                var offset = chunkOffsets[chunkIndex]
                var index = 0
                while (index < samplesPerChunk && sampleIndex < total) {
                    offsets[sampleIndex] = offset
                    offset += sampleSizes[sampleIndex]
                    sampleIndex++
                    index++
                }
                chunkIndex++
            }
            return if (offsets.size == total) offsets else LongArray(0)
        }

        /** senc：version/flags 后 count 个 8 字节 IV（高 8 字节，低 8 字节补零）。 */
        private fun parseSenc(data: ByteArray): Array<ByteArray?> {
            val count = uint32be(data, 4)
            val ivs = arrayOfNulls<ByteArray>(count)
            var position = 8
            for (index in 0 until count) {
                val iv = ByteArray(16)
                System.arraycopy(data, position, iv, 0, 8)
                ivs[index] = iv
                position += 8
            }
            return ivs
        }

        private val FLAC_MARKER = byteArrayOf(0x64, 0x66, 0x4c, 0x61) // 'dfLa'

        private fun scanForFlacMetadata(stsdData: ByteArray): ByteArray {
            val index = indexOf(stsdData, FLAC_MARKER, 0)
            if (index < 4) return ByteArray(0)
            val boxSize = uint32be(stsdData, index - 4)
            val contentStart = index + 4
            val contentEnd = Math.min((index - 4).toLong() + boxSize.toLong(), stsdData.size.toLong()).toInt()
            if (contentEnd <= contentStart) return ByteArray(0)
            return Arrays.copyOfRange(stsdData, contentStart, contentEnd)
        }

        private fun indexOf(haystack: ByteArray, needle: ByteArray, from: Int): Int {
            outer@ for (i in Math.max(from, 0)..(haystack.size - needle.size)) {
                for (j in 0 until needle.size) {
                    if (haystack[i + j] != needle[j]) continue@outer
                }
                return i
            }
            return -1
        }

        private fun replaceEncaWithMp4a(buffer: ByteArray, searchStart: Int, searchEnd: Int) {
            val target = "enca".toByteArray(StandardCharsets.US_ASCII)
            for (index in searchStart..(searchEnd - 4)) {
                if (buffer[index] == target[0] && buffer[index + 1] == target[1]
                    && buffer[index + 2] == target[2] && buffer[index + 3] == target[3]) {
                    buffer[index] = 'm'.code.toByte()
                    buffer[index + 1] = 'p'.code.toByte()
                    buffer[index + 2] = '4'.code.toByte()
                    buffer[index + 3] = 'a'.code.toByte()
                    return
                }
            }
        }

        // ─── 主入口 ───────────────────────────────────────────────────────────

        @JvmStatic
        fun decrypt(encryptedBuffer: ByteArray?, spadeA: String?): Result {
            if (encryptedBuffer == null || encryptedBuffer.size == 0) {
                throw IllegalArgumentException("encryptedBuffer must be non-empty.")
            }
            val key = resolveKey(spadeA)

            val moov = findBox(encryptedBuffer, "moov", 0, encryptedBuffer.size)
            if (moov.isEmpty()) throw IllegalStateException("Decrypt failed: 'moov' atom not found.")

            val trak = findBox(encryptedBuffer, "trak", moov.offset + 8, moov.end)
            val mdia = findBox(encryptedBuffer, "mdia", trak.offset + 8, trak.end)
            val minf = findBox(encryptedBuffer, "minf", mdia.offset + 8, mdia.end)
            val stbl = findBox(encryptedBuffer, "stbl", minf.offset + 8, minf.end)
            val stsd = findBox(encryptedBuffer, "stsd", stbl.offset + 8, stbl.end)
            val stsz = findBox(encryptedBuffer, "stsz", stbl.offset + 8, stbl.end)
            val stsc = findBox(encryptedBuffer, "stsc", stbl.offset + 8, stbl.end)
            val stco = findBox(encryptedBuffer, "stco", stbl.offset + 8, stbl.end)
            val co64 = findBox(encryptedBuffer, "co64", stbl.offset + 8, stbl.end)

            var senc = findBox(encryptedBuffer, "senc", moov.offset + 8, moov.end)
            if (senc.isEmpty()) {
                senc = findBox(encryptedBuffer, "senc", stbl.offset + 8, stbl.end)
            }
            if (senc.isEmpty()) throw IllegalStateException("Decrypt failed: 'senc' atom not found.")

            val mdat = findBox(encryptedBuffer, "mdat", 0, encryptedBuffer.size)
            if (mdat.isEmpty()) throw IllegalStateException("Decrypt failed: 'mdat' atom not found.")

            val flacMetadata = scanForFlacMetadata(
                Arrays.copyOfRange(encryptedBuffer, stsd.contentStart(), stsd.end))
            val flac = flacMetadata.size > 0

            val sampleSizes = parseStsz(Arrays.copyOfRange(encryptedBuffer, stsz.contentStart(), stsz.end))
            val stscEntries = parseStsc(Arrays.copyOfRange(encryptedBuffer, stsc.contentStart(), stsc.end))
            val ivs = parseSenc(Arrays.copyOfRange(encryptedBuffer, senc.contentStart(), senc.end))

            var chunkOffsets = LongArray(0)
            var offsetSource = "sequential"
            if (!stco.isEmpty()) {
                chunkOffsets = parseStco(Arrays.copyOfRange(encryptedBuffer, stco.contentStart(), stco.end))
                offsetSource = "stco"
            } else if (!co64.isEmpty()) {
                chunkOffsets = parseCo64(Arrays.copyOfRange(encryptedBuffer, co64.contentStart(), co64.end))
                offsetSource = "co64"
            }
            val chunkCount = chunkOffsets.size

            // mdat 里可能还夹着别的轨的样本（例如 text 字幕），顺序读会整体错位；
            // 能算出真实偏移且自洽（落在 mdat 内、有序、互不重叠）才用。
            val computed = computeSampleOffsets(sampleSizes, stscEntries, chunkOffsets)
            val useRealOffsets = computed.size == sampleSizes.size && areOffsetsUsable(computed, sampleSizes, mdat)
            if (!useRealOffsets) offsetSource = "sequential"

            if (sampleSizes.size != ivs.size) {
                throw IllegalStateException("Decrypt failed: sample count " + sampleSizes.size +
                    " does not match iv count " + ivs.size + ".")
            }

            val decryptedSamples = arrayOfNulls<ByteArray>(sampleSizes.size)
            var sequentialOffset = mdat.contentStart().toLong()
            for (index in 0 until sampleSizes.size) {
                val size = sampleSizes[index]
                val iv = ivs[index]
                if (iv == null) throw IllegalStateException("Missing IV for sample " + index + ".")
                val sampleOffset = if (useRealOffsets) computed[index] else sequentialOffset
                val start = sampleOffset.toInt()
                val length = size.toInt()
                if (start < 0 || start + length > encryptedBuffer.size) {
                    throw IllegalStateException("Sample " + index + " out of bounds.")
                }
                decryptedSamples[index] = aesCtrDecrypt(key, iv,
                    Arrays.copyOfRange(encryptedBuffer, start, start + length))
                sequentialOffset += size
            }

            val output: ByteArray
            if (flac) {
                output = buildFlacFile(flacMetadata, decryptedSamples)
            } else {
                output = buildM4aFile(encryptedBuffer, decryptedSamples, mdat, stsd, if (useRealOffsets) computed else null)
            }
            return Result(output, flac, Math.min(sampleSizes.size, Int.MAX_VALUE), chunkCount.toString() + "/" + offsetSource)
        }

        private fun areOffsetsUsable(sampleOffsets: LongArray?, sampleSizes: LongArray, mdat: Box): Boolean {
            if (sampleOffsets == null || sampleOffsets.size != sampleSizes.size) return false
            val start = mdat.contentStart().toLong()
            val end = mdat.end.toLong()
            for (index in 0 until sampleOffsets.size) {
                val offset = sampleOffsets[index]
                val size = sampleSizes[index]
                if (offset < start || offset + size > end) return false
                if (index > 0 && offset < sampleOffsets[index - 1] + sampleSizes[index - 1]) return false
            }
            return true
        }

        private fun buildFlacFile(flacMetadata: ByteArray, decryptedSamples: Array<ByteArray?>): ByteArray {
            val out = ByteArrayOutputStream()
            out.write('f'.code)
            out.write('L'.code)
            out.write('a'.code)
            out.write('C'.code)
            val metadataBody = if (flacMetadata.size > 4)
                Arrays.copyOfRange(flacMetadata, 4, flacMetadata.size)
            else
                flacMetadata
            out.write(metadataBody)
            for (sample in decryptedSamples) out.write(sample)
            return out.toByteArray()
        }

        private fun buildM4aFile(fileBuffer: ByteArray, decryptedSamples: Array<ByteArray?>, mdat: Box, stsd: Box, sampleOffsets: LongArray?): ByteArray {
            val output = fileBuffer.clone()
            val useRealOffsets = sampleOffsets != null && sampleOffsets.size == decryptedSamples.size
            var sequentialOffset = mdat.contentStart().toLong()
            for (index in 0 until decryptedSamples.size) {
                val sample = decryptedSamples[index]!!
                val writeOffset = if (useRealOffsets) sampleOffsets!![index] else sequentialOffset
                System.arraycopy(sample, 0, output, writeOffset.toInt(), sample.size)
                sequentialOffset += sample.size
            }
            replaceEncaWithMp4a(output, stsd.offset, stsd.end)
            return output
        }

        /** 与 electron 桥一致的缓存键：sha1(cleanUrl + '\n' + auth)。 */
        @JvmStatic
        fun cacheKey(cleanUrl: String, auth: String): String {
            val digest = MessageDigest.getInstance("SHA-1")
            val hash = digest.digest((cleanUrl + "\n" + auth).toByteArray(StandardCharsets.UTF_8))
            val builder = StringBuilder()
            for (value in hash) builder.append(String.format("%02x", value))
            return builder.toString()
        }
    }
}
