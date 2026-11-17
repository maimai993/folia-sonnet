package top.izuna.foliamajor

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// app/src/test/java/top/izuna/foliamajor/MediaCachePayloadNameTest.kt
// 媒体缓存按前缀找副本时，必须跳过挂在旁边的 sidecar 与残骸。
//
// 真机上出过：一个 1 字节的 `.cnt` 被当成音频发给播放器（报「认不出格式」），
// 坏副本自愈时删掉的也是 `.cnt`，真正的坏文件原地继续命中 —— 于是永远播放错误。

class MediaCachePayloadNameTest {

    @Test
    fun `计数文件不是副本本身`() {
        assertFalse(LocalAudioServer.isMediaCachePayloadName("YXVkaW9fb25saW5lOm5ldGVhc2U6MTk3NTYxNzU4Nw.mp3.cnt"))
    }

    @Test
    fun `写到一半的残骸不是副本本身`() {
        assertFalse(LocalAudioServer.isMediaCachePayloadName("YXVkaW9fb25saW5lOm5ldGVhc2U6MTk3NTYxNzU4Nw.mp3.part"))
    }

    @Test
    fun `各种扩展名的真副本都认`() {
        assertTrue(LocalAudioServer.isMediaCachePayloadName("YXVkaW9fb25saW5lOm5ldGVhc2U6MTk3NTYxNzU4Nw.mp3"))
        assertTrue(LocalAudioServer.isMediaCachePayloadName("YXVkaW9fb25saW5lOm5ldGVhc2U6MTk3NTYxNzU4Nw.m4a"))
        assertTrue(LocalAudioServer.isMediaCachePayloadName("YXVkaW9fb25saW5lOm5ldGVhc2U6MTk3NTYxNzU4Nw.flac"))
    }

    @Test
    fun `名字以 cnt 结尾但不是 sidecar 的不该被误判`() {
        // 只有 `.cnt` 这个**后缀**才是 sidecar；`xxx.cnt.mp3` 仍是正文。
        assertTrue(LocalAudioServer.isMediaCachePayloadName("abc.cnt.mp3"))
        assertTrue(LocalAudioServer.isMediaCachePayloadName("abc.part.m4a"))
    }
}
