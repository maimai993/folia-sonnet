package top.izuna.foliamajor.keepalive

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * 后台保活体检：电池优化白名单 + 各家 ROM 的自启动 / 耗电管理页。
 *
 * 为什么需要这一层：播放靠前台服务（[top.izuna.foliamajor.FoliaPlaybackService]）撑着，
 * 而国内 ROM 在「省电」这件事上默认比 AOSP 激进得多 —— 前台服务照样可能在息屏几分钟后
 * 被冻结、被切断网络、被清出内存。它们各自的开关（自启动、后台弹出、耗电管理里的
 * 「允许后台运行」）**没有统一 API**，只能把用户送到对应的设置页，让用户自己点。
 *
 * 这里只做两件事：
 *   1. 读「本应用是否已在电池优化白名单里」——这一条 AOSP 有标准 API，可读可请求；
 *   2. 猜各家的自启动 / 耗电页并跳过去 —— 纯尽力而为，猜错就退回应用详情页。
 *
 * 刻意不做的事：不静默申请任何权限（除了系统自己的对话框），不改系统设置，
 * 不常驻任何轮询。所有方法都是「用户点一下才跑一次」。
 */
object KeepAlive {

    /** 自启动 / 允许后台启动。 */
    const val TARGET_AUTOSTART = "autostart"

    /** 耗电管理 / 电池优化。 */
    const val TARGET_BATTERY = "battery"

    /** 应用详情页：一定存在的那一页，所有跳转的最后兜底。 */
    const val TARGET_DETAILS = "details"

    /**
     * 本应用是否已被排除在电池优化之外。
     *
     * 这一条不是「能不能后台播放」的充分条件（国产 ROM 还有自己的一套），
     * 但它是**唯一可读的**那一条：读不出来就只能靠用户回忆自己点过什么。
     */
    @JvmStatic
    fun isIgnoringBatteryOptimizations(context: Context?): Boolean {
        if (context == null) {
            return false
        }
        return try {
            val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
                ?: return false
            power.isIgnoringBatteryOptimizations(context.packageName)
        } catch (error: Throwable) {
            // 部分精简 ROM 把 PowerManager 的服务名改掉了：读不到就当没授权。
            false
        }
    }

    /**
     * 弹系统自己的「是否允许后台运行」对话框。
     *
     * 用系统对话框而不是直接跳列表页：对话框只有一步，用户点「允许」就完事，
     * 而列表页要用户自己在一长串应用里找到我们，再找对那一条。
     *
     * @return 是否真的把对话框/列表页打开了（false = 这台机器上两条路都不通，
     *         调用方应当退回 [open] 的 `battery` 目标，或干脆只显示文字引导）。
     */
    @JvmStatic
    fun requestIgnoreBatteryOptimizations(context: Context?): Boolean {
        if (context == null) {
            return false
        }
        /*
         * 已经是白名单了就别再弹：系统对话框在「已授权」时仍会弹出来，用户会以为自己
         * 的操作没生效，反复点。
         */
        if (isIgnoringBatteryOptimizations(context)) {
            return true
        }
        try {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            intent.data = Uri.parse("package:" + context.packageName)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            return true
        } catch (error: Throwable) {
            // 少数 ROM 删掉了这个 action，退到「电池优化」列表页。
        }
        return openBatteryOptimizationList(context)
    }

    /**
     * 跳到各家 ROM 的设置页。
     *
     * @param target [TARGET_AUTOSTART] / [TARGET_BATTERY] / [TARGET_DETAILS]
     * @return 实际跳去的目标（可能不是你要的那个 —— 猜不中就退到详情页）。
     *         前端拿它来决定提示语：跳到了详情页，就该把「再点哪里」写得更细。
     */
    @JvmStatic
    fun open(context: Context?, target: String?): String {
        if (context == null) {
            return TARGET_DETAILS
        }
        when (target) {
            TARGET_AUTOSTART -> {
                if (openFirstResolvable(context, autostartCandidates())) {
                    return TARGET_AUTOSTART
                }
            }
            TARGET_BATTERY -> {
                if (openFirstResolvable(context, batteryCandidates())) {
                    return TARGET_BATTERY
                }
                if (openBatteryOptimizationList(context)) {
                    return TARGET_BATTERY
                }
            }
        }
        openDetails(context)
        return TARGET_DETAILS
    }

