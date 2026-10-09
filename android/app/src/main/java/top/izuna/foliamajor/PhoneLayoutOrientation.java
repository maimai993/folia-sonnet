package top.izuna.foliamajor;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;

/**
 * 「手机布局」开关打开时的方向锁。
 *
 * 手机上横向摆放时桌面端的宽屏布局会被压得很挤，所以开关打开就把方向锁成竖屏
 * （用户也可以选横屏）。关掉则完全交给系统。
 */
final class PhoneLayoutOrientation {
    private static final String PREFS_NAME = "folia_native_prefs";
    private static final String KEY_ENABLED = "phone_fit_enabled";
    private static final String KEY_ORIENTATION = "phone_fit_orientation";
    private static final String MODE_PORTRAIT = "portrait";
    private static final String MODE_LANDSCAPE = "landscape";

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

    static void apply(Activity activity) {
        if (activity == null) return;
        if (!isEnabled(activity)) {
            activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
            return;
        }
        activity.setRequestedOrientation(
            MODE_LANDSCAPE.equals(getOrientation(activity))
                ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                : ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
        );
    }

    private static String normalize(String value) {
        return MODE_LANDSCAPE.equals(value) ? MODE_LANDSCAPE : MODE_PORTRAIT;
    }
}
