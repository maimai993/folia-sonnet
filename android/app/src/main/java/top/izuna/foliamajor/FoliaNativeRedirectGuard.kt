package top.izuna.foliamajor

// test/unit/android/RedirectGuard.kt
//
// M16 的跳转复核判定，抽在插件类外面。
//
// 为什么不在 FoliaNativePlugin 里面：跟着 OkHttp 的那个拦截器一起写在插件类里时，
// 「这一跳能不能跟」这条纯判定既没法在 JVM 单测里单独验（插件类带着 Capacitor 的注解与
// Android 依赖），也不该混在几千行的插件实现里。这里只做字符串与白名单比对，不碰任何
// Android 上下文，也不走 `android.net.Uri`（JVM 单测里那个桩实现什么都解析不出来）。

import java.net.URI
import java.util.Locale

/** 跳转被白名单拦下时交回 JS 的错误前缀（M16）；后面拼上目标主机。 */
const val REDIRECT_NOT_ALLOWED_PREFIX = "redirect not allowed: "

/**
 * 从一条绝对 URL 里取出小写主机名；取不到回空串。
 *
 * 用 `java.net.URI` 而不是 `android.net.Uri`：后者在 JVM 单测里是空的桩，解析结果全是 null，
 * 于是白名单判定永远只看得到「没有主机」。`URI.host` 只接受合法的主机部分，遇到
 * `https://qq.com.attacker.test/x` 这种会如实给出 `qq.com.attacker.test`。
 */
private fun hostOf(nextUrl: String): String {
    val raw = nextUrl.trim()
    if (raw.isEmpty()) return ""
    return try {
        val uri = URI(raw)
        // 有些地址把主机塞在 authority 里但 URI 没认出来（带下划线之类），退回按 authority 切。
        val host = uri.host ?: uri.authority?.substringAfterLast('@')?.substringBefore(':')
        host?.trim()?.trimEnd('.')?.lowercase(Locale.US).orEmpty()
    } catch (error: Exception) {
        ""
    }
}

/**
 * 这一跳能不能继续跟（M16）。
 *
 * 返回 null 表示可以跟（本来就不是 3xx，或目标仍在白名单里）；否则返回交给 JS 的那句拒绝理由
 * （`redirect not allowed: <host>`）。验收标准是「白名单主机 302 到非白名单主机时不跟」，
 * 所以判断依据只有目标主机本身，不看路径、不看 scheme。
 */
fun redirectDenial(status: Int, nextUrl: String, access: FoliaNativeAccess): String? {
    if (status !in 300..399) return null
    val host = hostOf(nextUrl)
    if (host.isEmpty()) return REDIRECT_NOT_ALLOWED_PREFIX
    if (access.isAllowedHost(host)) return null
    return REDIRECT_NOT_ALLOWED_PREFIX + host
}
