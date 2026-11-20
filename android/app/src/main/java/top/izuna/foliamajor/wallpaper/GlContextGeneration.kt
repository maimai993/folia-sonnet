package top.izuna.foliamajor.wallpaper

// 当前文件：GL 上下文代次与「缓存还能不能用」的判定（#M6），纯 JVM 可测。

/**
 * 渲染器持有的那些 **GL 对象**（纹理、buffer、program）都属于某一次 GL 上下文。
 *
 * 上下文一旦被重建（显存压力、驱动重置、引擎销毁重建、切换壁纸），旧 id 在新上下文里
 * 一律非法；`glBindTexture` 对非法 id 不报错、日志里一点痕迹都没有，表现出来的只是
 * 「歌词整行不显示」或者「采样到别的行 / 别的图」（#M6 影响 1、2）。
 *
 * 判据必须是**上下文代次变了**，而不是「字体变没变」—— 字体只是个巧合：以前只有
 * `syncFont` 会清文本纹理，于是字体不变时 `onSurfaceCreated` 重建了上下文，
 * 文本纹理却还留着，`textureFor` 直接命中旧 LRU。
 */
object GlContextGeneration {

    /** 还没经过任何一次 `onSurfaceCreated`。 */
    const val NO_GENERATION: Long = 0L

    /**
     * 这一次 `onSurfaceCreated` 相对上一次：
     * 返回 true 表示「这是新上下文」，所有 GL 对象必须失效。
     *
     * 第一次创建（[previous] 为 [NO_GENERATION]）也算新上下文 —— 初始状态同样是「什么都没有」。
     */
    fun startsNewGeneration(previous: Long, current: Long): Boolean =
        previous == NO_GENERATION || current != previous

    /**
     * 代次变化时，一个**缓存的 GL 对象引用**还能不能用。
     *
     * 答案恒为「不能」：这正是 #M6 的核心。之所以写成函数而不是直接返回 false，
     * 是为了让调用点（以及读代码的人）没法把它和「字体变了才失效」混为一谈。
     */
    fun isCacheUsable(cachedGeneration: Long, currentGeneration: Long): Boolean =
        cachedGeneration == currentGeneration && currentGeneration != NO_GENERATION
}
