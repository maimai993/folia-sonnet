package top.izuna.foliamajor

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import android.webkit.WebView
import android.widget.Toast

import androidx.appcompat.app.AlertDialog

import java.util.Locale
import java.util.regex.Matcher
import java.util.regex.Pattern

/**
 * 启动时的 WebView 体检与升级引导。
 *
 * 为什么要有它：Folia 的整个界面就是 WebView 里跑的一个现代前端产物（ES2020+ 语法、
 * WebGL2、Intl.Segmenter 分词、ResizeObserver 等）。这些在「系统 WebView」里才有，
 * 而系统 WebView 是独立升级的组件 —— 一台 Android 版本不低的机器，也可能装着 2019 年的
 * WebView，于是表现是开屏后白屏、JS 直接抛 SyntaxError/TypeError，而 App 侧拿不到
 * 任何线索（崩溃处理器抓不到，因为那是 WebView 内部的脚本错误）。
 *
 * 所以它必须做在**原生侧**、在页面加载之后立刻做：只有原生这里能拿到引擎版本，
 * 也只有原生对话框能在页面已经废掉的情况下仍然弹出来。
 *
 * 关于「升级」：Android 不允许应用替用户更新系统组件，没有静默升级这一说。
 * 能做的是把用户送到能更新的地方，按顺序试：
 *   1. `market://details?id=<webview 包>` —— 有 Play 商店的设备直接落到 WebView 详情页；
 *      国内部分厂商商店也注册了 market 协议，同样能接住。
 *   2. `android.settings.WEBVIEW_SETTINGS`（Android 10+）—— 系统自带的 WebView 实现页，
 *      没有商店的设备至少能看到当前用的是哪个实现。
 *   3. Play 网页版 —— 兜底，浏览器打得开就行。
 * 三个都接不住就 Toast 一句，让用户自己找途径。
 */
class WebViewUpgrade private constructor() {

    /**
     * Folia 能正常跑的最低 Chromium 主版本。
     *
     * 定 100 的依据（都是真在用、缺了就整页废掉的）：
     *   - `Intl.Segmenter`：歌词按字素切分，20 多处引用，Chrome 87 才有；
     *   - 顶层 await / `??=`：构建产物的语法基线；
     *   - `AbortSignal.timeout`、CSS `:has()`：Chrome 103 / 105。
     * 低于这个数的 WebView 不是「功能少一点」，而是开屏直接报错，所以按不支持处理。
     * 要放宽或收紧只改这一个常量。
     */
    class Info internal constructor(
        val packageName: String?,
        val versionName: String?,
        /** Chromium 主版本号（如 131），拿不到为 -1。 */
        val major: Int,
        /** 版本是从哪来的：package / user-agent / unknown，日志里好定位。 */
        val source: String?
    ) {
        fun isKnown(): Boolean {
            return major > 0
        }

        /** 未知版本算支持：宁可漏报，也不要把好好的设备拦在门外。 */
        fun isSupported(): Boolean {
            return !isKnown() || major >= MIN_CHROMIUM_MAJOR
        }

        /** 给日志/崩溃报告用的一行描述。 */
        fun describe(): String {
            if (!isKnown()) {
                return "unknown (" + source + ")"
            }
            return String.format(Locale.US, "%d [%s] %s (%s)",
                major, if (isSupported()) "ok" else "too-old",
                if (versionName == null) "?" else versionName,
                if (packageName == null) source else packageName)
        }
    }

