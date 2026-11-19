package top.izuna.foliamajor.player.dsp

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

// android/app/src/test/java/top/izuna/foliamajor/player/dsp/StemWarmPendingTest.kt
// 四轨解码器的「预热账本」：warmPending 只增不删 = 四轨混音永久失效。
//
// 用户的症状：第一首还正常，切到第二首之后「关闭人声 / 只留人声」就再也不生效，
// 听到的一直是原曲 —— 界面显示已就绪、开关开着，声音却没变。
//
// 根因：warmPending 的唯一写入是 requestWarm 的 addAll，全仓没有 remove / clear。
// 第一首预热成功后集合永不清空，切到第二首时 requestWarm 过滤出空集合直接 return，
// 一个解码器都装不上。这一组用例锁住「切歌之后账本清空、能重新提交预热」。
//
// 只走状态机，不进音频线程、不开 MediaCodec：交接由 enqueueHandoffForTest 直接塞。
class StemWarmPendingTest {

    private lateinit var dir: File

    @Before
    fun setUp() {
        dir = File(System.getProperty("java.io.tmpdir"), "stem-warm-test-${System.nanoTime()}")
        dir.mkdirs()
        StemMixState.clear()
    }

    @After
    fun tearDown() {
        StemMixState.clear()
        dir.deleteRecursively()
    }

    private fun stemFiles(song: String): Array<File?> =
        Array(StemKind.ALL.size) { index ->
            File(dir, "$song${StemKind.ALL[index].suffix}").apply { writeBytes(ByteArray(16)) }
        }

    private fun processor(): StemMixProcessor = StemMixProcessor(NativeEqualizerState)

    private fun session(songKey: String, stems: Array<File?>): StemMixSession =
        StemMixSession(songKey, stems)

    // ---- resolve：哪些情况下不该走四轨混音 ----

    @Test
    fun `没开开关时走原曲`() {
        assertEquals(
            StemMixProcessor.PASSTHROUGH_ORIGINAL,
            StemMixProcessor.resolve(mode = null, sampleRate = 44_100, channels = 2),
        )
    }

    @Test
    fun `开了开关且格式对得上才混音`() {
        assertEquals(StemMixProcessor.MIX, StemMixProcessor.resolve(VocalTrackMode.INSTRUMENTAL, 44_100, 2))
        assertEquals(StemMixProcessor.MIX, StemMixProcessor.resolve(VocalTrackMode.VOCAL, 44_100, 2))
    }

    @Test
    fun `采样率或声道数对不上就直通`() {
        assertEquals(
            StemMixProcessor.PASSTHROUGH_RATE,
            StemMixProcessor.resolve(VocalTrackMode.INSTRUMENTAL, 48_000, 2),
        )
        assertEquals(
            StemMixProcessor.PASSTHROUGH_CHANNELS,
            StemMixProcessor.resolve(VocalTrackMode.INSTRUMENTAL, 44_100, 1),
        )
    }

    // ---- 预热账本：换歌之后必须清空 ----

    @Test
    fun `切歌后 warmPending 被清空 能重新提交预热`() {
        val processor = processor()
        val first = session("song-a", stemFiles("a"))
        StemMixState.publishSong(StemSongState("song-a", first.stems, true))

        // 第一首：四轨全部提交预热，账本里是四条。
        processor.requestWarm(first, StemKind.ALL.toSet())
        assertEquals("四轨各提交一次预热", StemKind.ALL.toSet(), processor.warmPending.toSet())

        /*
         * 换歌：releaseDecoders 自增 generation 并清空账本。
         *
         * ★ 这一步就是原来缺的那一条。少了它，账本里那四条永远挂着，下面第二首的
         * requestWarm 会过滤出空集合、直接 return —— 一个解码器都装不上，
         * 四轨混音永久失效、只剩原曲。
         */
        processor.releaseDecoders()
        assertTrue("generation 一抬，在飞的预热全部作废，账本也要一起清空", processor.warmPending.isEmpty())

        // 第二首：账本干净，四条都能重新提交。
        val second = session("song-b", stemFiles("b"))
        StemMixState.publishSong(StemSongState("song-b", second.stems, true))
        processor.requestWarm(second, StemKind.ALL.toSet())
        assertEquals(
            "新歌的四轨都要能重新提交预热",
            StemKind.ALL.toSet(),
            processor.warmPending.toSet(),
        )
    }

