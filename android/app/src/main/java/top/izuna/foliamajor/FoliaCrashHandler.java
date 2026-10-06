package top.izuna.foliamajor;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Looper;
import android.util.Log;

import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 崩溃取证。
 *
 * 为什么需要它：开发机上没有连着设备（adb devices 为空），崩溃栈只能靠 App 自己留下。
 * 默认行为是进程直接被杀、屏幕上只剩「xxx 已停止运行」，拿不到任何信息。
 *
 * 这里做两件事：
 * 1. 把栈写到应用私有外存（/sdcard/Android/data/<pkg>/files/crash/），可用文件管理器取出；
 * 2. 直接起一个崩溃界面把栈显示出来，用户照着念或截图即可。
 *
 * 关键细节：主线程抛出未捕获异常后，Looper.loop() 已经退出，主线程不再处理消息，
 * 此时 startActivity 虽然发出去了，新 Activity 的生命周期回调却永远等不到主线程执行。
 * 所以 handler 里要重新进入一次消息循环，崩溃界面才真的能被创建出来。
 */
public final class FoliaCrashHandler {

    private static final String TAG = "FoliaCrashHandler";
    private static volatile boolean installed = false;

    private FoliaCrashHandler() {}

    public static void install(Context context) {
        if (installed) {
            return;
        }
        installed = true;
        final Context appContext = context.getApplicationContext();

        Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
            String trace = stackTraceToString(throwable);
            Log.e(TAG, "Uncaught exception on thread " + thread.getName(), throwable);
            File saved = saveToFile(appContext, trace);
            showCrashScreen(appContext, trace, saved);
            // 主线程已无消息循环，重新进入，否则崩溃界面起不来。
            if (Looper.getMainLooper().getThread() == thread) {
                try {
                    Looper.loop();
                } catch (Throwable reloopError) {
                    Log.e(TAG, "Failed to restart the main looper", reloopError);
                }
            }
        });
    }

    private static void showCrashScreen(Context context, String trace, File saved) {
        try {
            Intent intent = new Intent(context, CrashActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_CLEAR_TASK
                    | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
            intent.putExtra(CrashActivity.EXTRA_TRACE, trace);
            intent.putExtra(CrashActivity.EXTRA_SAVED_PATH,
                    saved == null ? "" : saved.getAbsolutePath());
            context.startActivity(intent);
        } catch (Throwable error) {
            Log.e(TAG, "Failed to launch the crash screen", error);
        }
    }

    private static File saveToFile(Context context, String trace) {
        try {
            File dir = null;
            File external = context.getExternalFilesDir(null);
            if (external != null) {
                dir = new File(external, "crash");
            }
            if (dir == null) {
                dir = new File(context.getFilesDir(), "crash");
            }
            if (!dir.exists() && !dir.mkdirs()) {
                return null;
            }
            String name = "crash-"
                    + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date())
                    + ".log";
            File file = new File(dir, name);
            try (PrintWriter writer = new PrintWriter(new FileWriter(file))) {
                writer.println(deviceInfo());
                writer.println(trace);
            }
            return file;
        } catch (Throwable error) {
            Log.w(TAG, "Failed to write the crash log", error);
            return null;
        }
    }

    private static String deviceInfo() {
        return "Folia crash report"
                + "\n  time      : " + new Date()
                + "\n  device    : " + Build.MANUFACTURER + " " + Build.MODEL
                + "\n  android   : " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")"
                + "\n  abi       : " + java.util.Arrays.toString(Build.SUPPORTED_ABIS)
                + "\n";
    }

    private static String stackTraceToString(Throwable throwable) {
        StringWriter buffer = new StringWriter();
        try (PrintWriter writer = new PrintWriter(buffer)) {
            throwable.printStackTrace(writer);
        }
        return buffer.toString();
    }
}
