package top.izuna.foliamajor

// 局域网音响投送：SSDP 发现 DLNA / UPnP MediaRenderer，再用 AVTransport 的 SOAP 把
// 当前歌曲的地址交给音响自己播放。WebView 既发不了 UDP 组播、也读不了设备描述 XML，
// 这两步只能放在原生侧；Web 层只负责挑设备、给地址和元数据。

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.util.Log
import android.util.Xml
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.xmlpull.v1.XmlPullParser
import java.io.StringReader
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.URL
import java.util.Collections
import java.util.concurrent.TimeUnit

@CapacitorPlugin(name = "FoliaLanCast")
class FoliaLanCastPlugin : Plugin() {

    companion object {
        private const val TAG = "FoliaLanCast"
        private const val AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1"
        private const val RENDERING_CONTROL = "urn:schemas-upnp-org:service:RenderingControl:1"
        // 发现用的 ST 统一放在 LanCastDiscovery 里（策略与报文同源），这里不再各存一份。
        private val SOAP_XML = "text/xml; charset=\"utf-8\"".toMediaType()
    }

    /**
     * 不跟随重定向。
     *
     * 投送用的 POST 带 `SOAPACTION`，过去开着 `followRedirects(true)`：合法设备的一次 302
     * 就能把整条 SOAP 记录（含我们代发的指令）转发到第二跳主机上。UPnP 的控制端口不该
     * 靠重定向做跳转，需要跳的设备自己会在设备描述里给对地址。
     */
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(6, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    /**
     * 只给「回取设备描述」用的 client（issue M21）。
     *
     * 设备描述通常几 KB，2.5s 已经非常宽；把一个不响应的设备绑满 10s 才是「搜音响很慢」的
     * 真正原因。它与 [httpClient] 共用连接池之外的部分各自独立，投送 / 音量那几条仍然用
     * 上面那套更宽松的超时。
     */
    private val fetchClient = OkHttpClient.Builder()
        .connectTimeout(LanCastDiscovery.PER_DEVICE_FETCH_BUDGET_MS.toLong(), TimeUnit.MILLISECONDS)
        .readTimeout(LanCastDiscovery.PER_DEVICE_FETCH_BUDGET_MS.toLong(), TimeUnit.MILLISECONDS)
        .callTimeout(LanCastDiscovery.PER_DEVICE_FETCH_BUDGET_MS.toLong(), TimeUnit.MILLISECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    /** 一次发现的结果。controlUrl 已经是绝对地址，Web 层不必再解析设备描述。 */
    private data class Speaker(
        val id: String,
        val name: String,
        val location: String,
        val controlUrl: String,
        val manufacturer: String,
        /** RenderingControl 的 controlURL；为空表示这台音响不支持手机调音量。 */
        val volumeControlUrl: String? = null,
    )

    /**
     * 一次发现的完整结果：列表 + 「有几台应答了但没读成设备」。
     *
     * 过去没读成的那几台直接从列表里消失，用户只知道「少了一台」，分不清是设备问题还是网络问题
     * （issue M22）。现在至少把被跳过的数量带回界面，日志里另有每台的结论。
     */
    private data class DiscoveryResult(
        val speakers: List<Speaker>,
        val attempted: Int,
        val skipped: Int,
        /** 跳过原因的去重归类（`io/no_answer`、`malformed` …），只用于日志，不含地址。 */
        val skipReasons: List<String>,
    )

    /** 扫一遍局域网里能当播放器的 UPnP 设备。网络操作全部放到后台线程。 */
    @PluginMethod
    fun discover(call: PluginCall) {
        val timeoutMs = call.getInt("timeoutMs", 3200)?.coerceIn(800, 10000) ?: 3200
        Thread {
            try {
                val result = discoverSpeakers(timeoutMs)
                val devices = JSArray()
                for (speaker in result.speakers) {
                    devices.put(JSObject().apply {
                        put("id", speaker.id)
                        put("name", speaker.name)
                        put("location", speaker.location)
                        put("controlUrl", speaker.controlUrl)
                        put("manufacturer", speaker.manufacturer)
                        if (speaker.volumeControlUrl != null) put("volumeControlUrl", speaker.volumeControlUrl)
                    })
                }
                val payload = JSObject()
                payload.put("devices", devices)
                // 应答了但没读成设备的数量：界面据此提示「还有几台没认出来」，而不是静默少几台。
                payload.put("attempted", result.attempted)
                payload.put("skipped", result.skipped)
                deliver(call) { call.resolve(payload) }
            } catch (error: Exception) {
                Log.w(TAG, "discover failed", error)
                deliver(call) { call.reject("发现失败：${error.message ?: "unknown"}", error) }
            }
        }.start()
    }

    /** 把一首歌交给音响：SetAVTransportURI 之后紧接着 Play。 */
    @PluginMethod
    fun play(call: PluginCall) {
        val controlUrl = call.getString("controlUrl")
        val audioUrl = call.getString("url")
        if (controlUrl.isNullOrEmpty() || audioUrl.isNullOrEmpty()) {
            call.reject("缺少音响地址或歌曲地址")
            return
        }
        if (!audioUrl.startsWith("http://", true) && !audioUrl.startsWith("https://", true)) {
            call.reject("这首歌曲没有可在局域网访问的地址")
            return
        }
        // 推之前先过目标准入（见 LanCastTargetPolicy）：伪造的 SSDP 应答会把这里导向任意主机。
        val target = try {
            LanCastTargetPolicy.requireAllowedTarget(controlUrl, "音响地址")
        } catch (error: java.io.IOException) {
            Log.w(TAG, "play target rejected: " + error.message)
            call.reject(error.message ?: "音响地址不在局域网内")
            return
        }
        val title = call.getString("title") ?: ""
        val artist = call.getString("artist") ?: ""
        val album = call.getString("album") ?: ""
        val coverUrl = call.getString("coverUrl") ?: ""
        // 时长用 Long 读：Int 毫秒在 24 天以上的音频上会溢出成负数（issue M23 第 2 点）。
        val durationMs = call.getLong("durationMs") ?: 0L
        // Web 侧认出来的格式（可选）：给了就用它，没给就由原生按 host 已经被 validate 过的地址再认一次。
        val declaredFormat = call.getString("audioFormat")
        Thread {
            try {
                val metadata = didlMetadata(audioUrl, title, artist, album, coverUrl, durationMs, declaredFormat)
                // 有些老设备解析不了 DIDL-Lite，正文送不进去就退成 NOT_IMPLEMENTED 再试一次：
                // 地址照样能播，只是音响上不显示歌名（issue M22 的两次尝试见 LanCastFailures.dispatchUri）。
                val dispatch = LanCastFailures.dispatchUri(
                    setWithMetadata = {
                        soapRaw(
                            target,
                            "SetAVTransportURI",
                            listOf("InstanceID" to "0", "CurrentURI" to audioUrl, "CurrentURIMetaData" to metadata),
                        )
                    },
                    setWithoutMetadata = {
                        soapRaw(
                            target,
                            "SetAVTransportURI",
                            listOf("InstanceID" to "0", "CurrentURI" to audioUrl, "CurrentURIMetaData" to "NOT_IMPLEMENTED"),
                        )
                    },
                )
                val report = LanCastFailures.playReport(dispatch) {
                    soapRaw(target, "Play", listOf("InstanceID" to "0", "Speed" to "1"))
                }
                if (!report.started) {
                    // 失败原因分四种说（连不上 / 设备拒绝 / 响应异常 / 送进去了没起来），
                    // 别把「连不上」也说成「不支持 DLNA」（issue M22）。
                    val message = LanCastFailures.failedReportMessage(report)
                    // 这句已经是脱敏过的话（不含主机与端口），原样进日志供用户反馈时对照。
                    Log.w(TAG, "play did not start: " + message)
                    deliver(call) { call.reject(message) }
                } else {
                    val payload = JSObject()
                    payload.put("ok", true)
                    // 哪些元数据被裁掉了：封面不是 http(s) 时整段不发，音响侧就只有歌名没有图。
                    // 过去这一步是静默的，前端收不到任何「元数据被裁剪」的信号（issue M23 第 3 点）。
                    payload.put("trimmed", trimmedFields(coverUrl, title, artist, album).joinToString(","))
                    // 实际声明的格式：日志与排查要用它解释「为什么这台音响不认无损」。
                    payload.put("protocolInfo", LanCastMetadata.protocolInfo(audioUrl))
                    deliver(call) { call.resolve(payload) }
                }
            } catch (error: Exception) {
                Log.w(TAG, "play failed", error)
                deliver(call) { call.reject("推送失败：${error.message ?: "unknown"}", error) }
            }
        }.start()
    }

    /** 停止音响上的播放（本机播放不受影响）。 */
    @PluginMethod
    fun stop(call: PluginCall) {
        val controlUrl = call.getString("controlUrl")
        if (controlUrl.isNullOrEmpty()) {
            call.reject("缺少音响地址")
            return
        }
        val target = try {
            LanCastTargetPolicy.requireAllowedTarget(controlUrl, "音响地址")
        } catch (error: java.io.IOException) {
            Log.w(TAG, "stop target rejected: " + error.message)
            call.reject(error.message ?: "音响地址不在局域网内")
            return
        }
        Thread {
            try {
                val outcome = soapRaw(target, "Stop", listOf("InstanceID" to "0"))
                val payload = JSObject()
                payload.put("ok", outcome is SoapOutcome.Ok)
                // 没停成时把原因带回去：音响可能已经离线，界面据此说「连不上」而不是「没反应」。
                if (outcome !is SoapOutcome.Ok) payload.put("reason", LanCastFailures.message(outcome))
                deliver(call) { call.resolve(payload) }
            } catch (error: Exception) {
                Log.w(TAG, "stop failed", error)
                deliver(call) { call.reject("停止失败：${error.message ?: "unknown"}", error) }
            }
        }.start()
    }

    /** RenderingControl：读回音响当前音量（0-100）。 */
    @PluginMethod
    fun getVolume(call: PluginCall) {
        val url = call.getString("volumeControlUrl")
        if (url.isNullOrEmpty()) {
            call.reject("这台音响不支持音量控制")
            return
        }
        val target = controlTargetOrNull(url) ?: run {
            call.reject("音响地址不在局域网内")
            return
        }
        Thread {
            try {
                val value = soapNumber(target, "GetVolume", listOf("InstanceID" to "0", "Channel" to "Master"), "CurrentVolume")
                deliver(call) {
                    if (value == null) call.reject("音响没有返回音量")
                    else call.resolve(JSObject().put("volume", value))
                }
            } catch (error: Exception) {
                Log.w(TAG, "getVolume failed", error)
                deliver(call) { call.reject("读取音量失败：${error.message ?: "unknown"}", error) }
            }
        }.start()
    }

    /** RenderingControl：把手机上的音量条映射到音响。 */
    @PluginMethod
    fun setVolume(call: PluginCall) {
        val url = call.getString("volumeControlUrl")
        val volume = call.getInt("volume")?.coerceIn(0, 100)
        if (url.isNullOrEmpty() || volume == null) {
            call.reject("缺少音响地址或音量")
            return
        }
        val target = controlTargetOrNull(url) ?: run {
            call.reject("音响地址不在局域网内")
            return
        }
        Thread {
            try {
                val ok = soap(
                    target,
                    "SetVolume",
                    listOf("InstanceID" to "0", "Channel" to "Master", "DesiredVolume" to volume.toString()),
                )
                deliver(call) { call.resolve(JSObject().put("ok", ok)) }
            } catch (error: Exception) {
                Log.w(TAG, "setVolume failed", error)
                deliver(call) { call.reject("设置音量失败：${error.message ?: "unknown"}", error) }
            }
        }.start()
    }

    /** RenderingControl：静音开关。音量条归零时也走这条路，兼容只读音量的老设备。 */
    @PluginMethod
    fun setMute(call: PluginCall) {
        val url = call.getString("volumeControlUrl")
        if (url.isNullOrEmpty()) {
            call.reject("这台音响不支持静音控制")
            return
        }
        val target = controlTargetOrNull(url) ?: run {
            call.reject("音响地址不在局域网内")
            return
        }
        val muted = call.getBoolean("muted") ?: false
        Thread {
            try {
                val ok = soap(
                    target,
                    "SetMute",
                    listOf("InstanceID" to "0", "Channel" to "Master", "DesiredMute" to (if (muted) "1" else "0")),
                )
                deliver(call) { call.resolve(JSObject().put("ok", ok)) }
            } catch (error: Exception) {
                Log.w(TAG, "setMute failed", error)
                deliver(call) { call.reject("设置静音失败：${error.message ?: "unknown"}", error) }
            }
        }.start()
    }

    /** RenderingControl 的地址也过一次准入；不合格就返回 null（调用方统一 reject）。 */
    private fun controlTargetOrNull(value: String): URL? = try {
        LanCastTargetPolicy.requireAllowedTarget(value, "音量控制地址")
    } catch (error: java.io.IOException) {
        Log.w(TAG, "volume target rejected: " + error.message)
        null
    }

    // ------------------------------------------------------------------ WiFi 自动投送

    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    /**
     * 「监听是否启用」与「网络是否连通」是两件事，必须分开记。
     *
     * 过去两者共用一个事件：unregisterNetworkCallback 会给 callback 合成一次 onLost，
     * 于是「用户关掉自动投送开关」和「WiFi 真断了」走同一条分支，Web 层收到
     * wifi:false 就把正在进行中的投送停掉。现在停监听只清这个标志，不下发任何状态。
     */
    @Volatile
    private var wifiWatchEnabled = false

    /** 上一次推给 Web 层的值；null 表示还没推过。只在 [publishWifiState] 所在的调用里读写。 */
    @Volatile
    private var lastPublishedWifi: Boolean? = null

    /**
     * 插件是否已被销毁。
     *
     * 这个插件持有两类跨调用常驻资源：OkHttpClient（连接池 + dispatcher 线程）和由
     * ConnectivityManager 持有的 NetworkCallback。它们都比插件活得久，Activity 重建之后
     * 旧的回调还会继续往已经销毁的 Bridge 发事件。置真之后所有调用直接 reject，
     * 后台线程也会在 `deliver` 里被静默丢弃，不再碰已失效的 Bridge。
     */
    @Volatile
    private var destroyed = false

    /**
     * 插件实例上线。
     *
     * `destroyed` 是实例字段：Activity 重建时 Capacitor 会新建一个插件实例，
     * 新实例的 load() 必须把标志归零，否则新建的这个一上来就「已销毁」，
     * 所有投送调用都会被静默丢掉。
     */
    override fun load() {
        destroyed = false
        super.load()
    }

    /**
     * 插件销毁时调用的收尾：注销网络监听、断开在途连接、关掉 OkHttp。
     *
     * 为什么要在这里收：这个插件持有两类跨调用常驻资源。NetworkCallback 由系统持有，
     * 过去唯一的注销点是 setWifiAutoCast(false)（只能等 Web 层主动下发）；OkHttpClient
     * 的连接池与 dispatcher 线程则是进程级对象，过去完全没有关闭点。Activity 销毁后
     * 两者都还活着，旧回调继续往已销毁的 Bridge 发事件。
     */
    override fun handleOnDestroy() {
        destroyed = true
        // 先停监听：unregisterNetworkCallback 会对 callback 合成一次 onLost，
        // stopWifiWatch 里的 enabled 标志保证这次合成事件不会继续下发。
        stopWifiWatch()
        try {
            httpClient.dispatcher.cancelAll()
            httpClient.connectionPool.evictAll()
            httpClient.dispatcher.executorService.shutdown()
            // 回取描述那个 client 也要收：它有自己的线程池与连接池（issue M21）。
            fetchClient.dispatcher.cancelAll()
            fetchClient.connectionPool.evictAll()
            fetchClient.dispatcher.executorService.shutdown()
        } catch (error: Exception) {
            Log.w(TAG, "release http client failed", error)
        }
        super.handleOnDestroy()
    }

    /**
     * 把结果交回 Web 层，但插件已销毁时什么都不做。
     *
     * 这些 resolve/reject 大多跑在自己起的后台线程上（发现、推送各有 4~6 秒），
     * Activity 在这期间销毁就会碰到已失效的 Bridge —— 逐处判断太容易漏，统一收在这里。
     */
    private fun deliver(call: PluginCall, action: () -> Unit) {
        if (destroyed) return
        try {
            action()
        } catch (error: Exception) {
            Log.w(TAG, "deliver to web failed", error)
        }
    }

    /** 打开/关闭「连上 WiFi 自动投送」的原生网络监听。 */
    @PluginMethod
    fun setWifiAutoCast(call: PluginCall) {
        val enabled = call.getBoolean("enabled") ?: false
        if (enabled) startWifiWatch() else stopWifiWatch()
        deliver(call) { call.resolve() }
    }

    /** 前端刚挂载时用它确认当前是不是已经在 WiFi 上。 */
    @PluginMethod
    fun getWifiState(call: PluginCall) {
        deliver(call) { call.resolve(JSObject().put("wifi", isOnWifi())) }
    }

    /**
     * 当前「是不是在 WiFi 上」的真相来源。
     *
     * 只问 activeNetwork 的 transport 与连通性，不看 Wi-Fi 开关：关掉开关但设备已经切到
     * 别的可用网络（例如有线 / 另一个 WiFi）时，interface 列表里并没有「断网」这件事，
     * 投送该不该断由「还有没有可用网络」决定，不由开关状态决定。
     */
    private fun isOnWifi(): Boolean {
        val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return false
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
    }

    private fun startWifiWatch() {
        if (destroyed) return
        wifiWatchEnabled = true
        if (networkCallback != null) return
        val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .build()
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                publishWifiState()
            }

            override fun onLost(network: Network) {
                // onLost 的语义只是「这个 network 不再匹配请求」，网络迁移、重建、active
                // network 切换都会触发它，此时设备可能仍在 WiFi 上。所以这里同样现查
                // isOnWifi() 取真相，而不是照着回调类型下发布尔值。
                publishWifiState()
            }

            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                publishWifiState()
            }
        }
        try {
            cm.registerNetworkCallback(request, callback)
            networkCallback = callback
            // 注册后立刻同步一次：冷启动时页面挂载晚于网络就绪，不主动推一次的话
            // Web 层要等到下一次网络变化才收到事件（表现为「开了自动投送但连上 WiFi 没反应」）。
            publishWifiState()
        } catch (error: Exception) {
            Log.w(TAG, "register network callback failed", error)
        }
    }

    private fun stopWifiWatch() {
        // 先关闸：unregisterNetworkCallback 会给 callback 合成一次 onLost，
        // 若不加这个标志，用户关掉开关就会被当成「断网」下发一次 wifi:false，
        // Web 层收到立刻终止正在进行中的投送 —— 与用户意图相反。
        wifiWatchEnabled = false
        val callback = networkCallback ?: return
        val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        try {
            cm?.unregisterNetworkCallback(callback)
        } catch (error: Exception) {
            Log.w(TAG, "unregister network callback failed", error)
        }
        networkCallback = null
    }

    /**
     * 把当前的 WiFi 连通状态推给 Web 层。
     *
     * 判据统一是 isOnWifi()，而不是回调类型：回调只是「有事发生了」的提示，
     * 真相要现查。另外只在状态真的变了才下发 —— 网络在 WiFi 之间迁移时
     * onLost/onAvailable 会连着来，逐条转发的做法会让 Web 层重复触发自动投送。
     */
    private fun publishWifiState() {
        if (!wifiWatchEnabled || destroyed) return
        val current = isOnWifi()
        val previous = lastPublishedWifi ?: run {
            // 冷启动第一次同步：无论值是什么都要报，让 Web 层拿到初值。
            lastPublishedWifi = current
            emitWifiState(current)
            return
        }
        if (current == previous) return
        lastPublishedWifi = current
        emitWifiState(current)
    }

    private fun emitWifiState(onWifi: Boolean) {
        Log.i(TAG, "wifi cast state -> " + onWifi)
        notifyListeners("wifiCastChange", JSObject().put("wifi", onWifi))
    }

    // ------------------------------------------------------------------ SSDP

    /** 拿住 MulticastLock，否则不少 ROM 会直接把组播包丢掉，表现为「一台都搜不到」。 */
    private fun discoverSpeakers(timeoutMs: Int): DiscoveryResult {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val lock = wifi?.createMulticastLock("foliaLanCast")
        lock?.setReferenceCounted(false)
        try {
            lock?.acquire()
            val socket = DatagramSocket(null as java.net.SocketAddress?)
            socket.reuseAddress = true
            socket.bind(InetSocketAddress(0))
            socket.soTimeout = 350
            // 收缓冲显式设大：2048 装不下某些设备的长 USN + 多个头，截断后变成畸形应答，
            // 设备就静默丢了（issue M21）。缓冲数组也只建一次，不再每轮新建。
            socket.receiveBufferSize = LanCastDiscovery.RECEIVE_BUFFER_BYTES
            val started = System.currentTimeMillis()
            val capture = socket.use {
                // 发什么、等多久、什么时候停都在 LanCastDiscovery 里（issue M21）。
                LanCastDiscovery.capture(
                    socket = it,
                    timeoutMs = timeoutMs,
                    onAllowedLocation = ::isAllowedLocation,
                    logWarn = { message, error -> if (error == null) Log.w(TAG, message) else Log.w(TAG, message, error) },
                )
            }
            val replies = capture.replies
            /*
             * 每台应答的设备单独给结论：读成了就进列表，没读成也记下原因（issue M22）。
             * 过去是一句 mapNotNull，没读成的设备从列表里消失、日志里只有异常，
             * 用户分不清是设备问题还是网络问题。
             */
            val candidates = replies.entries.distinctBy { it.value }
            // 回取描述要受预算约束：一台不响应的设备过去能把「搜音响」拖到十几秒（issue M21）。
            val budgetMs = LanCastDiscovery.fetchBudgetMs(
                timeoutMs = timeoutMs,
                elapsedMs = System.currentTimeMillis() - started,
            )
            val reads = fetchDescriptions(candidates, budgetMs)
            val speakers = reads.mapNotNull { it.speaker }
            val skipReasons = reads.filter { it.speaker == null }.map { it.failure }
            Log.i(
                TAG,
                "discovery: answered=" + candidates.size + " listed=" + speakers.size +
                    " skipped=" + skipReasons.size +
                    " rounds=" + capture.rounds +
                    (if (skipReasons.isEmpty()) "" else " reasons=" + skipReasons.distinct().joinToString(",")),
            )
            return DiscoveryResult(
                speakers = speakers.distinctBy { it.controlUrl },
                attempted = candidates.size,
                skipped = skipReasons.size,
                skipReasons = skipReasons.distinct(),
            )
        } finally {
            try {
                lock?.release()
            } catch (error: Exception) {
                Log.w(TAG, "release multicast lock failed", error)
            }
        }
    }

    /** 应答里的 LOCATION 是否落在局域网内（判据见 LanCastTargetPolicy）。 */
    private fun isAllowedLocation(location: String): Boolean = try {
        LanCastTargetPolicy.requireAllowedTarget(location, "设备地址")
        true
    } catch (error: java.io.IOException) {
        // 应答地址只记网段：完整地址含局域网 IP 与端口（issue M24）。
        Log.w(TAG, "ignored SSDP reply from a non-LAN location: " + LanCastLogText.deviceHint(location) + " " + error.message)
        false
    }

    /**
     * 有并发上限、有整体预算地把设备描述取回来（issue M21）。
     *
     * 过去这里是串行的 `mapNotNull { readSpeaker(...) }`：每台设备连接 4s / 读 6s，一台不响应
     * 就能让整次发现拖十几秒。现在按 [LanCastDiscovery.fetchConcurrency] 并发，超过预算的设备
     * 直接按「超时」跳过 —— 宁可少列一台，也不让用户盯着转圈。
     *
     * 返回顺序与 [candidates] 一致（并发不改变列表顺序，免得设备列表每次刷新都重排）。
     */
    private fun fetchDescriptions(
        candidates: List<Map.Entry<String, String>>,
        budgetMs: Long,
    ): List<ReadResult> {
        if (candidates.isEmpty()) return emptyList()
        val results = arrayOfNulls<ReadResult>(candidates.size)
        val deadline = System.currentTimeMillis() + budgetMs
        val pool = java.util.concurrent.Executors.newFixedThreadPool(
            LanCastDiscovery.fetchConcurrency(candidates.size),
        ) { runnable ->
            Thread(runnable, "foliaLanCast-fetch").apply { isDaemon = true }
        }
        try {
            val futures = candidates.mapIndexed { index, (usn, location) ->
                pool.submit {
                    results[index] = if (System.currentTimeMillis() >= deadline) {
                        // 预算已经用光：没轮到的设备按超时处理，不再排一次连接。
                        ReadResult(null, "budget-exhausted")
                    } else {
                        readSpeaker(usn, location)
                    }
                }
            }
            futures.forEach { future ->
                // 单台设备的等待也不能超过总预算。
                val waitMs = (deadline - System.currentTimeMillis()).coerceAtLeast(0L)
                try {
                    future.get(waitMs, java.util.concurrent.TimeUnit.MILLISECONDS)
                } catch (timeout: java.util.concurrent.TimeoutException) {
                    future.cancel(true)
                } catch (error: Exception) {
                    Log.w(TAG, "description fetch interrupted", error)
                }
            }
        } finally {
            pool.shutdownNow()
        }
        return candidates.indices.map { index ->
            // 被取消或抛错的槽位补一个「超时」，保证与 candidates 一一对应。
            results[index] ?: ReadResult(null, "budget-exhausted")
        }
    }

    /**
     * 一台设备读设备描述的结论。
     *
     * 为什么不是 `Speaker?`：没读成的原因要分开记（连不上 / 答了但不是 MediaRenderer /
     * 描述畸形），否则「少了一台」在界面上与「网络问题」混成同一件事（issue M22）。
     */
    private data class ReadResult(val speaker: Speaker?, val failure: String)

    /** GET 设备描述，确认它真的是 MediaRenderer 并取出 AVTransport 的 controlURL。 */
    private fun readSpeaker(usn: String, location: String): ReadResult {
        return try {
            val deviceUrl = LanCastTargetPolicy.requireAllowedTarget(location, "设备地址")
            val request = Request.Builder().url(deviceUrl).header("User-Agent", "Folia/1.0 UPnP/1.0").build()
            /*
             * 回取描述用自己的超时，而不是共享 client 那套 4s / 6s。
             *
             * 设备描述通常几 KB，2.5s 已经非常宽；把一个不响应的设备绑满 10s 才是「搜音响很慢」
             * 的真正原因（issue M21）。共享 client 的超时对播放 / 音量那几条调用仍然合适。
             */
            fetchClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    Log.w(TAG, "read description failed: " + LanCastLogText.deviceHint(location) + " http=" + response.code)
                    return ReadResult(null, "http-" + response.code)
                }
                val body = response.body?.string()
                if (body.isNullOrBlank()) {
                    Log.w(TAG, "read description failed: " + LanCastLogText.deviceHint(location) + " empty body")
                    return ReadResult(null, "empty-body")
                }
                val parsed = LanCastDeviceDescription.parse(body)
                val controlPath = parsed.controlUrl
                if (controlPath == null) {
                    // 每台 NAS / 打印机也会回 ssdp:all，它们没有 AVTransport：这不算错误，单独记。
                    Log.i(TAG, "skip device without AVTransport: " + LanCastLogText.deviceHint(location))
                    return ReadResult(null, "no-avtransport")
                }
                val absolute = LanCastDeviceDescription.resolveControlUrl(deviceUrl, controlPath, parsed.urlBase)
                if (absolute == null) return ReadResult(null, "control-url-rejected")
                ReadResult(
                    Speaker(
                        id = usn,
                        name = parsed.name.ifEmpty { LanCastDeviceDescription.hostOf(location) },
                        location = location,
                        controlUrl = absolute.toString(),
                        manufacturer = parsed.manufacturer,
                        volumeControlUrl = parsed.volumeControlUrl
                            ?.let { LanCastDeviceDescription.resolveControlUrl(deviceUrl, it, parsed.urlBase)?.toString() },
                    ),
                    failure = "",
                )
            }
        } catch (error: Exception) {
            // 只记网段与资源名：完整地址含局域网 IP 与端口，能拼出用户的网络拓扑（issue M24）。
            // 异常本身照原样交出去（调用栈要靠它），首行之外仍是能定位的那点信息。
            Log.w(TAG, "read description failed: " + LanCastLogText.deviceHint(location), error)
            ReadResult(null, LanCastFailures.discoveryFailureLabel(error))
        }
    }


    // ------------------------------------------------------------------ SOAP

    /**
     * 结构化构造 SOAP 请求：动作名 + 参数表，转义由这里统一做。
     *
     * 过去正文是调用方拼好的字符串，`soapRaw` 原样塞进信封 —— 任何一个新动作方法漏用
     * escapeXml 就是一个 XML 注入（歌名、地址全都来自外部数据）。现在调用方只给键值对，
     * 拼装与转义只有这一处实现。
     */
    private fun soapRaw(
        controlUrl: URL,
        action: String,
        args: List<Pair<String, String>>,
        service: String = AV_TRANSPORT,
    ): SoapOutcome {
        val body = StringBuilder("<u:").append(action).append(" xmlns:u=\"").append(service).append("\">")
        for ((key, value) in args) {
            body.append('<').append(key).append('>')
                .append(escapeXml(value))
                .append("</").append(key).append('>')
        }
        body.append("</u:").append(action).append('>')
        val envelope = "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
            "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">" +
            "<s:Body>${body}</s:Body></s:Envelope>"
        val request = Request.Builder()
            .url(controlUrl)
            .header("SOAPACTION", "\"$service#$action\"")
            .header("Content-Type", "text/xml; charset=\"utf-8\"")
            .header("User-Agent", "Folia/1.0 UPnP/1.0")
            .post(envelope.toByteArray(Charsets.UTF_8).toRequestBody(SOAP_XML))
            .build()
        /*
         * 三种失败在这里分开，交给调用方与界面（issue M22）：连不上、设备明确拒绝、响应异常。
         * 过去它们全折成一个 null，界面于是只有一句「请确认它支持 DLNA」。
         */
        var status = 0
        var responseBody = ""
        val outcome = try {
            httpClient.newCall(request).execute().use { response ->
                status = response.code
                responseBody = response.body?.string() ?: ""
                LanCastFailures.classify(response.code, responseBody)
            }
        } catch (error: Exception) {
            // 网络层的问题（超时、拒绝连接、DNS）不是「设备拒绝」，如实归类。
            LanCastFailures.classify(0, "", error)
        }
        if (outcome !is SoapOutcome.Ok) {
            // 不成功的那一路，正文是设备自己的错误说明（UPnP 错误码 / 认证页），记下来才能对照音响手册排查。
            // 成功的正文不记：RenderingControl 的回包里是音量值。
            Log.w(TAG, "soap " + action + " -> " + LanCastFailures.label(outcome) + " http=" + status +
                " body=" + LanCastLogText.bodySnippet(responseBody))
        }
        return outcome
    }

    /** 只回答「成没成」的调用方：判据是设备接受（Ok）。 */
    private fun soap(
        controlUrl: URL,
        action: String,
        args: List<Pair<String, String>>,
        service: String = AV_TRANSPORT,
    ): Boolean = soapRaw(controlUrl, action, args, service) is SoapOutcome.Ok

    /** GetVolume 的响应形如 <CurrentVolume>42</CurrentVolume>，命名空间前缀各家不一样。 */
    private fun soapNumber(controlUrl: URL, action: String, args: List<Pair<String, String>>, tag: String): Int? {
        val outcome = soapRaw(controlUrl, action, args, RENDERING_CONTROL)
        val text = (outcome as? SoapOutcome.Ok)?.body ?: return null
        val pattern = Regex("<(?:[A-Za-z0-9_]+:)?$tag[^>]*>\\s*([0-9]+)\\s*</", RegexOption.IGNORE_CASE)
        return pattern.find(text)?.groupValues?.get(1)?.toIntOrNull()
    }

    /** DIDL-Lite 是塞在 XML 文本节点里的，所以整段会由 soapRaw 再转义一次。 */
    private fun didlMetadata(
        audioUrl: String,
        title: String,
        artist: String,
        album: String,
        coverUrl: String,
        durationMs: Long,
        declaredFormat: String? = null,
    ): String {
        val duration = LanCastMetadata.duration(durationMs)
        val art = if (isStreamableCover(coverUrl)) {
            "<upnp:albumArtURI>${escapeXml(coverUrl)}</upnp:albumArtURI>"
        } else ""
        val albumPart = if (album.isNotEmpty()) "<upnp:album>${escapeXml(album)}</upnp:album>" else ""
        // 格式按实际地址声明：写死 MP3 会让按 protocolInfo 选解码器的音响拒播无损源（issue M23）。
        val format = if (!declaredFormat.isNullOrEmpty()) {
            LanCastMetadata.Format.entries.firstOrNull { it.name.equals(declaredFormat, ignoreCase = true) }
                ?: LanCastMetadata.formatOf(audioUrl)
        } else {
            LanCastMetadata.formatOf(audioUrl)
        }
        val protocolInfo = LanCastMetadata.protocolInfoFor(format)
        return "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" " +
            "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" " +
            "xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\">" +
            "<item id=\"folia-0\" parentID=\"-1\" restricted=\"1\">" +
            "<dc:title>${escapeXml(title)}</dc:title>" +
            "<dc:creator>${escapeXml(artist)}</dc:creator>" +
            albumPart +
            "<upnp:class>object.item.audioItem.musicTrack</upnp:class>" +
            art +
            "<res duration=\"$duration\" protocolInfo=\"$protocolInfo\">${escapeXml(audioUrl)}</res>" +
            "</item></DIDL-Lite>"
    }

    /** 封面只有 http(s) 地址音响才拿得到；blob: / data: / 本地路径发了也只是个死链。 */
    private fun isStreamableCover(coverUrl: String): Boolean = coverUrl.startsWith("http://", true) ||
        coverUrl.startsWith("https://", true)

    /** 被裁掉的元数据字段，与 didlMetadata 的规则一一对应。 */
    private fun trimmedFields(coverUrl: String, title: String, artist: String, album: String): List<String> {
        val trimmed = ArrayList<String>(4)
        if (!isStreamableCover(coverUrl.trim())) trimmed.add("cover")
        if (title.isBlank()) trimmed.add("title")
        if (artist.isBlank()) trimmed.add("artist")
        if (album.isBlank()) trimmed.add("album")
        return trimmed
    }

    private fun escapeXml(value: String): String = value
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")
        .replace("'", "&apos;")
}
