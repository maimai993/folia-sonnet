package top.izuna.foliamajor.player

import android.util.Log
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadFactory
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * 原生侧唯一的一条「后台干杂活」通道。
 *
 * 这里放的是**一次性、IO 等待型**的任务：解析播放地址、预取下一首、拉歌词、下载封面、
 * 校验收藏状态。它们原来都是直接 `Thread({ ... }).start()`，一单一颗线程 —— 切十首歌
 * 就是十几颗线程起落，每颗都要各自命名、各自面对异常。
 *
 * 换成固定大小线程池，收益有三条，都不是"看起来更整齐"：
 *
 * 1. **异常有边界。** 裸线程里抛出的未捕获异常会走 `Thread.getDefaultUncaughtExceptionHandler`，
 *    在 Android 上就是**整个进程被杀**。而这些代码里跑的是网络与 JSON 解析，
 *    一次超时后的空指针不该由它决定 App 的生死 —— 现在会被记下来，播放继续。
 *
 * 2. **线程数有上限。** 原来的写法没有上限：一次预取 20 首就是 20 颗线程同时打网关。
 *    现在无论多少任务，最多 [POOL_SIZE] 颗。
 *
 * 3. **空闲会退出。** [IDLE_SECONDS] 秒没有任务，线程全部回收（`allowCoreThreadTimeOut`），
 *    后台待机时不占调度额度 —— 这条对耗电是实打实的。
 *
 * ⚠️ 别把**必须按顺序执行**或**长时间阻塞**（读大文件、等 socket 死循环）的活放进来：
 * 池只有 [POOL_SIZE] 颗线程，一颗被长期占住，其它任务就得排队。播放器自己的线程
 * （`FoliaNativePlayer` 的 playerLooper）也不在这里，那条线必须独占。
 *
 * 为什么不用协程：这个模块没有 coroutines 依赖，引入它会把 13 个调用点全部改成 suspend
 * 传染的写法，一次动这么多地方的风险大于收益。要解决的问题只是"线程数量 + 异常边界"，
 * 线程池已经够了。
 */
object BackgroundWork {

    private const val TAG = "FoliaBackgroundWork"

    /**
     * 三颗。够用的依据是这些任务的性质：全是等网络，CPU 占用可以忽略。
     * 同时最多会发生的组合是「解析地址 + 预取 + 拉歌词/封面」，3 颗正好覆盖。
     */
    private const val POOL_SIZE = 3

    /** 空闲多久回收线程。30 秒：切歌间隙不会反复建线程，真正待机时又能全放掉。 */
    private const val IDLE_SECONDS = 30L

    private val counter = AtomicInteger(1)

    /**
     * 造一个池。
     *
     * @param size 并发上限。**必须给上限** —— 这批线程以前之所以是「一任务一颗」，
     *             就是因为没有地方限制：一次预取 20 首会同时打 20 个请求出去。
     * @param prefix 线程名前缀，崩溃栈里要能一眼认出来源。
     */
    private fun newPool(size: Int, prefix: String): ThreadPoolExecutor {
        return ThreadPoolExecutor(
            size,
            size,
            IDLE_SECONDS,
            TimeUnit.SECONDS,
            // 无界队列：宁可排队，也绝不在调用方线程上跑或抛拒绝异常 ——
            // 调用方常常是主线程（服务的 onStartCommand），那里既不能阻塞也不能崩。
            LinkedBlockingQueue(),
            ThreadFactory { runnable ->
                Thread(runnable, prefix + counter.getAndIncrement()).apply {
                    // 守护：进程该退的时候不要被这几颗线程拖住。
                    isDaemon = true
                    // 比主线程低一档：这些活再急也不该和渲染、音频抢 CPU。
                    priority = Thread.NORM_PRIORITY - 1
                }
            },
        ).apply {
            allowCoreThreadTimeOut(true)
        }
    }

    /** 播放关键路径：解析地址、拉歌词、下载封面、校验收藏。 */
    private val executor = newPool(POOL_SIZE, "folia-io-")

    /**
     * 重活：导入本地文件、把音频写进缓存、跑一次 AI 请求。
     *
     * 单独一条通道的理由是**隔离**：一次导入可能是上百个文件，占住一颗线程几十秒。
     * 和播放关键路径挤在同一个池里，那几十秒里所有「下一首解析地址」都要排在它后面 ——
     * 表现就是「导入歌的时候切歌要等」。
     */
    private val bulkExecutor = newPool(2, "folia-bulk-")

    /**
     * 丢一个任务进去。
     *
     * @param name 只用于日志：出错时能看出是"哪一路"挂的（`resolve-url` / `lyric` / `artwork`…）。
     *             不要拼进歌名之类的动态内容，否则日志无法聚合。
     */
    fun io(name: String, block: () -> Unit) {
        submit(executor, name, block)
    }

    /**
     * 重活通道：导入、缓存写入、AI 请求。与 [io] 分开排队，互不阻塞。
     */
    fun bulk(name: String, block: () -> Unit) {
        submit(bulkExecutor, name, block)
    }

    private fun submit(pool: ThreadPoolExecutor, name: String, block: () -> Unit) {
        pool.execute {
            try {
                block()
            } catch (error: Throwable) {
                /*
                 * 吞掉并记录，**不往上抛**。
                 *
                 * 这里每一个任务都是「某一首歌的某一步」：解析地址失败有 onMirrorEntryFailed
                 * 兜底、封面失败就先用上一张、歌词失败就等下次。没有哪一步值得让进程退出。
                 *
                 * 捕获 Throwable 而不是 Exception：OOM 与 StackOverflow 在这里同样只应该
                 * 让这一首歌失败 —— 它们发生在图片解码这种地方，不是不可恢复的全局状态。
                 */
                Log.e(TAG, "background task failed: " + name, error)
            }
        }
    }

    /** 诊断用：两条通道各有多少线程、各排了多少任务。 */
    fun describe(): String {
        return "io(threads=" + executor.poolSize + " active=" + executor.activeCount +
                " queued=" + executor.queue.size + ") bulk(threads=" + bulkExecutor.poolSize +
                " active=" + bulkExecutor.activeCount + " queued=" + bulkExecutor.queue.size + ")"
    }
}
