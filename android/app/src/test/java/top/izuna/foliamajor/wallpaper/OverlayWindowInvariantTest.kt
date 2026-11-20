package top.izuna.foliamajor.wallpaper

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// 叠层窗口的内部不变量与回滚判定（#M5）。纯 JVM，不碰 WebView / WindowManager。

class OverlayWindowInvariantTest {

    // ---------- 不变量：added 与「有没有视图」只允许同真同假 ----------

    @Test
    fun `没挂上时两个字段都是假的`() {
        assertTrue(OverlayWindowInvariant.isConsistent(added = false, hasView = false))
        assertFalse(OverlayWindowInvariant.isAttached(added = false, hasView = false))
    }

    @Test
    fun `挂上时两个字段都是真的`() {
        assertTrue(OverlayWindowInvariant.isConsistent(added = true, hasView = true))
        assertTrue(OverlayWindowInvariant.isAttached(added = true, hasView = true))
    }

    @Test
    fun `added 为真而视图为空是不合法的组合`() {
        // 这正是 issue 里那个「永久孤儿」的状态：detach 以 webView == null 提前返回，
        // 于是 added 永远清不掉，窗口与 WebView 一直挂在 WindowManager 上。
        assertFalse(OverlayWindowInvariant.isConsistent(added = true, hasView = false))
    }

    @Test
    fun `视图还在而 added 为假同样不合法`() {
        // 反向错位：窗口可能已经被系统摘掉、视图却还持有。同样是 detach 会走错分支的组合。
        assertFalse(OverlayWindowInvariant.isConsistent(added = false, hasView = true))
    }

    // ---------- 回滚 ----------

    @Test
    fun `窗口已挂上时初始化失败必须回滚`() {
        assertTrue(OverlayWindowInvariant.needsRollback(windowAdded = true))
    }

    @Test
    fun `addView 自己就失败时不需要回滚只需要销毁`() {
        // 窗口根本没挂上，removeView 无从谈起；这一条由 attach 里那条分支销毁 WebView。
        assertFalse(OverlayWindowInvariant.needsRollback(windowAdded = false))
    }

    @Test
    fun `回滚之后两个字段一起回到假`() {
        val (added, hasView) = OverlayWindowInvariant.afterRollback()
        assertFalse(added)
        assertFalse(hasView)
        assertTrue(OverlayWindowInvariant.isConsistent(added, hasView))
        assertFalse(OverlayWindowInvariant.isAttached(added, hasView))
    }

    @Test
    fun `挂载成功之后两个字段一起变成真`() {
        val (added, hasView) = OverlayWindowInvariant.afterAttach()
        assertTrue(added)
        assertTrue(hasView)
        assertTrue(OverlayWindowInvariant.isConsistent(added, hasView))
        assertTrue(OverlayWindowInvariant.isAttached(added, hasView))
    }

    @Test
    fun `两个终态都在合法组合之内`() {
        // 回滚与挂载成功是仅有的两个出口：任何一条路径走完都必须落在这两个之一，
        // 不允许出现「只改了其中一个字段」的第三个状态。
        val states = listOf(OverlayWindowInvariant.afterRollback(), OverlayWindowInvariant.afterAttach())
        for (state in states) {
            assertTrue("state=$state", OverlayWindowInvariant.isConsistent(state.first, state.second))
        }
    }

    // ---------- 注入一次「schedulePush 抛异常」之后的期望 ----------

    @Test
    fun `schedulePush 在 addView 之后抛异常时按回滚收尾`() {
        // issue 的验收标准：调用后 added == false（也就是窗口数该减一）。
        // attach 里那条 catch 分支先判 needsRollback(windowAdded = true) = true，
        // 然后落到 afterRollback()；这里把那条判定链完整跑一遍。
        val windowAdded = true
        assertTrue(OverlayWindowInvariant.needsRollback(windowAdded))
        val (added, hasView) = OverlayWindowInvariant.afterRollback()
        assertFalse("回滚之后 added 必须为 false，否则 detach 再也收不掉这一层", added)
        assertFalse(hasView)
    }
}
