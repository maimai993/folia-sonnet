package top.izuna.foliamajor.automix

import android.os.Process
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.min
import top.izuna.foliamajor.FoliaPlaybackService

/**
 * 分析任务的让路。
 *
 * 为什么需要它：解码、mel、ONNX 推理都是「一直有活就占满一个核」的循环，
 * 而手机上退到后台并不等于没有别的事要做 —— 音频解码、通知栏刷新、
 * 以及用户正在用的另一个 App，都在同一批核上抢时间片。用户看到的就是
 * 「歌在后台放着，手机卡」。
 *
 * 这里做两件事，都只在后台生效，前台一点不慢：
 *
 *   1. 把分析线程的调度优先级降到 `THREAD_PRIORITY_BACKGROUND`。安卓的调度器
 *      按优先级分配时间片，-10 的线程会明显让给前台 App 与音频线程。
 *   2. 在解码 / mel / 推理的分块之间主动 sleep 一小段。推理是成块的，
 *      块与块之间本来就要换数据，插一次 sleep 不改变结果，只是把 CPU 空出来。
 *
 * 后台不做的是「暂停」：用户切走时分析照常往前走，回来就有结果 —— 只是走得慢些。
 */
internal object AutomixLoad {

    private const val TAG = "AutomixLoad"

    /** 后台时每个分块之间让出的时间。一块推理通常 0.5~2 秒，这点延迟看不出来。 */
    private const val BACKGROUND_SLEEP_MS = 60L

    /**
     * 正在放歌时，单个推理窗口让出去的上限。
     *
     * 一个 11 秒窗口的推理手机上要好几秒，按占比让出去就够了，上限只是防尾值：
     * 真遇到极快的设备，按比例算出来的让路时间也不会没边地涨。
     */
    private const val PLAYING_SLEEP_MAX_MS = 2500L

    /** 播放器此刻是否在出声。由 FoliaNativePlayerPlugin 的播放状态事件翻转，分析线程只读。 */
    @Volatile var playbackAudible = false

    /** 正在跑的分离任务数（ScnetRunner.separate 进出各记一次）。两个任务同时跑时让路要更狠。 */
    private val activeRuns = AtomicInteger(0)

    /** 一个分离任务开始 / 结束。配对调用（finally 里收尾），计数错了只是让路比例偏一点。 */
    fun beginSeparation() {
        activeRuns.incrementAndGet()
    }

    fun endSeparation() {
        activeRuns.decrementAndGet()
    }

    /** 当前线程上一次设置的优先级；`Int.MIN_VALUE` 表示还没设置过。 */
    private var appliedPriority = Int.MIN_VALUE

    /** 上一次让路的时刻（`elapsedRealtime`），用来估这一段的实际耗时。 */
    private var lastYieldAt = 0L

    /**
     * App 是否在后台。
     *
     * 直接读播放服务上的那个标记：它在 `MainActivity.onStart/onStop` 里改，
     * 与「画面还在不在」是同一份判断（`FoliaPlaybackService.appUiVisible`），
     * 不另起一套，免得两处对不上。
     */
    val inBackground: Boolean
        get() = runCatching { !FoliaPlaybackService.appUiVisible }.getOrDefault(false)

    /** 按当前前后台与播放状态调整本线程的调度优先级。同一状态重复调用是空操作。 */
    fun applyThreadPriority() {
        /*
         * 正在放歌也降到 BACKGROUND：歌在放的时候解码与 AudioTrack 是硬实时，
         * 分析线程哪怕在前台也该让路 —— 不然就是用户报的「负载太大，卡到
         * 歌词对不上曲子」。暂停 / 没放歌时恢复默认，分析全速跑。
         */
        val wanted = if (inBackground || playbackAudible) Process.THREAD_PRIORITY_BACKGROUND else Process.THREAD_PRIORITY_DEFAULT
        if (wanted == appliedPriority) return
        try {
            Process.setThreadPriority(wanted)
            appliedPriority = wanted
        } catch (error: Exception) {
            // 某些 ROM 上不允许改（安全策略），那就算了 —— sleep 那条路还在。
            Log.w(TAG, "设置分析线程优先级失败: ${error.message}")
        }
    }

    /**
     * 一个分块做完了，让一次。
     *
     * 后台降优先级并睡 60ms；前台按上一段耗时的 12% 让出（上限 120ms）。
     */
    fun yieldPoint() {
        applyThreadPriority()
        val now = SystemClock.elapsedRealtime()
        val since = if (lastYieldAt == 0L) 0L else now - lastYieldAt
        lastYieldAt = now
        if (inBackground) {
            sleepFor(BACKGROUND_SLEEP_MS)
            return
        }
        /*
         * 前台也让一点 —— 但只按上一段的耗时让出 12%，上限 120 毫秒。
         *
         * 为什么前台也要让：整曲推理是「一块两三秒、连着六块」的形态，
         * 这块机器同时还在解音频、画可视化。让出这一小截，平均占用降一档，
         * 而整首歌只多花不到一秒 —— 用户感觉不到慢，只会觉得不那么烫、不卡顿。
         * 上限 120ms 是为了让首段（只有一块）几乎不受影响：这块算完就让 100 多毫秒，
         * 画面还是在一两秒内动起来。
         */
        val give = min(120L, since * 12 / 100)
        if (give > 0) sleepFor(give)
    }

    private fun sleepFor(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    /** 取消后不再让路，直接返回：调用方紧接着就会退出循环。 */
    fun yieldUnless(cancelled: () -> Boolean) {
        if (cancelled()) return
        yieldPoint()
    }

    /**
     * 分离推理专用的让路：一个 11 秒窗口（SCNet）跑完调一次。
     *
     * 与 [yieldPoint] 的差别在于让多少：推理窗口比 mel / 解码块重得多，
     * 4 条 ORT 线程整整跑一个窗口，正在放的歌抢不到时间片就是「歌词对不上曲子」。
     * 所以只要播放器在出声，就按窗口耗时的大头让出去 —— 分离慢一点没关系，
     * 用户在听歌；暂停 / 没放歌时不让（只走前台 12% 那条），全速跑。
     *
     * @param windowMs 刚跑完的这个窗口实际花了多久（推理 + 逆变换）
     * @param eager    用户正拨着开关等结果。让得少一档，但也不许全速 ——
     *                 体验优先级是：听得顺 > 等得短。
     */
    fun separationYield(windowMs: Long, eager: Boolean = false) {
        applyThreadPriority()
        val now = SystemClock.elapsedRealtime()
        val since = if (lastYieldAt == 0L) 0L else now - lastYieldAt
        lastYieldAt = now
        if (inBackground) {
            sleepFor(BACKGROUND_SLEEP_MS)
            return
        }
        if (playbackAudible) {
            /*
             * 两个分离任务同时跑（伴奏预生成 + 智能动感精修）时再压一档：
             * 各让各的相加还是会把核占满，比例随任务数抬。
             */
            val share = when {
                activeRuns.get() > 1 -> if (eager) 55 else 80
                eager -> 35
                else -> 65
            }
            val give = (windowMs * share / 100).coerceIn(if (eager) 200L else 400L, PLAYING_SLEEP_MAX_MS)
            sleepFor(give)
            return
        }
        val give = min(120L, since * 12 / 100)
        if (give > 0) sleepFor(give)
    }
}
