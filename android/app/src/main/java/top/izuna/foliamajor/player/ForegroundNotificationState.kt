package top.izuna.foliamajor.player

// 当前文件：前台服务「通知是否存在」与「是否已前台化」的单一状态机（#M4），纯 JVM 可测。

/**
 * 前台化状态与通知存在状态合成的那一个枚举（#M4）。
 *
 * 以前这两件事分别记在两个静态字段上（`foregrounded` + `cachedNotification`），三条收尾路径
 * （心跳撤回 / MediaSession onStop / onDestroy）各自动其中一部分，于是出现了
 * 「session inactive 但没 release」「onStop 之后通知还在」「通知撤了 session 还活着」这些中间态。
 * 现在只认三个状态 + 两条边：前台化（NONE/WITHDRAWN → FOREGROUND）、撤回（FOREGROUND → WITHDRAWN）、
 * 销毁（任意 → NONE）。
 */
enum class ForegroundNotificationState {
    /** 服务实例不存在（还没 onCreate / 已经 onDestroy）：没有前台承诺，也没有通知。 */
    NONE,

    /** 已经 startForeground：通知在系统手里，MediaSession 应当 active。 */
    FOREGROUND,

    /**
     * 前台化撤回了、通知也取消了，但服务实例还活着：MediaSession 已置 inactive 但**未 release**
     * （留着它，replay 时才能重新 active，不必重建回调）。此时 `isForegrounded` 必须报 false，
     * 插件据此改走 startForegroundService。
     */
    WITHDRAWN,
    ;

    /** 已经调过 startForeground，通知应当正在系统手里。 */
    val isForeground: Boolean get() = this == FOREGROUND

    /**
     * 服务此刻是否「以非前台身份在跑」—— 正是旧实现里 `running=true / foregrounded=false`
     * 那个没有名字的窗口期。有了它，插件与巡检可以直接判，而不必自己拼两个字段。
     */
    val isRunningInBackground: Boolean get() = this == WITHDRAWN

    companion object {
        /**
         * 这一下该不该真的调 startForeground（#M4）。
         *
         * 只有「现在不在前台」或「调用方要求无条件兑现」时才做主线程上那次 1 MB 的都交
         * （见 FoliaPlaybackService.promoteToForeground 里那段关于 5 秒倒计时的说明）。
         */
        fun needsForegroundCall(state: ForegroundNotificationState, unconditional: Boolean): Boolean =
            unconditional || !state.isForeground

        /** 促销 / 撤回之后的服务存活语义：销毁之外都还算活着。 */
        fun isAlive(state: ForegroundNotificationState): Boolean = state != NONE
    }
}
