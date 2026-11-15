package top.izuna.foliamajor
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Looper
import android.util.Log

import java.io.File
import java.io.FileWriter
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

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
class FoliaCrashHandler private constructor() {

    companion object {

        private const val TAG = "FoliaCrashHandler"
        @Volatile
        private var installed = false

        @JvmStatic
        fun install(context: Context) {
            if (installed) {
                return
            }
            installed = true
            val appContext = context.applicationContext

            Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
                val trace = stackTraceToString(throwable)
                Log.e(TAG, "Uncaught exception on thread " + thread.name, throwable)
                val saved = saveToFile(appContext, trace)
                showCrashScreen(appContext, trace, saved)
                // 主线程已无消息循环，重新进入，否则崩溃界面起不来。
                if (Looper.getMainLooper().thread === thread) {
                    try {
                        Looper.loop()
                    } catch (reloopError: Throwable) {
                        Log.e(TAG, "Failed to restart the main looper", reloopError)
                    }
                }
            }
        }

        private fun showCrashScreen(context: Context, trace: String, saved: File?) {
            try {
                val intent = Intent(context, CrashActivity::class.java)
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_CLEAR_TASK or
                        Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS)
                intent.putExtra(CrashActivity.EXTRA_TRACE, trace)
                intent.putExtra(CrashActivity.EXTRA_SAVED_PATH,
                        if (saved == null) "" else saved.absolutePath)
                context.startActivity(intent)
            } catch (error: Throwable) {
                Log.e(TAG, "Failed to launch the crash screen", error)
            }
        }

        private fun saveToFile(context: Context, trace: String): File? {
            try {
                var dir: File? = null
                val external = context.getExternalFilesDir(null)
                if (external != null) {
                    dir = File(external, "crash")
                }
                if (dir == null) {
                    dir = File(context.filesDir, "crash")
                }
                if (!dir.exists() && !dir.mkdirs()) {
                    return null
                }
                /*
                 * Kotlin 2.3 收紧了以 `+` 开头的续行解析：它会被读成一元 `+`，
                 * 报 `Unresolved reference 'unaryPlus'`。把 `+` 收进上一行。
                 */
                val name = "crash-" +
                        SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date()) +
                        ".log"
                val file = File(dir, name)
                PrintWriter(FileWriter(file)).use { writer ->
                    writer.println(deviceInfo(context))
                    writer.println(trace)
                }
                return file
            } catch (error: Throwable) {
                Log.w(TAG, "Failed to write the crash log", error)
                return null
            }
        }

        private fun deviceInfo(context: Context): String {
            // 同上：`+` 必须留在上一行行尾（Kotlin 2.3 把行首的 `+` 当一元算符）。
            return "Folia crash report" +
                    "\n  time      : " + Date() +
                    "\n  device    : " + Build.MANUFACTURER + " " + Build.MODEL +
                    "\n  android   : " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")" +
                    "\n  abi       : " + java.util.Arrays.toString(Build.SUPPORTED_ABIS) +
                    // 白屏 / 脚本报错类问题几乎都跟引擎版本有关，写进报告里好横向对比设备。
                    // 这里没有 WebView 实例（可能崩在 Bridge 建起来之前），少一路 UA 兜底无所谓。
                    "\n  webview   : " + WebViewUpgrade.describe(context, null) +
                    "\n"
        }

        private fun stackTraceToString(throwable: Throwable): String {
            val buffer = StringWriter()
            PrintWriter(buffer).use { writer ->
                throwable.printStackTrace(writer)
            }
            return buffer.toString()
        }
    }
}
