package top.izuna.foliamajor.lockscreen;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.provider.Settings;

import top.izuna.foliamajor.coloros.ColorOsLyricBridge;

/**
 * 锁屏页在**国内 ROM**上到底要用户放行哪些开关，以及能跳到哪一页。
 *
 * ## 为什么需要它
 *
 * 锁屏页是一个 `setShowWhenLocked(true)` 的 Activity，从后台（广播里）起来。
 * 这条路在 AOSP 上没问题，但国内 ROM 各自还压了一道开关，而且是**静默**的：
 * 不抛异常、不返回失败，只有系统自己往 logcat 打一行 —— 真机上基本取不到。
 * 用户看到的就是「开关开了，什么都没发生」。
 *
 * 以 ColorOS（OPPO / 一加 / realme）为例，一共三道：
 *
 *  · **后台弹出界面**（设置 → 应用 → 特殊应用权限 → 后台弹出界面）：不开它，
 *    应用从后台 startActivity 会被 ROM 那一层直接掐掉，这是最常见的一条；
 *  · **锁屏显示**（设置 → 权限与隐私 → 权限管理 → 锁屏显示）：不开它，
 *    Activity 起得来也画不到 keyguard 之上；
 *  · **自启动 / 允许唤醒前台**（设置 → 应用 → 应用管理 → 耗电管理）：不开它，
 *    息屏之后进程可能根本没机会再起这一页。
 *
 * 另外 Android 14 把「后台启动 Activity」的豁免收窄了：普通前台服务不再算，
 * 得靠**悬浮窗**（`SYSTEM_ALERT_WINDOW`）这类"应用此刻有可见窗口"的状态。
 * 所以本应用那颗悬浮窗权限，在 14 上对锁屏页是**刚需**，不是可选项。
 *
 * 这三条没有一条是代码能绕过去的（没有调用能替用户授权）。所以这里做的
 * 是判定 + 跳转：把用户送到正确的那一页，并把当前状态写进诊断。
 */
public final class RomPermissionGuide {

    /** 跳转目标。 deliberately 用字符串：Web 层传过来方便，新增目标不用改签名。 */
    public static final String TARGET_OVERLAY = "overlay";
    public static final String TARGET_BACKGROUND_START = "background";
    public static final String TARGET_POWER = "power";
    public static final String TARGET_DETAILS = "details";

    private RomPermissionGuide() {
    }

    /**
     * ROM 标签，直接显示给用户（"ColorOS 14"）。不是 OPlus 系就返回空串：
     * 文案那边靠它决定要不要显示那一整段 ROM 引导。
     */
    public static String romLabel() {
        int major = ColorOsLyricBridge.detect().colorOsMajor;
        if (major <= 0) {
            return "";
        }
        return "ColorOS " + major;
    }

    /** 悬浮窗权限。Android 14 上它是后台启动 Activity 的主要豁免来源。 */
    public static boolean canDrawOverlays(Context context) {
        try {
            return Settings.canDrawOverlays(context);
        } catch (Throwable error) {
            return false;
        }
    }

    /**
     * 跳到对应那一页。
     *
     * ROM 的自家页面**只能猜**（包名 / 类名各代都不一样，而且没有公开约定），
     * 所以每个候选都先 `resolveActivity` 验一次，验不过就换下一个；
     * 全都验不过就退回应用详情页 —— 那一页一定在，用户从那里点两次也能到。
     *
     * @return 有没有真的跳出去（false = 只能提示用户手动去设置里找）。
     */
    public static boolean open(Context context, String target) {
        if (context == null) {
            return false;
        }
        if (TARGET_OVERLAY.equals(target)) {
            if (openOverlay(context)) {
                return true;
            }
            return openDetails(context);
        }
        if (TARGET_BACKGROUND_START.equals(target)) {
            if (openFirstResolvable(context, PERMISSION_CENTERS)) {
                return true;
            }
            return openDetails(context);
        }
        if (TARGET_POWER.equals(target)) {
            if (openFirstResolvable(context, POWER_CENTERS)) {
                return true;
            }
            return openDetails(context);
        }
        return openDetails(context);
    }

    /**
     * OPPO 系各代的「权限中心」。
     *
     * 全是猜测：ColorOS 7 前后是 `com.coloros.safecenter`，12 之后改叫
     * `com.oplus.safecenter`，中间还有过 `com.coloros.securitypermission`。
     * 猜错没有代价 —— 验不过就跳过，最后还有应用详情兜底。
     */
    private static final String[][] PERMISSION_CENTERS = {
            {"com.oplus.safecenter", "com.oplus.safecenter.permission.PermissionManagerActivity"},
            {"com.coloros.safecenter", "com.coloros.safecenter.permission.PermissionManagerActivity"},
            {"com.coloros.securitypermission",
                    "com.coloros.securitypermission.permission.PermissionManagerActivity"},
    };

    /** 耗电 / 自启动管理。同样是猜，同样是验不过就跳。 */
    private static final String[][] POWER_CENTERS = {
            {"com.coloros.powermanager", "com.coloros.powermanager.ui.PowerMainActivity"},
            {"com.oplus.powermanager", "com.oplus.powermanager.ui.PowerMainActivity"},
            {"com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity"},
    };

    private static boolean openOverlay(Context context) {
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    android.net.Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            return true;
        } catch (Throwable error) {
            return false;
        }
    }

    private static boolean openDetails(Context context) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    android.net.Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            return true;
        } catch (Throwable error) {
            return false;
        }
    }

    private static boolean openFirstResolvable(Context context, String[][] candidates) {
        PackageManager manager = context.getPackageManager();
        for (String[] candidate : candidates) {
            try {
                Intent intent = new Intent();
                intent.setClassName(candidate[0], candidate[1]);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                if (intent.resolveActivity(manager) == null) {
                    continue;
                }
                context.startActivity(intent);
                return true;
            } catch (Throwable error) {
                // 这个候选不在本机器上，换下一个。
            }
        }
        return false;
    }

    /** 给诊断用：把当前这几道开关的状态写成一行中文。 */
    public static String describe(Context context) {
        String rom = romLabel();
        return (rom.isEmpty() ? "非 ColorOS" : rom)
                + "，悬浮窗" + (canDrawOverlays(context) ? "已授权" : "未授权");
    }

    /** Android 版本，诊断里一并带上（后台启动限制 14 起明显收紧）。 */
    public static int sdkInt() {
        return Build.VERSION.SDK_INT;
    }
}
