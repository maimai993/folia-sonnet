package top.izuna.foliamajor.player.dsp

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/StemPreparse.kt
// 「整队预拆」的排队：把接下来要放的几首攒成一条队列，逐首拆四轨。
//
// 为什么要有它：一次 SCNet 分离几十秒，用户点「下一首」时才开始拆，拨开关就要等。
// 于是播放器把队列里接下来几首一次性交过来，这里只负责「按顺序、同一时刻只拆一首、
// 已经在拆 / 已经拆好的不重复排」，真正的推理仍然由 InstrumentalCoordinator 跑。
//
// 不排正在播的那首（由装源时的 prebuild 负责），也不排已经排过的 —— 队列每换一次
// （切歌、拖队列）都会重排一遍，去重靠 [enqueued] 这张集合。

internal object StemPreparse {

    /** 一条待拆的活。[key] 是缓存键（InstrumentalStore.keyFor 的产物）。 */
    data class Request(val url: String, val songKey: String?, val key: String)

    /** 已经排过 / 拆过的键。同一首歌在同一个队列里去重，避免重复排一轮推理。 */
    private val enqueued = HashSet<String>()

    /**
     * 把一批歌排进队列，返回这一批里**新排进来**的键（按传入顺序）。
     *
     * @param skip      不排的键（正在播的那首）。
     * @param ready     判断「这首已经拆好了」，已拆好的直接记为完成、不再排。
     */
    @Synchronized
    fun plan(
        requests: List<Request>,
        skip: Set<String> = emptySet(),
        ready: (String) -> Boolean = { false },
    ): List<Request> {
        val accepted = ArrayList<Request>(requests.size)
        for (request in requests) {
            if (request.url.isBlank()) continue
            if (request.key in skip) continue
            if (!enqueued.add(request.key)) continue
            if (ready(request.key)) continue
            accepted.add(request)
        }
        return accepted
    }

    /** 换歌 / 队列被整体替换：忘掉排过的记号，让新队列重新排。 */
    @Synchronized
    fun reset() {
        enqueued.clear()
    }

    /** 某一首的拆分失败了：把它从记号里摘掉，允许下一轮重试。 */
    @Synchronized
    fun forget(key: String) {
        enqueued.remove(key)
    }

    /** 测试用：当前记着的键。 */
    @Synchronized
    fun enqueuedKeys(): Set<String> = enqueued.toSet()
}
