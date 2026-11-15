package top.izuna.foliamajor.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// android/app/src/test/java/top/izuna/foliamajor/player/NativeMirrorGuardTest.kt
// 原生媒体身份对 metadata 写入与队列游标的准入规则（#106）。纯 JVM，不碰服务 / 播放器。

class NativeMirrorGuardTest {

    // ---------- metadata 准入 ----------

    @Test
    fun `引擎有身份时对不上的 metadata 一律拒绝`() {
        assertTrue(NativeMirrorGuard.rejectsMetadata("a", "b"))
        assertTrue(NativeMirrorGuard.rejectsMetadata("a", "a2"))
    }

    @Test
    fun `引擎同一首或没有身份时不拒绝`() {
        assertFalse(NativeMirrorGuard.rejectsMetadata("a", "a"))
        assertFalse(NativeMirrorGuard.rejectsMetadata("", "b"))
        assertFalse(NativeMirrorGuard.rejectsMetadata(null, "b"))
        assertTrue(NativeMirrorGuard.rejectsMetadata("a", null))
        assertTrue(NativeMirrorGuard.rejectsMetadata("a", ""))
    }

    // ---------- 队列镜像的游标 ----------

    @Test
    fun `原生有身份时按原生 key 定位而不是旧下标`() {
        val keys = listOf("a", "b", "c")
        assertEquals(1, NativeMirrorGuard.mirrorIndex(keys, "b", true, 0))
    }

    @Test
    fun `原生身份不在新队列里就不动游标`() {
        assertEquals(-1, NativeMirrorGuard.mirrorIndex(listOf("a", "b"), "x", true, 0))
    }

    @Test
    fun `没有原生身份时才用前台推来的下标`() {
        assertEquals(2, NativeMirrorGuard.mirrorIndex(listOf("a", "b", "c"), "", false, 2))
        assertEquals(-1, NativeMirrorGuard.mirrorIndex(listOf("a", "b"), "", false, 5))
    }

    @Test
    fun `原生有身份时前台旧游标不算数`() {
        assertFalse(NativeMirrorGuard.acceptsQueueIndex(true))
        assertTrue(NativeMirrorGuard.acceptsQueueIndex(false))
    }

    @Test
    fun `空 key 定位不到任何一格`() {
        assertEquals(-1, NativeMirrorGuard.indexOf(listOf("a", "b"), ""))
        assertEquals(-1, NativeMirrorGuard.indexOf(listOf("a", "b"), null))
    }
}
