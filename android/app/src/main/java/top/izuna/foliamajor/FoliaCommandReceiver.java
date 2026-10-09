package top.izuna.foliamajor;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 通知栏/锁屏/耳机按键发来的播放控制指令。
 *
 * 走清单注册的接收器而不是 Activity 里的动态接收器：动态接收器只在 Activity
 * 存活时有效，而用户点通知栏时应用往往就在后台 —— 那时指令会全部丢失。
 *
 * 接到指令后交给 Capacitor 插件实例，由它 notifyListeners 派发给 Web 层，
 * 原生侧不另起一套播放器状态机。
 */
public class FoliaCommandReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) {
            return;
        }
        String command = intent.getStringExtra(FoliaPlaybackService.EXTRA_COMMAND);
        if (command == null || command.isEmpty()) {
            return;
        }
        // 只有 seek 带位置；其余命令拿到的是默认值 0，Web 层不会去读。
        long positionMs = intent.getLongExtra(FoliaPlaybackService.EXTRA_COMMAND_POSITION, 0L);
        FoliaPlaybackPlugin.dispatchCommandFromReceiver(command, positionMs);
    }
}