    companion object {

        /**
         * Folia 能正常跑的最低 Chromium 主版本。
         *
         * 定 100 的依据（都是真在用、缺了就整页废掉的）：
         *   - `Intl.Segmenter`：歌词按字素切分，20 多处引用，Chrome 87 才有；
         *   - 顶层 await / `??=`：构建产物的语法基线；
         *   - `AbortSignal.timeout`、CSS `:has()`：Chrome 103 / 105。
         * 低于这个数的 WebView 不是「功能少一点」，而是开屏直接报错，所以按不支持处理。
         * 要放宽或收紧只改这一个常量。
         */
        const val MIN_CHROMIUM_MAJOR = 100

        /** 兜底包名：`getCurrentWebViewPackage()` 拿不到时，商店页面至少要指到它。 */
        private const val DEFAULT_WEBVIEW_PACKAGE = "com.google.android.webview"

        /** API 26 以下没有官方查询入口，只能按这几个已知包名挨个试。 */
        private val LEGACY_WEBVIEW_PACKAGES = arrayOf(
            "com.google.android.webview",
            "com.android.webview",
            "com.android.chrome")

        private val CHROME_UA = Pattern.compile("Chrome/(\\d+)")

        private const val TAG = "FoliaWebViewUpgrade"

        @Volatile
        private var prompted = false

        /**
         * 读当前 WebView 的版本。
         *
         * `webView` 可以为空（比如崩溃处理器在 Application 里调用，那时还没建 Bridge），
         * 为空就少了 UA 这一路兜底，只走包名查询。
         *
         * 两路结果取**较大的那个**：个别 ROM 的 WebView 包名 versionName 不是 Chromium 版本号
         * （见过 "10.0.3" 这种），直接拿它当主版本会误判成不支持；而 UA 里那个 Chrome/x
         * 才是真正跑着的引擎，两者不一致时信高的那个。
         */
        @JvmStatic
        fun inspect(context: Context?, webView: WebView?): Info {
            val fromPackage = inspectPackage(context)
            val fromUserAgent = inspectUserAgent(webView)
            if (fromPackage.isKnown() && fromUserAgent.isKnown()) {
                return if (fromPackage.major >= fromUserAgent.major) fromPackage else fromUserAgent
            }
            if (fromPackage.isKnown()) {
                return fromPackage
            }
            if (fromUserAgent.isKnown()) {
                return fromUserAgent
            }
            return Info(null, null, -1, "unknown")
        }

        private fun inspectPackage(context: Context?): Info {
            if (context == null) {
                return Info(null, null, -1, "unknown")
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // API 26+ 的官方入口，返回的就是系统当前选定的那个 WebView 实现。
                val info = WebView.getCurrentWebViewPackage()
                if (info != null) {
                    val major = parseMajor(info.versionName)
                    if (major > 0) {
                        return Info(info.packageName, info.versionName, major, "package")
                    }
                }
                return Info(null, null, -1, "unknown")
            }
            // 低版本只能自己查。这里的 getPackageInfo 只会在 API < 26 上跑到，
            // 所以既不受 Android 11 的包可见性限制，也不会被 API 33 的弃用提示波及。
            val manager = context.packageManager
            if (manager == null) {
                return Info(null, null, -1, "unknown")
            }
            for (pkg in LEGACY_WEBVIEW_PACKAGES) {
                val info: PackageInfo?
                try {
                    info = manager.getPackageInfo(pkg, 0)
                } catch (absent: PackageManager.NameNotFoundException) {
                    continue
                }
                val major = parseMajor(if (info == null) null else info.versionName)
                if (major > 0) {
                    return Info(pkg, info!!.versionName, major, "package")
                }
            }
            return Info(null, null, -1, "unknown")
        }

        private fun inspectUserAgent(webView: WebView?): Info {
            if (webView == null) {
                return Info(null, null, -1, "unknown")
            }
            val userAgent: String?
            try {
                userAgent = webView.settings.userAgentString
            } catch (unusable: Throwable) {
                return Info(null, null, -1, "unknown")
            }
            val major = majorFromUserAgent(userAgent)
            return if (major > 0) Info(null, userAgent, major, "user-agent")
            else Info(null, null, -1, "unknown")
        }

        /** "131.0.6778.39" → 131。取第一段数字，后面的点分位与后缀都不影响判断。 */
        private fun parseMajor(versionName: String?): Int {
            if (versionName == null) {
                return -1
            }
            val text = versionName.trim { it <= ' ' }
            var end = 0
            while (end < text.length && Character.isDigit(text[end])) {
                end += 1
            }
            if (end == 0) {
                return -1
            }
            return try {
                Integer.parseInt(text.substring(0, end))
            } catch (tooLong: NumberFormatException) {
                -1
            }
        }

        private fun majorFromUserAgent(userAgent: String?): Int {
            if (userAgent == null) {
                return -1
            }
            val matcher: Matcher = CHROME_UA.matcher(userAgent)
            if (!matcher.find()) {
                return -1
            }
            return try {
                Integer.parseInt(matcher.group(1)!!)
            } catch (tooLong: NumberFormatException) {
                -1
            }
        }

        /**
         * 启动检查：不支持就弹框并告诉用户去升级。
         *
         * 只在**同一进程内**弹一次 —— 从商店切回来会走 onResume，反复弹就成了骚扰。
         * 返回 true 表示「已判定为不支持并弹了框」，调用方据此决定要不要继续后面的初始化。
         */
        @JvmStatic
        fun check(activity: Activity?, webView: WebView?): Boolean {
            if (activity == null || prompted) {
                return false
            }
            val info = inspect(activity, webView)
            if (info.isSupported()) {
                if (info.isKnown()) {
                    Log.i(TAG, "WebView ok: " + info.describe())
                } else {
                    Log.w(TAG, "WebView version unknown, skipping the gate: " + info.describe())
                }
                return false
            }
            prompted = true
            Log.w(TAG, "WebView too old: " + info.describe())
            showPrompt(activity, info)
            return true
        }

        /** 供外部（以及将来的设置页入口）直接拉起升级流程。 */
        @JvmStatic
        fun prompt(activity: Activity?) {
            if (activity == null) {
                return
            }
            showPrompt(activity, inspect(activity, null))
        }

        private fun showPrompt(activity: Activity, info: Info) {
            if (activity.isFinishing || activity.isDestroyed) {
                return
            }
            val current = if (info.isKnown()) info.major.toString() else "?"
            val message = activity.getString(R.string.webview_upgrade_message,
                MIN_CHROMIUM_MAJOR, current)
            try {
                AlertDialog.Builder(activity, R.style.WebViewUpgradeDialog)
                    .setTitle(R.string.webview_upgrade_title)
                    .setMessage(message)
                    .setCancelable(true)
                    .setPositiveButton(R.string.webview_upgrade_action_update) { dialog, which -> openUpgrade(activity, info) }
                    // 点框外或返回键等于「仍要继续」，不额外拦一道。
                    .setNeutralButton(R.string.webview_upgrade_action_continue, null)
                    .setNegativeButton(R.string.webview_upgrade_action_exit) { dialog, which ->
                        if (!activity.isFinishing) {
                            activity.finish()
                        }
                    }
                    .show()
            } catch (windowGone: Throwable) {
                // Activity 已经在收尾（转屏、被回收）时 show 会抛，记一句就够，别二次崩溃。
                Log.w(TAG, "Failed to show the WebView upgrade dialog", windowGone)
            }
        }

        /**
         * 把用户送到能更新 WebView 的地方。
         *
         * 一路 startActivity 一路 catch：没有能接住的就换下一条，全接不住才 Toast。
         * 这里不用 resolveActivity 预先判断 —— Android 11 起包可见性会让它一律返回 null，
         * 直接 startActivity 反而不受影响。
         */
        private fun openUpgrade(activity: Activity, info: Info) {
            val pkg = if (info.packageName != null && !info.packageName!!.isEmpty())
                info.packageName
            else
                DEFAULT_WEBVIEW_PACKAGE

            val market = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + pkg))
            market.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (start(activity, market)) {
                return
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val settings = Intent(Settings.ACTION_WEBVIEW_SETTINGS)
                settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (start(activity, settings)) {
                    return
                }
            }

            val web = Intent(Intent.ACTION_VIEW,
                Uri.parse("https://play.google.com/store/apps/details?id=" + pkg))
            web.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (start(activity, web)) {
                return
            }

            Toast.makeText(activity.applicationContext,
                R.string.webview_upgrade_no_store, Toast.LENGTH_LONG).show()
        }

        private fun start(activity: Activity, intent: Intent): Boolean {
            return try {
                activity.startActivity(intent)
                true
            } catch (nobodyHandlesIt: ActivityNotFoundException) {
                false
            } catch (notAllowed: SecurityException) {
                false
            }
        }

        /** 崩溃报告里那一行 webview 信息。 */
        @JvmStatic
        fun describe(context: Context?, webView: WebView?): String {
            return inspect(context, webView).describe()
        }
    }
}
