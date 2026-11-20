package top.izuna.foliamajor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

// test/unit/android/LanCastMetadataTest.kt
// 投送声明给音响的媒体元数据（issue M23）。三件事必须在 JVM 上就能钉住：
// 格式按实际地址声明（不是写死 MP3）、duration 在任何 Locale 下都是 ASCII 的 H+:MM:SS、
// 认不出格式时的回退不撒谎。
class LanCastMetadataTest {

    // ---------------------------------------------------------------- 格式判定

    @Test
    fun `a flac source is not declared as mp3`() {
        // issue 的验收标准原话：投送 FLAC 时 protocolInfo 不再是 audio/mpeg。
        val protocolInfo = LanCastMetadata.protocolInfo("http://192.168.1.5:45678/remote-audio/t/song.flac")
        assertFalse(protocolInfo, protocolInfo.contains("audio/mpeg"))
        assertTrue(protocolInfo, protocolInfo.contains("audio/flac"))
        assertTrue(protocolInfo, protocolInfo.contains("DLNA.ORG_PN=FLAC"))
    }

    @Test
    fun `each known container declares its own mime`() {
        val cases = mapOf(
            "a.mp3" to "audio/mpeg",
            "a.flac" to "audio/flac",
            "a.m4a" to "audio/mp4",
            "a.aac" to "audio/mp4",
            "a.alac" to "audio/mp4",
            "a.wav" to "audio/wav",
            "a.ogg" to "audio/ogg",
            "a.opus" to "audio/ogg",
        )
        for ((path, mime) in cases) {
            val protocolInfo = LanCastMetadata.protocolInfo("http://10.0.0.2:49152/$path")
            assertTrue("$path -> $protocolInfo", protocolInfo.contains(":$mime:"))
        }
    }

    @Test
    fun `extension matching ignores case and query string`() {
        assertEquals(LanCastMetadata.Format.FLAC, LanCastMetadata.formatOf("http://h/a.FLAC"))
        assertEquals(LanCastMetadata.Format.FLAC, LanCastMetadata.formatOf("http://h/a.flac?token=abc&x=1"))
        // 主机名里的点不能被当成扩展名。
        assertEquals(LanCastMetadata.Format.UNKNOWN, LanCastMetadata.formatOf("http://speaker.local/stream"))
    }

    @Test
    fun `an explicit type parameter wins over the path`() {
        // `/remote-audio/<token>` 这种路径没有扩展名，格式只能靠参数。
        assertEquals(
            LanCastMetadata.Format.FLAC,
            LanCastMetadata.formatOf("http://h:45678/remote-audio/abc?type=flac"),
        )
        assertEquals(
            LanCastMetadata.Format.FLAC,
            LanCastMetadata.formatOf("http://h:45678/remote-audio/abc?type=audio/flac"),
        )
        // 参数说了是什么就按参数，不再看路径上那个（可能已被改写的）扩展名。
        assertEquals(
            LanCastMetadata.Format.MP3,
            LanCastMetadata.formatOf("http://h/a.flac?format=mp3"),
        )
    }

    @Test
    fun `an unknown format falls back to plain mp3 without claiming a profile`() {
        val protocolInfo = LanCastMetadata.protocolInfo("http://h:45678/remote-audio/abc")
        // 回退到 MP3 但**不**替音响断定 profile：编一个 DLNA.ORG_PN 比不写更容易被拒。
        assertEquals("http-get:*:audio/mpeg:*", protocolInfo)
        assertEquals(LanCastMetadata.Format.UNKNOWN, LanCastMetadata.formatOf(""))
    }

    @Test
    fun `protocolInfo keeps the required four fields`() {
        // http-get:*:<mime>:<profile> —— 字段数写错音响直接不认这条 res。
        val parts = LanCastMetadata.protocolInfo("http://h/a.flac").split(":")
        assertEquals(4, parts.size)
        assertEquals("http-get", parts[0])
        assertEquals("*", parts[1])
    }

    // ---------------------------------------------------------------- 时长

    @Test
    fun `duration is ascii in every locale`() {
        val saved = Locale.getDefault()
        try {
            // 阿拉伯语（印度数字）与波斯语是最容易暴露「默认 Locale 参与格式化」的两个。
            for (locale in listOf(Locale.forLanguageTag("ar-EG"), Locale.forLanguageTag("fa-IR"), Locale.GERMANY)) {
                Locale.setDefault(locale)
                val duration = LanCastMetadata.duration(3_723_000L)
                assertEquals("1:02:03", duration)
                // 逐字符检查 ASCII：DLNA 的 duration 只接受 `H+:MM:SS` 的 ASCII 数字。
                assertTrue("$locale -> $duration", duration.all { it.code in 0..127 })
            }
        } finally {
            Locale.setDefault(saved)
        }
    }

    @Test
    fun `duration format follows dlna h-plus-mm-ss`() {
        // H+ 是「至少一位、不补零」；分秒各两位。过去写 %02d:%02d:%02d，小时也补成了 00，
        // 虽然多数音响能容忍，但不符合 DLNA 的写法。
        assertEquals("0:00:00", LanCastMetadata.duration(0))
        assertEquals("0:00:05", LanCastMetadata.duration(5_000))
        assertEquals("0:01:00", LanCastMetadata.duration(60_000))
        assertEquals("1:00:00", LanCastMetadata.duration(3_600_000))
        assertEquals("10:00:00", LanCastMetadata.duration(36_000_000))
    }

    @Test
    fun `a long track does not overflow`() {
        // 30 天：Int 毫秒装不下（2_592_000_000 > Int.MAX），Long 才行。
        assertEquals("720:00:00", LanCastMetadata.duration(30L * 24 * 3600 * 1000))
    }

    @Test
    fun `a negative duration is zero rather than a broken value`() {
        // 上一次的 Int 溢出会给出负数；音响拿到负时长会停在上一条。
        assertEquals("0:00:00", LanCastMetadata.duration(-1L))
        assertEquals("0:00:00", LanCastMetadata.duration(Long.MIN_VALUE))
    }
}
