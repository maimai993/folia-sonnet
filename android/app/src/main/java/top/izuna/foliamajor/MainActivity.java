package top.izuna.foliamajor;

import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.Manifest;
import android.graphics.Color;
import android.view.View;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

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
     * 播放控制意图由清单注册的 FoliaCommandReceiver 统一接收，不再挂在 Activity 上。
     *
     * 原来的动态接收器只在 Activity 存活时有效，而用户点通知栏时应用通常在后台，
     * 指令全部丢失；且它与新接收器同时匹配 ACTION_WEB_COMMAND，会一次指令派发两遍。
     */

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 第一行就装上：崩溃可能就发生在下面 super.onCreate() 的 Bridge 创建过程中。
        FoliaCrashHandler.install(this);

        // 必须在 super.onCreate() **之前**注册。
        //
        // registerPlugin 只是往 bridgeBuilder 里登记类，而真正创建 Bridge
        // （bridgeBuilder.create()）是在 BridgeActivity.onCreate() 内部完成的。
        // 放在 super 之后就太晚了：Bridge 已经建好，这个插件永远不会被实例化，
        // JS 侧调用会静默失败 —— 播放通知因此完全不出现。
        registerPlugin(FoliaPlaybackPlugin.class);
        registerPlugin(FoliaWallpaperPlugin.class);
        registerPlugin(top.izuna.foliamajor.lyricon.FoliaLyriconPlugin.class);

        super.onCreate(savedInstanceState);

        applyImmersiveMode();
        // 播放时屏幕常亮（不阻止熄屏睡眠，因此不额外耗电）。
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        requestNotificationPermissionIfNeeded();
        // StatusBar 插件是在 Bridge 创建时（super 里）加载并应用配置的，
        // 可能在我们之后才动到 systemUiVisibility；多压几次确保沉浸态最终生效。
        scheduleImmersiveReapply();
    }

    /**
     * 延后重复压几次沉浸态。
     *
     * StatusBar 插件的 setOverlaysWebView 走废弃的 setSystemUiVisibility，
     * 会覆盖 WindowInsetsControllerCompat 的 hide 结果；它在 Bridge 创建时执行，
     * 与我们这里的调用存在竞态。几拍之后内容也加载完了，压最后一次即可收口。
     */
    private void scheduleImmersiveReapply() {
        View decorView = getWindow().getDecorView();
        for (long delay : new long[] { 150L, 500L, 1200L }) {
            decorView.postDelayed(this::applyImmersiveMode, delay);
        }
    }

    /**
     * Android 13+ 的通知权限必须运行时申请，只在 manifest 里声明是不够的。
     *
     * 没有它，startForeground 照常生效（进程仍能拿到前台优先级），
     * 但通知对用户不可见 —— 用户要的「音乐播放通知」就看不到了。
     */
    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;
        }
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 0x1F02);
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
     * 全沉浸：隐藏系统栏，并让 WebView 真正铺满整屏。
     *
     * 两件事必须一起做，只做一半就会出现「栏被隐藏了但那一块是空白」：
     *
     * 1. `setDecorFitsSystemWindows(false)`：让内容绘制到系统栏区域**之下**。
     *    这是关键的一步。缺了它，栏虽然被 hide 掉，但窗口仍按「内容避开系统栏」来布局，
     *    顶部/底部就留下一块背景色的空白带 —— 正是用户看到的「那一栏还是空白的」。
     * 2. `controller.hide(systemBars())`：把状态栏与导航栏都隐藏。
     *
     * 另外要把两个栏的背景色设为透明：有些 ROM 即使隐藏了也会留下底色残留。
     *
     * 不能依赖 web 层的 StatusBar.setOverlaysWebView —— 它走的是已废弃的
     * setSystemUiVisibility(SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN)，
     * 只覆盖状态栏、不覆盖导航栏，而且它在 JS 加载后才执行，会把这里的 hide 结果冲掉。
     */
    private void applyImmersiveMode() {
        View decorView = getWindow().getDecorView();

        // 内容绘制到系统栏之下（含刘海/挖孔区域）。
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        // 两个栏都设为透明，避免隐藏后残留底色。
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        // 手势导航条也透明，否则底部会留一条白/黑的细线。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setNavigationBarContrastEnforced(false);
        }

        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), decorView);
        controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }

    /**
     * 只切换系统栏图标的明暗，不影响隐藏状态。
     *
     * 从 web 层（useCapacitorSystemBars）调 StatusBar.setStyle 也有同样效果，
     * 但那会连带触发 setSystemUiVisibility，把 hide 的结果冲掉，所以改在这里做。
     */
    public void applySystemBarAppearance(boolean isDaylight) {
        View decorView = getWindow().getDecorView();
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), decorView);
        // 亮色主题下图标用深色，反之为浅色。
        controller.setAppearanceLightStatusBars(isDaylight);
        controller.setAppearanceLightNavigationBars(isDaylight);
    }
}
