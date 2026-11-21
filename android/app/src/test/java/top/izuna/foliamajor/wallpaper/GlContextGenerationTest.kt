package top.izuna.foliamajor.wallpaper

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// GL 上下文代次与缓存有效性（#M6）。纯 JVM —— 不建 GL 上下文，只钉住判定。

class GlContextGenerationTest {

    // ---------- 是不是新上下文 ----------

    @Test
    fun `第一次 onSurfaceCreated 就算新上下文`() {
        // 初始态（NO_GENERATION）本来就什么都没有，所有缓存都必须失效。
        assertTrue(GlContextGeneration.startsNewGeneration(
                GlContextGeneration.NO_GENERATION, 1L))
    }

    @Test
    fun `代次变了就是新上下文`() {
        assertTrue(GlContextGeneration.startsNewGeneration(1L, 2L))
        assertTrue(GlContextGeneration.startsNewGeneration(7L, 8L))
    }

    @Test
    fun `代次没变不是新上下文`() {
        // 这条只会在「有人忘了加代次」时出现，onSurfaceCreated 里按保守分支处理。
        assertFalse(GlContextGeneration.startsNewGeneration(3L, 3L))
    }

    // ---------- 缓存还能不能用 ----------

    @Test
    fun `跨代缓存一律不许命中`() {
        /*
         * 这就是 #M6 的核心：上下文重建而字体不变时，以前 textureFor 会命中旧 LRU
         * 并返回一个在新上下文里非法（或已被复用）的 textureId。
         */
        assertFalse(GlContextGeneration.isCacheUsable(cachedGeneration = 1L, currentGeneration = 2L))
        assertFalse(GlContextGeneration.isCacheUsable(cachedGeneration = 5L, currentGeneration = 6L))
    }

    @Test
    fun `同一代缓存可以命中`() {
        assertTrue(GlContextGeneration.isCacheUsable(cachedGeneration = 2L, currentGeneration = 2L))
    }

    @Test
    fun `没有代次时的缓存不算可用`() {
        // 「还没渲染过任何一帧」的初值不能当成有效代次，否则第一帧就会命中一张空表之外的假值。
        assertFalse(GlContextGeneration.isCacheUsable(
                GlContextGeneration.NO_GENERATION, GlContextGeneration.NO_GENERATION))
    }
}
