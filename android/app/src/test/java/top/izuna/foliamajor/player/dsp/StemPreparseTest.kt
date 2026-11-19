package top.izuna.foliamajor.player.dsp

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

// android/app/src/test/java/top/izuna/foliamajor/player/dsp/StemPreparseTest.kt
// 「整队预拆」的排队规则：同一首不重复排、正在播的那首不排、已经拆好的不排。
//
// 排错的代价是流量和电量（一整队几百首歌各跑一遍几十秒的推理），排漏的代价是
// 用户拨开关要等 —— 两头都是用户能直接感觉到的事，所以这几条单独锁住。
class StemPreparseTest {

    private fun request(key: String): StemPreparse.Request =
        StemPreparse.Request(url = "https://example.com/$key.m4a", songKey = "song:$key", key = key)

    @Before
    @After
    fun reset() {
        StemPreparse.reset()
    }

    @Test
    fun `同一首歌排两次只接一次`() {
        val first = StemPreparse.plan(listOf(request("a"), request("b")))
        assertEquals(listOf("a", "b"), first.map { it.key })

        val again = StemPreparse.plan(listOf(request("a"), request("b"), request("c")))
        assertEquals("排过的 key 不再排，新来的照排", listOf("c"), again.map { it.key })
    }

    @Test
    fun `跳过正在播的那首`() {
        val accepted = StemPreparse.plan(
            listOf(request("now"), request("next")),
            skip = setOf("now"),
        )
        assertEquals("正在播的那首由装源时的 prebuild 负责，这里不排", listOf("next"), accepted.map { it.key })
        assertFalse("被跳过的不记账，换掉当前曲目后还能再排", StemPreparse.enqueuedKeys().contains("now"))
    }

    @Test
    fun `已经拆好的不排`() {
        val accepted = StemPreparse.plan(
            listOf(request("done"), request("todo")),
            ready = { it == "done" },
        )
        assertEquals(listOf("todo"), accepted.map { it.key })
    }

    @Test
    fun `空地址直接丢掉`() {
        val accepted = StemPreparse.plan(
            listOf(StemPreparse.Request(url = "", songKey = null, key = "empty")),
        )
        assertTrue(accepted.isEmpty())
    }

    @Test
    fun `失败之后可以重排`() {
        StemPreparse.plan(listOf(request("a")))
        StemPreparse.forget("a")
        assertEquals(listOf("a"), StemPreparse.plan(listOf(request("a"))).map { it.key })
    }
}
