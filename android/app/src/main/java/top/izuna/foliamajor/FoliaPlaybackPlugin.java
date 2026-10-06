package top.izuna.foliamajor;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Web 层与 FoliaPlaybackService 之间的桥。
 *
 * Web 层不直接 startForegroundService（那需要暴露原生 API 给任意 JS 调用），
 * 而是通过这个插件把意图转成 service 的 startService 动作。
 *
 * 注意 Android 8+ 不允许后台启动服务，所以 startForegroundService 之后
 * 服务端必须在一个「准点」上调用 startForeground 来满足系统的 5 秒要求；
 * FoliaPlaybackService.onStartCommand 收到 ACTION_UPDATE_STATE 且 state=playing 时立刻前台化。
 */
@CapacitorPlugin(name = "FoliaPlayback")
public class FoliaPlaybackPlugin extends Plugin {

    /**
     * 服务发来的控制命令经 MainActivity 的广播接收器转到这里，再派发给 JS。
     * 事件名必须与 Web 层 FoliaPlayback.addListener 订阅的保持一致。
     */
    private static final String EVENT_COMMAND = "foliaPlaybackCommand";

    @PluginMethod
    public void update(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity unavailable; cannot update playback metadata.");
            return;
        }

        Intent intent = new Intent(activity, FoliaPlaybackService.class);
        intent.setAction(FoliaPlaybackService.ACTION_UPDATE_METADATA);
        String title = call.getString("title");
        String artist = call.getString("artist");
        String album = call.getString("album");
        String artwork = call.getString("artworkBase64");
        Integer duration = call.getInt("durationMs");

        if (title != null) intent.putExtra(FoliaPlaybackService.EXTRA_TITLE, title);
        if (artist != null) intent.putExtra(FoliaPlaybackService.EXTRA_ARTIST, artist);
        if (album != null) intent.putExtra(FoliaPlaybackService.EXTRA_ALBAND, album);
        if (artwork != null) intent.putExtra(FoliaPlaybackService.EXTRA_ARTWORK, artwork);
        if (duration != null) intent.putExtra(FoliaPlaybackService.EXTRA_DURATION, (long) duration);

        startServiceCompat(activity, intent);
        call.resolve();
    }

    @PluginMethod
    public void setState(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity unavailable; cannot update playback state.");
            return;
        }

        String state = call.getString("state");
        Intent intent = new Intent(activity, FoliaPlaybackService.class);
        intent.setAction(FoliaPlaybackService.ACTION_UPDATE_STATE);
        if (state != null) intent.putExtra(FoliaPlaybackService.EXTRA_STATE, state);
        Integer position = call.getInt("positionMs");
        if (position != null) intent.putExtra(FoliaPlaybackService.EXTRA_POSITION, (long) position);
        Float speed = call.getFloat("speed");
        if (speed != null) intent.putExtra(FoliaPlaybackService.EXTRA_SPEED, speed);

        startServiceCompat(activity, intent);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        Intent intent = new Intent(activity, FoliaPlaybackService.class);
        intent.setAction(FoliaPlaybackService.ACTION_STOP_FOREGROUND);
        activity.startService(intent);
        call.resolve();
    }

    /**
     * 把服务端的播放/切歌意图派发给 Web 层。
     *
     * 用 Capacitor 的事件通道而不是直接调用 Web 层方法：JS 侧通过
     * FoliaPlayback.onCommand(handler) 订阅，插件内部只管 notifyListeners。
     */
    public void dispatchCommand(String command) {
        JSObject payload = new JSObject();
        payload.put("command", command);
        notifyListeners(EVENT_COMMAND, payload);
    }

    /**
     * 把服务端的播放/切歌意图转成一个供 Web 层订阅的 CustomEvent。
     *
     * 服务与 Activity 是不同组件；这里统一由插件在 Activity 存活期间接收广播，
     * 再 notifyListeners 派发给 JS。Web 层据此调用自己的播放控制，
     * 避免在原生侧再实现一套播放器状态机。
     */
    public static void dispatchCommandToWeb(Context context, String command) {
        Intent intent = new Intent(FoliaPlaybackService.ACTION_WEB_COMMAND);
        intent.setPackage(context.getPackageName());
        intent.putExtra(FoliaPlaybackService.EXTRA_COMMAND, command);
        context.sendBroadcast(intent);
    }

    private void startServiceCompat(Activity activity, Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            activity.startForegroundService(intent);
        } else {
            activity.startService(intent);
        }
    }
}