    @Test
    fun `open 失败的交接也会把自己从账本里摘掉`() {
        val processor = processor()
        val session = session("song-a", stemFiles("a"))
        StemMixState.publishSong(StemSongState("song-a", session.stems, true))

        // 这一轨 open 失败：预热回来时 decoder 为 null。不摘账的话它会被永远当成
        // 「还在预热中」，这首歌之后的 open 全被它挡住。
        processor.enqueueHandoffForTest(
            StemMixProcessor.StemHandoff(
                generation = processor.openGenerationForTest(),
                songKey = "song-a",
                kind = StemKind.VOCALS,
                decoder = null,
                baseFrames = 0L,
            ),
        )
        processor.installHandedOffDecoders(session)

        assertTrue("open 失败也必须摘账", processor.warmPending.isEmpty())
        assertEquals("失败的那一轨不应该装上解码器", 0, processor.installedDecoderCount())
    }

    @Test
    fun `过期 generation 的交接不会装上 但会摘账`() {
        val processor = processor()
        val session = session("song-a", stemFiles("a"))
        StemMixState.publishSong(StemSongState("song-a", session.stems, true))
        processor.markWarmPendingForTest(setOf(StemKind.DRUMS))

        processor.enqueueHandoffForTest(
            StemMixProcessor.StemHandoff(
                // 比当前 generation 旧一截：这条预热是换歌 / seek 之前提交的。
                generation = processor.openGenerationForTest() - 1,
                songKey = "song-a",
                kind = StemKind.DRUMS,
                decoder = null,
                baseFrames = 0L,
            ),
        )
        processor.installHandedOffDecoders(session)

        assertTrue("过期交接同样要摘账，否则这一轨永远排不进新的预热", processor.warmPending.isEmpty())
        assertEquals(0, processor.installedDecoderCount())
    }

    @Test
    fun `别的歌的交接不会装到这一首上`() {
        val processor = processor()
        val session = session("song-a", stemFiles("a"))
        StemMixState.publishSong(StemSongState("song-a", session.stems, true))
        processor.markWarmPendingForTest(setOf(StemKind.BASS))

        processor.enqueueHandoffForTest(
            StemMixProcessor.StemHandoff(
                generation = processor.openGenerationForTest(),
                songKey = "song-b",
                kind = StemKind.BASS,
                decoder = null,
                baseFrames = 0L,
            ),
        )
        processor.installHandedOffDecoders(session)

        assertTrue("歌不符的交接要摘账", processor.warmPending.isEmpty())
        assertFalse("别的歌的轨道绝不能挂到这一首上", processor.hasDecoder(StemKind.BASS))
    }

    // ---- 会话快照 ----

    @Test
    fun `没有四轨的会话不该出现在快照里`() {
        assertNull("没发布四轨时快照为空，处理器原样直通", StemMixState.snapshot())

        val session = session("song-a", stemFiles("a"))
        StemMixState.publishSong(StemSongState("song-a", session.stems, ready = false))
        assertNull("四轨没齐时同样直通", StemMixState.snapshot())

        StemMixState.publishSong(StemSongState("song-a", session.stems, ready = true))
        assertEquals("song-a", StemMixState.snapshot()?.songKey)
    }

    @Test
    fun `换歌会重置 seek 位置`() {
        val a = session("song-a", stemFiles("a"))
        // 先发布 A：publishSong 在「上一首是空」时也会清一次 seek，所以这一下必须在 seek 之前。
        StemMixState.publishSong(StemSongState("song-a", a.stems, ready = true))

        StemMixState.requestSeek(44_100L * 10)
        assertTrue(StemMixState.hasPendingSeek())

        // 同一首歌重新装源（恢复进度、切画质）：待处理的 seek 不该被吃掉。
        StemMixState.publishSong(StemSongState("song-a", a.stems, ready = true))
        assertTrue("同一首歌重新装源不该吃掉待处理的 seek", StemMixState.hasPendingSeek())

        val b = session("song-b", stemFiles("b"))
        StemMixState.publishSong(StemSongState("song-b", b.stems, ready = true))
        assertFalse("换歌必须丢掉上一首的 seek 位置，否则新歌整首错位", StemMixState.hasPendingSeek())
    }
}
