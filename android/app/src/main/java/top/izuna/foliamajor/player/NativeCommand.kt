package top.izuna.foliamajor.player

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

// 当前文件：原生播放命令的结果、过期判定、exactly-once 结算与调度（#337 #338 #339 #341）。
//
// 纯 Kotlin，不碰 Android / ExoPlayer：线程由调用方注入（post / onPlayerThread），好在 JVM 单测里直接跑。
// 接线在 FoliaNativePlayer 的 scheduler；PluginCall 的 resolve / reject 在 FoliaNativePlayerPlugin。

/** 提交给播放器线程的命令种类。 */
enum class NativeCommandKind { PREPARE, PLAY, PAUSE, STOP, SEEK }

/** 一条命令的最终结果。每条命令恰好得到其中一个。 */
sealed class NativeCommandResult {
    /** 播放器线程已经真正执行完这条命令的动作；sourceEpoch 是执行时所属的 source。 */
    data class Ok(val sourceEpoch: Long) : NativeCommandResult()

    /** 动作在开始前就被更新的命令取代了：没有执行，也不是错误。 */
    data class Stale(val reason: String) : NativeCommandResult()

    /** 动作没能执行或执行时抛了异常（含播放器已 release、post 失败）。 */
    data class Failed(val code: String, val message: String) : NativeCommandResult()
}

typealias NativeCommandCompletion = (NativeCommandResult) -> Unit

object NativeCommandPolicy {
    const val REASON_SOURCE = "source-superseded"
    const val REASON_INTENT = "intent-superseded"

    /**
     * 这条命令在播放器线程上轮到它时，还该不该执行。返回 null = 执行；否则是过期原因。
     *
     * - PREPARE / PLAY / SEEK：提交之后又换了源（prepare / stop / 过渡接管递增 sourceEpoch）→ 过期，
     *   旧 source 的命令不能污染新 source。seek 只受这一条约束：两次 seek 按 FIFO 都执行，
     *   最终位置是最后一次的。
     * - PLAY / PAUSE：提交之后又来了更新的 play / pause / stop（transportEpoch 变了）→ 过期，
     *   只让最新的播放意图落地，省掉「先响一下再停」。
     * - **PAUSE 不受 sourceEpoch 约束**：暂停是用户对「此刻正在响的东西」的意图。
     *   原生自己在同一瞬间换了歌（nearEnd 交叉淡化 / 服务兜底切歌）时，暂停仍要落到新歌上，
     *   而不是被当成旧 source 的命令吞掉。
     * - **STOP 仍受 sourceEpoch 约束**：后到的 prepare 在调用线程上已经提前写了 lastUrl / lastMediaId /
     *   令牌，排在它前面的旧 stop 若还执行，会把这些缓存清空，新 source 就「看起来没装」。
     */
    fun staleReason(
        kind: NativeCommandKind,
        capturedSource: Long,
        capturedTransport: Long,
        currentSource: Long,
        currentTransport: Long,
    ): String? {
        if (kind != NativeCommandKind.PAUSE && capturedSource != currentSource) {
            return REASON_SOURCE
        }
        if ((kind == NativeCommandKind.PLAY || kind == NativeCommandKind.PAUSE) &&
            capturedTransport != currentTransport
        ) {
            return REASON_INTENT
        }
        return null
    }
}

/** 一条在途命令：completion 至多被调用一次，无论谁先来结算（执行、过期、release、post 失败）。 */
class PendingCommand(
    val kind: NativeCommandKind,
    private val completion: NativeCommandCompletion?,
) {
    private val settled = AtomicBoolean(false)

    val isSettled: Boolean get() = settled.get()

    /** 返回 true = 这一次结算生效；false = 之前已经结算过，本次被忽略。 */
    fun settle(result: NativeCommandResult): Boolean {
        if (!settled.compareAndSet(false, true)) return false
        try {
            completion?.invoke(result)
        } catch (ignored: Throwable) {
            // completion 里的失败（桥已销毁等）不能传回播放器线程；调用方自己负责记日志。
        }
        return true
    }
}

/** 所有还没结算的命令。release 时用它保证没有 Promise 永远悬挂。 */
class PendingCommands {
    private val commands = ConcurrentHashMap.newKeySet<PendingCommand>()

    fun add(command: PendingCommand) {
        commands.add(command)
    }

    fun remove(command: PendingCommand) {
        commands.remove(command)
    }

    val size: Int get() = commands.size

    fun settleAll(result: NativeCommandResult) {
        for (command in commands.toList()) {
            commands.remove(command)
            command.settle(result)
        }
    }
}

/**
 * 命令调度：纪元分配、post、过期判定、结算。线程由调用方注入。
 *
 * - [post]：把任务排到播放器线程，返回 false = 线程不接受（已 quit）。
 * - [onPlayerThread]：此刻是否就在播放器线程（是则直接跑，不排到下一轮）。
 * - [onActionError]：动作抛异常时在播放器线程上回调（用来发 error 事件）；它抛出的异常会被吞掉，
 *   不影响结算。
 */
