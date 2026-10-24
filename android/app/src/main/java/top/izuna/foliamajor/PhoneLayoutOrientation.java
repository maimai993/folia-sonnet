package top.izuna.foliamajor;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;

/**
 * 「强制横屏」的方向锁。
 *
 * 只认方向本身：横屏就把 Activity 锁成横屏，其它一律交回系统（UNSPECIFIED，
 * 跟着传感器转）。
 *
 * **不再看「手机布局」那个总开关** —— 那个开关已经从设置里删掉了，而正是这道门
 * 让「横竖屏兼容」那一行单独打开时毫无反应（用户原话「打开也不生效」）：
 * `isEnabled()` 默认是 false，方向锁于是永远走 UNSPECIFIED 那一支。
 *
 * 在此之上一层是**临时覆盖**（`override`）：「进入可视化自动横屏」用的就是它。
 * 它不落盘 —— 下一次冷启动回到落盘那一份选择；而且它用的是 SENSOR_PORTRAIT，
 * 因为这条路的竖屏是要**真的转回去**，不是「交回系统」（那样手机还横着拿时画面
 * 就一直横着，等于没切回）。
 */
final class PhoneLayoutOrientation {
    private static final String PREFS_NAME = "folia_native_prefs";
    private static final String KEY_ENABLED = "phone_fit_enabled";
    private static final String KEY_ORIENTATION = "phone_fit_orientation";
    private static final String MODE_PORTRAIT = "portrait";
    private static final String MODE_LANDSCAPE = "landscape";

    /**
     * 临时覆盖：null = 没有覆盖（走落盘那份选择），否则是 landscape / portrait。
     *
     * 静态而不是落盘，是故意的：这次运行里进了可视化才横屏，下次启动该回到用户自己
     * 选的那个方向，而不是「上次关掉时正好在看可视化」时的朝向。
     */
    private static volatile String override = null;

    private PhoneLayoutOrientation() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext()
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    static boolean isEnabled(Context context) {
        return prefs(context).getBoolean(KEY_ENABLED, false);
    }

    static String getOrientation(Context context) {
        return normalize(prefs(context).getString(KEY_ORIENTATION, MODE_PORTRAIT));
    }

    static void update(Context context, boolean enabled, String orientation) {
        prefs(context).edit()
            .putBoolean(KEY_ENABLED, enabled)
            .putString(KEY_ORIENTATION, normalize(orientation))
            .apply();
    }

    /**
     * 临时覆盖（「进入可视化自动横屏」）：null 撤掉覆盖，回到落盘那份选择。
     *
     * 传进来的 Activity 用于在 UI 线程上立刻生效；null 就只改状态，等下一次 apply。
     */
    static void setOverride(Activity activity, String mode) {
        override = normalizeOverride(mode);
        if (activity != null) {
            activity.runOnUiThread(() -> apply(activity));
        }
    }

    static String getOverride() {
        return override;
    }

    static void apply(Activity activity) {
        if (activity == null) return;
        /*
         * 临时覆盖最优先：它压着的是「这一刻在哪一页」这件事，比落盘那份选择新。
         * 它的竖屏是**真的锁竖屏**（SENSOR_PORTRAIT）—— 见类注释。
         */
        String active = override;
        if (active != null) {
            activity.setRequestedOrientation(
                MODE_LANDSCAPE.equals(active)
                    ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    : ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
            );
            return;
        }
        /*
         * 只有「强制横屏」这一条会锁方向；关掉就是交回系统，不再有中间那道总开关。
         *
         * SENSOR_LANDSCAPE 而不是 LANDSCAPE：前者允许 180° 转向（手机倒过来拿，
         * 屏幕跟着倒），后者会把它钉死在某一个方向。
         */
        activity.setRequestedOrientation(
            MODE_LANDSCAPE.equals(getOrientation(activity))
                ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        );
    }

    private static String normalize(String value) {
        return MODE_LANDSCAPE.equals(value) ? MODE_LANDSCAPE : MODE_PORTRAIT;
    }

    /** 覆盖只认 landscape / portrait，其它（包括 null 与 "auto"）都当作「撤掉覆盖」。 */
    private static String normalizeOverride(String value) {
        return MODE_LANDSCAPE.equals(value) ? MODE_LANDSCAPE
            : MODE_PORTRAIT.equals(value) ? MODE_PORTRAIT
            : null;
    }
}