    /**
     * ROM 标签，直接显示给用户（"MIUI 14" / "ColorOS 14" / "HarmonyOS"）。
     *
     * 只用于**文案**：告诉用户「你这台是 MIUI，要去安全中心 → 应用管理 → 权限 → 自启动」，
     * 比一句「请开启自启动权限」有用得多。判断不出来就返回空串，前端不显示那一段。
     */
    @JvmStatic
    fun romLabel(): String {
        val brand = (Build.BRAND ?: "").lowercase()
        val manufacturer = (Build.MANUFACTURER ?: "").lowercase()
        return when {
            brand.contains("xiaomi") || brand.contains("redmi") || brand.contains("poco") ->
                if (Build.VERSION.SDK_INT >= 34 && manufacturer.contains("xiaomi")) "HyperOS" else "MIUI"
            brand.contains("huawei") || brand.contains("honor") -> "EMUI"
            brand.contains("oppo") || brand.contains("oneplus") || brand.contains("realme") -> "ColorOS"
            brand.contains("vivo") || brand.contains("iqoo") -> "OriginOS"
            brand.contains("samsung") -> "One UI"
            brand.contains("meizu") -> "Flyme"
            else -> ""
        }
    }

    /**
     * 自启动 / 允许后台启动的候选页。
     *
     * 全是猜的：同一个厂商不同代、不同机型都可能改名。**猜错没有代价** ——
     * 每个候选先 `resolveActivity` 验一次，验不过就换下一个，最后有详情页兜底。
     * 所以这里宁可多列几个过时的，也不要漏掉当下在用的那个。
     */
    private fun autostartCandidates(): Array<Array<String>> = arrayOf(
        // 小米 / Redmi / POCO：安全中心 → 应用管理 → 权限 → 自启动
        arrayOf("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
        // 华为 / 荣耀：手机管家 → 应用启动管理
        arrayOf("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
        arrayOf("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"),
        // vivo / iQOO：i 管家 → 应用管理 → 权限管理 → 自启动
        arrayOf("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
        arrayOf("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"),
        // OPPO / 一加 / realme：手机管家 → 权限隐私 → 自启动管理
        arrayOf("com.oplus.safecenter", "com.oplus.safecenter.permission.startup.StartupAppListActivity"),
        arrayOf("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
        arrayOf("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
        // 一加（老版氢 OS）
        arrayOf("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"),
        // 三星：设备维护 → 电池 → 后台使用限制
        arrayOf("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"),
        arrayOf("com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity"),
        // 魅族：手机管家 → 权限管理 → 后台运行
        arrayOf("com.meizu.safe", "com.meizu.safe.security.SHOW_APPSEC"),
    )

    /**
     * 耗电管理 / 电池优化的候选页。
     *
     * 小米那一页要两个 extra 才会**直接落在本应用上**（否则只是打开「应用配置」列表）。
     * extras 传了但页面不认也没关系：它只是被忽略，页面照样打开。
     */
    private fun batteryCandidates(): Array<Array<String>> = arrayOf(
        arrayOf("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity"),
        arrayOf("com.huawei.systemmanager", "com.huawei.systemmanager.powerui.HwPowerManagerActivity"),
        arrayOf("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"),
        arrayOf("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.PowerManagerActivity"),
        arrayOf("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
        arrayOf("com.oplus.battery", "com.oplus.powermanager.fuelgaue.PowerUsageModelActivity"),
        arrayOf("com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity"),
        arrayOf("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"),
    )

    private fun openBatteryOptimizationList(context: Context): Boolean {
        return try {
            val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        } catch (error: Throwable) {
            false
        }
    }

    private fun openDetails(context: Context): Boolean {
        return try {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            intent.data = Uri.parse("package:" + context.packageName)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        } catch (error: Throwable) {
            false
        }
    }

    /**
     * 按顺序试每个候选，第一个能解析出来的就跳过去。
     *
     * 带上 `package_name` / `package_label`：小米的耗电配置页靠这两个 extra 直接定位到
     * 本应用，不带就只是打开一个列表。对不认这两个 extra 的页面来说它们是无害的。
     */
    private fun openFirstResolvable(context: Context, candidates: Array<Array<String>>): Boolean {
        val manager = context.packageManager
        val label = try {
            val info = manager.getApplicationInfo(context.packageName, 0)
            manager.getApplicationLabel(info).toString()
        } catch (error: Throwable) {
            "Folia"
        }
        for (candidate in candidates) {
            try {
                val intent = Intent()
                intent.setClassName(candidate[0], candidate[1])
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                intent.putExtra("package_name", context.packageName)
                intent.putExtra("package_label", label)
                if (intent.resolveActivity(manager) == null) {
                    continue
                }
                context.startActivity(intent)
                return true
            } catch (error: Throwable) {
                // 这个候选不在本机器上（或没有权限跳）：换下一个。
            }
        }
        return false
    }
}
