package top.izuna.foliamajor.player

// 原生显示校准的采样 epoch：控制命令照原队列执行，仅阻止跨越控制动作的旧位置采样（#264）。
internal class DisplayAnchorGeneration {
    private var epoch = 0L
    private var pending = 0
    private var closed = false

    @Synchronized
    fun begin() {
        epoch++
        pending++
    }

    /** 每个已受理控制动作在 finally 配对结束；执行期间捕获的采样也必须失效。 */
    @Synchronized
    fun finish() {
        check(pending > 0) { "Display anchor control finished without begin" }
        pending--
        epoch++
    }

    /** release 后永久拒绝采样，未执行的队列或迟到的 finish 都不能重新开放。 */
    @Synchronized
    fun close() {
        closed = true
        epoch++
    }

    @Synchronized
    fun capture(): Long = epoch

    /** 校验和写锚点作为一个临界区，避免检查通过后才受理下一条控制命令。 */
    @Synchronized
    fun ifCurrent(generation: Long, action: () -> Unit) {
        if (!closed && pending == 0 && generation == epoch) action()
    }
}
