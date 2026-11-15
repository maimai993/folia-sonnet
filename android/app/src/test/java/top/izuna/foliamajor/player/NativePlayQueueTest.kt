package top.izuna.foliamajor.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// android/app/src/test/java/top/izuna/foliamajor/player/NativePlayQueueTest.kt
// 原生队列状态机的行为。这里不碰 ExoPlayer，也不碰 org.json（JVM 单测里它是空壳），
// 只测「放完之后往哪走」这一件事 —— 前台冻结时能不能自己往下跑，全看它。

class NativePlayQueueTest {

    private fun entry(key: String) = NativeQueueEntry(
        songKey = key,
        providerId = "netease",
        songId = key,
        mid = "",
        hash = "",
        albumAudioId = "",
        url = "https://example.test/$key.mp3",
        title = key,
        artist = "",
        album = "",
        coverUrl = "",
        durationSec = 100.0,
    )

    private fun queue(vararg keys: String, start: Int = 0) = NativePlayQueue().apply {
        replace(keys.map(::entry), start)
    }

    // ---------- 顺序播放 ----------

    @Test
    fun `顺序播放走到最后一首就停`() {
        val q = queue("a", "b")
        assertEquals("b", q.onFinished()?.songKey)
        assertNull(q.onFinished())
    }

    @Test
    fun `顺序播放按下一首越过队尾返回当前这一首`() {
        // 手按不该让队列变成「没有当前曲目」—— 停在原地，界面才稳。
        val q = queue("a", "b", start = 1)
        assertEquals("b", q.onSkip(+1)?.songKey)
    }

    // ---------- 列表循环 ----------

    @Test
    fun `列表循环放完最后一首绕回第一首`() {
        val q = queue("a", "b").apply { setLoopMode(NativeLoopMode.ALL) }
        assertEquals("b", q.onFinished()?.songKey)
        assertEquals("a", q.onFinished()?.songKey)
    }

    @Test
    fun `列表循环按上一首从队首绕到队尾`() {
        val q = queue("a", "b", "c").apply { setLoopMode(NativeLoopMode.ALL) }
        assertEquals("c", q.onSkip(-1)?.songKey)
    }

    // ---------- 单曲循环 ----------

    @Test
    fun `单曲循环放完还是这一首`() {
        // 原来这里被当成「没有下一首」，于是无缝重播之后没人 reset 位置，进度条冻在末尾。
        val q = queue("a", "b").apply { setLoopMode(NativeLoopMode.ONE) }
        assertEquals("a", q.onFinished()?.songKey)
        assertEquals("a", q.onFinished()?.songKey)
        assertEquals(0, q.currentIndex())
    }

    @Test
    fun `单曲循环下手按下一首仍然真的换歌`() {
        // 手按没反应是最容易被当成「坏了」的，所以 onSkip 故意不认单曲循环。
        val q = queue("a", "b").apply { setLoopMode(NativeLoopMode.ONE) }
        assertEquals("b", q.onSkip(+1)?.songKey)
    }

    // ---------- 随机 ----------

    @Test
    fun `随机播放不会连着落到同一首`() {
        val q = queue("a", "b", "c").apply {
            setLoopMode(NativeLoopMode.ALL)
            setShuffle(true)
        }
        repeat(20) {
            val before = q.currentIndex()
            val picked = q.onFinished() ?: error("随机不该返回 null")
            assertEquals("随机不该选中当前这一格", false, q.currentIndex() == before)
            assert(picked.songKey.isNotEmpty())
        }
    }

    // ---------- 换队列 ----------

    @Test
    fun `换队列整份替换并重置下标`() {
        val q = queue("a", "b", "c", start = 2)
        q.replace(listOf(entry("x"), entry("y")), 0)
        assertEquals(2, q.size())
        assertEquals("x", q.current()?.songKey)
    }

    @Test
    fun `换队列时越界的起始下标夹到范围内`() {
        val q = NativePlayQueue()
        q.replace(listOf(entry("x"), entry("y")), 9)
        assertEquals(1, q.currentIndex())
    }

    @Test
    fun `清空队列之后没有当前曲目`() {
        val q = queue("a")
        q.replace(emptyList(), 0)
        assertEquals(-1, q.currentIndex())
        assertNull(q.current())
        assertNull(q.onFinished())
    }

    // ---------- 原地同步（插歌 / 删歌）----------

    @Test
    fun `原地同步之后下标仍指向同一首歌`() {
        val q = queue("a", "b", "c", start = 1)
        // 在队首插一首：如果只保下标，当前曲目会从 b 变成 a。
        q.syncEntries(listOf(entry("z"), entry("a"), entry("b"), entry("c")))
        assertEquals("b", q.current()?.songKey)
    }

    @Test
    fun `原地同步时当前曲目被删掉则下标夹回范围内`() {
        val q = queue("a", "b", start = 1)
        q.syncEntries(listOf(entry("a")))
        assertEquals("a", q.current()?.songKey)
    }

    // ---- 字段名兼容（两套命名并存，见 fromJson 的注释） ----

    /** Web 推的镜像条目（buildQueueMirrorEntry 的字段名）。 */
    private fun webMirrorJson(key: String): String = """
        {"songKey":"$key","providerId":"qq","serverSongId":"123","providerMid":"mid$key",
         "providerHash":"","providerAlbumAudioId":"","title":"歌 $key","artist":"歌手",
         "album":"专辑","artworkUrl":"https://e.test/$key.jpg","durationMs":210000,
         "liked":false,"canLike":true}
    """.trimIndent()

    @Test
    fun `Web 镜像字段名解析出完整身份`() {
        val q = NativePlayQueue().apply {
            replace(listOf(
                NativeQueueEntry.fromJson(org.json.JSONObject(webMirrorJson("a"))),
                NativeQueueEntry.fromJson(org.json.JSONObject(webMirrorJson("b"))),
            ), 0)
        }
        val a = q.all()[0]
        assertEquals("123", a.songId)
        assertEquals("mida", a.mid)
        assertEquals("歌 a", a.title)
        assertEquals("https://e.test/a.jpg", a.coverUrl)
        assertEquals(210.0, a.durationSec, 0.001)
    }

    @Test
    fun `Web 镜像喂进来的条目 roundtrip 后两套字段名都有值`() {
        val q = NativePlayQueue().apply {
            replace(listOf(NativeQueueEntry.fromJson(org.json.JSONObject(webMirrorJson("a")))), 0)
        }
        val out = q.current()!!.toJson()
        // 服务的旧读取点（resolveMirrorEntryAsync / fetchLyricForNativePlayback）
        // 读的是 serverSongId / providerMid 这一族：丢了它们自动下一首解析不出地址。
        assertEquals("123", out.optString("serverSongId"))
        assertEquals("mida", out.optString("providerMid"))
        assertEquals(210000L.toDouble(), out.optDouble("durationMs", 0.0), 0.001)
    }

    @Test
    fun `状态机自己的字段名照常解析`() {
        val json = NativeQueueEntry(
            songKey = "a", providerId = "netease", songId = "n1", mid = "", hash = "",
            albumAudioId = "", url = "https://e.test/a.mp3", title = "A", artist = "",
            album = "", coverUrl = "", durationSec = 60.0,
        ).toJson()
        val back = NativeQueueEntry.fromJson(json)
        assertEquals("n1", back.songId)
        assertEquals("https://e.test/a.mp3", back.url)
        assertEquals(60.0, back.durationSec, 0.001)
    }
}
