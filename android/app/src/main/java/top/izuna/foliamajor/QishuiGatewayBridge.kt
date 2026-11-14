package top.izuna.foliamajor

import android.util.Log

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 汽水签名宿主给**播放服务**用的静态入口。
 *
 * 为什么要有它：原生兜底切歌（FoliaPlaybackService.skipViaMirror）跑在服务里，
 * 而 QishuiSignHost 活在 FoliaQishuiPlugin 手里、还依赖 MainActivity —— 两个世界
 * 互不认识。汽水的取流地址与歌词都必须过那个隐藏 WebView 里的签名页面
 * （bdms.js），所以服务这边只能通过这个桥把 request 送进宿主。
 *
 * 生命周期：宿主由 FoliaQishuiPlugin 在第一次用时创建、注册进来；dispose 时注销。
 * MainActivity 没了（用户把 App 从最近任务划掉）之后宿主拿不到页面，request 会
 * 走到超时 —— 也就是说**汽水的原生兜底只在 App 还活着时可用**（进程被前台服务
 * 顶着、Activity 只是退到后台的情形都算活着），这点与其它平台的纯 HTTP 网关不同，
 * 是签名必须由真页面来算这一件事决定的，不是偷懒。
 *
 * 线程：requestSync 设计为在后台线程调（网关的所有出口都在后台线程上）；
 * request 本身只是发一条 evaluateJavascript，结果由页面的回调带回，
 * CountDownLatch 负责把它变成同步等。
 */
class QishuiGatewayBridge private constructor() {
    companion object {
        private const val TAG = "QishuiGatewayBridge"

        @Volatile
        private var registeredHost: QishuiSignHost? = null

        @JvmStatic
        fun registerHost(host: QishuiSignHost?) {
            registeredHost = host
        }

        @JvmStatic
        fun unregisterHost(host: QishuiSignHost?) {
            if (registeredHost === host) {
                registeredHost = null
            }
        }

        /**
         * 同步要一个 operation 的结果（信封 JSON 字符串），拿不到回 null。
         *
         * 超时由调用方定：取流地址给 12 秒（签名页正常两三秒内回话），别把切歌
         * 卡在一个可能永远不回的票据上 —— 宿主自己还有 45 秒的兜底，这里提前
         * 撤退只意味着「这首歌没换成」，不会漏掉任何回调。
         */
        @JvmStatic
        fun requestSync(operation: String, paramsJson: String?, timeoutMs: Long): String? {
            val host = registeredHost
            if (host == null) {
                Log.i(TAG, "no registered host; " + operation + " is unavailable")
                return null
            }
            val latch = CountDownLatch(1)
            val result = arrayOfNulls<String>(1)
            try {
                host.request(operation, paramsJson) { json ->
                    result[0] = json
                    latch.countDown()
                }
            } catch (error: Throwable) {
                Log.w(TAG, "request " + operation + " failed to hand off", error)
                return null
            }
            try {
                if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
                    Log.i(TAG, "request " + operation + " timed out after " + timeoutMs + " ms")
                    return null
                }
            } catch (error: InterruptedException) {
                Thread.currentThread().interrupt()
                return null
            }
            return result[0]
        }

        /**
         * 把带 #auth= 的加密直链换成 loopback 解密代理地址（QishuiAudioServer）。
         * 服务器没起 / 没有宿主时回空串，调用方按「拿不到可播地址」处理。
         */
        @JvmStatic
        fun audioProxyUrlFor(cleanUrl: String?, auth: String?): String {
            val host = registeredHost
            return if (host == null) "" else host.audioProxyUrlFor(cleanUrl, auth)
        }
    }
}
