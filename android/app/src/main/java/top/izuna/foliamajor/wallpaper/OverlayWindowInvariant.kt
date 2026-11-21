package top.izuna.foliamajor.wallpaper

// 当前文件：叠层窗口「挂上了没有」的内部不变量与回滚判定（#M5），纯 JVM 可测。

/**
 * [WallpaperOverlay] 的窗口不变量（#M5）。
 *
 * 叠层有两个字段回答「窗口现在挂着吗」：`webView`（窗口视图）与 `added`（有没有真的 addView 过）。
 * 以前它们各自维护，`attach()` 的失败分支只把 `webView` 置 null，于是出现了
 * `added == true && webView == null` 这个组合 —— 而 `detach()` 以 `webView == null`
 * 作为提前返回条件，从那一刻起该实例**永久无法收摊**：窗口与 WebView 都留在 WindowManager 上，
 * 页面继续在后台跑 rAF（issue 影响 1），只能靠杀进程收掉。
 *
 * 把「两者必须一致」写成一处判定，attach / detach 都从这里过，就不会再各自走偏。
 * 这里只做判定、不改字段：判错时由调用方修，而不是让校验本身把叠层打崩。
 */
object OverlayWindowInvariant {

    /** 两个字段是否落在合法组合上（只允许 false/false 与 true/true）。 */
    fun isConsistent(added: Boolean, hasView: Boolean): Boolean = added == hasView

    /** 窗口此刻是否挂着。调用方必须先确认 [isConsistent]。 */
    fun isAttached(added: Boolean, hasView: Boolean): Boolean = added && hasView

    /**
     * `addView` 之后某一步初始化失败，要不要回滚。
     *
     * 判据只有一条：**窗口已经真的挂上了**。挂上了就必须回滚
     * （removeView + destroy + added=false），只置空引用会留下孤儿；
     * 还没挂上（addView 自己就抛了）则只需销毁这份 WebView。
     */
    fun needsRollback(windowAdded: Boolean): Boolean = windowAdded

    /**
     * 回滚之后的状态：`added == false` 且没有视图引用。
     *
     * 返回 [added, hasView] 而不是直接改字段，是为了让单测能钉住这两个值的组合。
     */
    fun afterRollback(): Pair<Boolean, Boolean> = false to false

    /** 挂载成功之后的状态。与 [afterRollback] 一起把两个合法组合钉死。 */
    fun afterAttach(): Pair<Boolean, Boolean> = true to true
}