class NativeCommandScheduler(
    private val post: (Runnable) -> Boolean,
    private val onPlayerThread: () -> Boolean,
    private val onActionError: (Throwable) -> Unit = {},
) {
    private val sourceEpochCounter = AtomicLong(0L)
    private val transportEpochCounter = AtomicLong(0L)
    private val pending = PendingCommands()
    private val lock = Any()

    @Volatile
    private var released = false

    val sourceEpoch: Long get() = sourceEpochCounter.get()
    val transportEpoch: Long get() = transportEpochCounter.get()
    val pendingCount: Int get() = pending.size
    val isReleased: Boolean get() = released

    /**
     * 过渡接管 / 原生自己换歌等「换源但不是一条普通命令」的边界：只同步递增 sourceEpoch，
     * 此前排队的旧 prepare / play / seek 变 Stale，紧随其后提交的命令才是新纪元。
     *
     * **不动 transportEpoch**：换源不是用户的播放意图。若这里也递增，同一瞬间排队的用户 pause
     * 会因「有更新的意图」被判过期、被吞掉，新歌继续出声（M3）。
     * 返回新的 sourceEpoch；已 release 返回 -1。
     */
    fun bumpBoundary(): Long = synchronized(lock) {
        if (released) -1L else sourceEpochCounter.incrementAndGet()
    }

    /**
     * 提交一条命令。[callerSide] 在**调用线程**、锁内、纪元分配之后同步执行（volatile 缓存的提前写入），
     * 参数是这条命令的 sourceEpoch；[action] 在播放器线程执行。
     */
    fun dispatch(
        kind: NativeCommandKind,
        completion: NativeCommandCompletion?,
        bumpSource: Boolean,
        bumpTransport: Boolean,
        callerSide: ((Long) -> Unit)? = null,
        action: () -> Unit,
    ) {
        val command = PendingCommand(kind, completion)
        var capturedSource = 0L
        var capturedTransport = 0L
        var posted = false
        var rejected = false
        val direct = onPlayerThread()
        val task = Runnable { run(command, capturedSource, capturedTransport, action) }
        synchronized(lock) {
            if (released) {
                // release() 在同一把锁里置位：这里看到 false，release 的 settleAll 就一定能看到本条。
                rejected = true
            } else {
                capturedSource = if (bumpSource) sourceEpochCounter.incrementAndGet() else sourceEpochCounter.get()
                capturedTransport = if (bumpTransport) transportEpochCounter.incrementAndGet() else transportEpochCounter.get()
                callerSide?.invoke(capturedSource)
                pending.add(command)
                if (!direct) {
                    // post 在锁内：post 顺序必须与纪元分配顺序一致。
                    posted = try { post(task) } catch (ignored: Throwable) { false }
                }
            }
        }
        if (rejected) {
            command.settle(NativeCommandResult.Failed("PLAYER_RELEASED", "The player has been released."))
            return
        }
        if (direct) {
            // 已经就在播放器线程上：直接跑（prepare 之后紧接着的 play 不该排到下一轮去）。
            task.run()
            return
        }
        if (!posted) {
            pending.remove(command)
            command.settle(NativeCommandResult.Failed("POST_FAILED", "The player thread is not accepting commands."))
        }
    }

    /** 播放器线程上执行一条命令：先判过期，再跑动作，最后结算。结算恰好一次。 */
    private fun run(command: PendingCommand, source: Long, transport: Long, action: () -> Unit) {
        if (command.isSettled) return
        if (released) {
            pending.remove(command)
            command.settle(NativeCommandResult.Failed("PLAYER_RELEASED", "The player has been released."))
            return
        }
        val stale = NativeCommandPolicy.staleReason(
            command.kind, source, transport, sourceEpochCounter.get(), transportEpochCounter.get(),
        )
        if (stale != null) {
            pending.remove(command)
            command.settle(NativeCommandResult.Stale(stale))
            return
        }
        try {
            action()
        } catch (error: Throwable) {
            // 先结算再通知：onActionError（发 error 事件）自己再抛，也不能让这条 Promise 悬挂。
            pending.remove(command)
            command.settle(NativeCommandResult.Failed("ACTION_FAILED", error.toString()))
            try {
                onActionError(error)
            } catch (ignored: Throwable) {
                // 事件监听器的失败不外溢到播放器线程。
            }
            return
        }
        pending.remove(command)
        command.settle(NativeCommandResult.Ok(source))
    }

    /**
     * 收尾：此后 dispatch 一律 Failed(PLAYER_RELEASED)，所有还在排队的命令统一 Failed。
     * 返回 false = 之前已经 release 过（幂等）。
     */
    fun release(): Boolean {
        synchronized(lock) {
            if (released) return false
            released = true
        }
        pending.settleAll(NativeCommandResult.Failed("PLAYER_RELEASED", "The player has been released."))
        return true
    }
}
