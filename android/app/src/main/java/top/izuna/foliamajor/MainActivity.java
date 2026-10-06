package top.izuna.foliamajor;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

/**
 * Folia 的主 Activity。
 *
 * 在 Capacitor 默认实现之上补了一件 Web 层做不到的事：真正隐藏系统栏。
 *
 * 之前只在 web 层调 StatusBar.setOverlaysWebView(true)，那只是让内容延伸到状态栏下方，
 * 状态栏与底部导航栏的图标仍然可见，而且导航栏那块区域留着一块与播放器背景不一致的空白。
 * 这里用 WindowInsetsControllerCompat 把两个栏都隐藏，WebView 铺满整屏；
 * 用户从边缘下滑可临时唤出（BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE），随后自动隐藏。
 */
public class MainActivity extends BridgeActivity {

    /**
     * 接收服务的播放控制意图（通知栏/锁屏/耳机按键经 MediaSession 转发而来）。
     *
     * 走广播而不是直接持有 Service 引用：Service 与 Activity 是不同组件，
     * 且 Activity 可能已随后台被回收。广播由 Capacitor 插件派发给 JS，
     * 由 Web 层调用自己那套播放控制，避免原生再实现一份播放器状态机。
     */
    private final BroadcastReceiver playbackCommandReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String command = intent.getStringExtra(FoliaPlaybackService.EXTRA_COMMAND);
            if (command == null || command.isEmpty()) {
                return;
            }
            if (getBridge() == null) {
                return;
            }
            // getPlugin 返回的是 PluginHandle 包装类，实例要从它身上取。
            PluginHandle handle = getBridge().getPlugin("FoliaPlayback");
            Object plugin = handle == null ? null : handle.getInstance();
            if (plugin instanceof FoliaPlaybackPlugin) {
                ((FoliaPlaybackPlugin) plugin).dispatchCommand(command);
            }
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyImmersiveMode();
        // 播放时屏幕常亮（不阻止熄屏睡眠，因此不额外耗电）。
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        // 后台播放所需的插件必须显式注册，Capacitor 不会自动发现 app 模块里的插件。
        registerPlugin(FoliaPlaybackPlugin.class);
    }

    @Override
    public void onStart() {
        super.onStart();
        // 服务发来的播放/切歌意图在这里接收，再派发回 Web 层。
        // Activity 只在前台时才需要监听：通知栏/耳机按键会先把应用带到前台，
        // 之后这条路径必然是活的。
        IntentFilter filter = new IntentFilter(FoliaPlaybackService.ACTION_WEB_COMMAND);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(playbackCommandReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(playbackCommandReceiver, filter);
        }
    }

    @Override
    public void onStop() {
        super.onStop();
        try {
            unregisterReceiver(playbackCommandReceiver);
        } catch (IllegalArgumentException alreadyGone) {
            // 未注册过，忽略。
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // 系统会在下拉通知栏、权限弹窗、旋转等时机重置沉浸态，回前台时要重新压一次。
        if (hasFocus) {
            applyImmersiveMode();
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        // 从后台回前台时系统会重新布局，直接 apply 有时会被随后的布局覆盖，
        // 延后一拍再压一次，避免出现一瞬间的状态栏/导航栏残留。
        getWindow().getDecorView().postDelayed(this::applyImmersiveMode, 120);
    }

    /**
     * 隐藏状态栏与导航栏，并让 WebView 绘制到刘海/挖孔区域。
     */
    private void applyImmersiveMode() {
        View decorView = getWindow().getDecorView();
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), decorView);
        controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }
}
