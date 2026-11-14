package top.izuna.foliamajor
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 通知栏/锁屏/耳机按键发来的播放控制指令。
 *
 * 走清单注册的接收器而不是 Activity 里的动态接收器：动态接收器只在 Activity
 * 存活时有效，而用户点通知栏时应用往往就在后台 —— 那时指令会全部丢失。
 *
 * 两类来路分开处理：
 * - **用户按的按钮**（通知栏三键、锁屏面板，带 EXTRA_FROM_BUTTONS）：
 *   next / previous / like 先转进服务 —— 兜底计时器（镜像换源、原生补写红心）
 *   只有服务自己能挂，以前这里直派 JS，WebView 一冻结整排按钮就是死的；
 *   JS 那份命令由服务统一发，这里不再直派，免得两份。
 * - **服务转来的回话**（sendCommand 的广播，不带标记）：直派 JS。
 */
class FoliaCommandReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent == null) {
            return
        }
        val command = intent.getStringExtra(FoliaPlaybackService.EXTRA_COMMAND)
        if (command == null || command.isEmpty()) {
            return
        }
        // 只有 seek 带位置；其余命令拿到的是默认值 0，Web 层不会去读。
        val positionMs = intent.getLongExtra(FoliaPlaybackService.EXTRA_COMMAND_POSITION, 0L)
        val songKey = intent.getStringExtra(FoliaPlaybackService.EXTRA_SONG_KEY)

        if (intent.getBooleanExtra(FoliaPlaybackService.EXTRA_FROM_BUTTONS, false)) {
            when (command) {
                // play / pause 也要转进服务：锁屏与通知栏按下来的时候 WebView 在后台，
                // 直派 JS 会落进被系统挂起的定时器里（「按了播放一点反应都没有」）。
                // 服务那边先动原生播放器，再把 JS 那份照发。
                //
                // seek 同理：锁屏面板拖进度条发来的就是这一条，原生激活时服务直接在
                // 播放器上跳（handleTransportSeek），绝不指望后台里那个被冻结的 JS；
                // 原生没接（<audio> 在播）才轮到 Web 那条路。漏了它，锁屏拖动在前台
                // 服务活着而 WebView 被冻结/节流时就是「拖了没反应」。
                "next", "previous", "like", "play", "pause", "stop", "seek" -> {
                    forwardToService(context, command, positionMs)
                    return
                }
                else -> {
                }
            }
        }
        FoliaPlaybackPlugin.dispatchCommandFromReceiver(command, positionMs, songKey)
    }

    /** 用户按钮转进服务。服务没在跑（理论上按钮存在即服务在前台）就退回直派 JS。 */
    private fun forwardToService(context: Context, command: String, positionMs: Long) {
        if (FoliaPlaybackService.isRunning()) {
            val service = Intent(context, FoliaPlaybackService::class.java)
            service.action = FoliaPlaybackService.ACTION_MEDIA_COMMAND
            service.putExtra(FoliaPlaybackService.EXTRA_COMMAND, command)
            service.putExtra(FoliaPlaybackService.EXTRA_COMMAND_POSITION, positionMs)
            try {
                context.startService(service)
                return
            } catch (ignored: Throwable) {
                // 服务起不来就没有兜底，JS 那条路照常。
            }
        }
        FoliaPlaybackPlugin.dispatchCommandFromReceiver(command, positionMs, null)
    }
}
