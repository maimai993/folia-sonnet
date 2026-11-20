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
        private const val SSDP_ADDRESS = "239.255.255.250"
        private const val SSDP_PORT = 1900
        private const val AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1"
        private const val RENDERING_CONTROL = "urn:schemas-upnp-org:service:RenderingControl:1"
        private const val MEDIA_RENDERER = "urn:schemas-upnp-org:device:MediaRenderer:1"
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

    /** 扫一遍局域网里能当播放器的 UPnP 设备。网络操作全部放到后台线程。 */
    @PluginMethod
    fun discover(call: PluginCall) {
        val timeoutMs = call.getInt("timeoutMs", 3200)?.coerceIn(800, 10000) ?: 3200
        Thread {
            try {
                val speakers = discoverSpeakers(timeoutMs)
                val devices = JSArray()
                for (speaker in speakers) {
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
        val durationMs = call.getInt("durationMs", 0) ?: 0
        Thread {
            try {
                val metadata = didlMetadata(audioUrl, title, artist, album, coverUrl, durationMs)
                // 有些老设备解析不了 DIDL-Lite，正文送不进去就退成 NOT_IMPLEMENTED 再试一次：
                // 地址照样能播，只是音响上不显示歌名。
                val sent = soap(
                    target,
                    "SetAVTransportURI",
                    listOf("InstanceID" to "0", "CurrentURI" to audioUrl, "CurrentURIMetaData" to metadata),
                ) || soap(
                    target,
                    "SetAVTransportURI",
                    listOf("InstanceID" to "0", "CurrentURI" to audioUrl, "CurrentURIMetaData" to "NOT_IMPLEMENTED"),
                )
                val started = sent && soap(
                    target,
                    "Play",
                    listOf("InstanceID" to "0", "Speed" to "1"),
                )
                if (!started) {
                    deliver(call) { call.reject(if (sent) "地址已送出，但音响没有开始播放" else "音响拒绝了这次推送，请确认它支持 DLNA 播放") }
                } else {
                    val payload = JSObject()
                    payload.put("ok", true)
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
                val stopped = soap(target, "Stop", listOf("InstanceID" to "0"))
                val payload = JSObject()
                payload.put("ok", stopped)
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
    private fun discoverSpeakers(timeoutMs: Int): List<Speaker> {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val lock = wifi?.createMulticastLock("foliaLanCast")
        lock?.setReferenceCounted(false)
        try {
            lock?.acquire()
            val replies = Collections.synchronizedMap(LinkedHashMap<String, String>())
            val socket = DatagramSocket(null as java.net.SocketAddress?)
            socket.reuseAddress = true
            socket.bind(InetSocketAddress(0))
            socket.soTimeout = 350
            socket.use {
                val target = InetSocketAddress(InetAddress.getByName(SSDP_ADDRESS), SSDP_PORT)
                val searches = listOf(MEDIA_RENDERER, "urn:schemas-upnp-org:service:AVTransport:1", "ssdp:all")
                val started = System.currentTimeMillis()
                var round = 0
                while (System.currentTimeMillis() - started < timeoutMs) {
                    // 多播包本身不保证送达，隔一小会儿重发一次，比只发一轮稳得多。
                    val search = searches[round % searches.size].toByteArray(Charsets.UTF_8)
                    val probe = buildSearch(search)
                    val packet = DatagramPacket(probe, probe.size, target.address, target.port)
                    try {
                        it.send(packet)
                    } catch (error: Exception) {
                        Log.w(TAG, "SSDP send failed", error)
                    }
                    round += 1
                    val until = System.currentTimeMillis() + 400
                    while (System.currentTimeMillis() < until) {
                        val buffer = ByteArray(2048)
                        val incoming = DatagramPacket(buffer, buffer.size)
                        try {
                            it.receive(incoming)
                            val text = String(incoming.data, 0, incoming.length, Charsets.UTF_8)
                            val headers = parseHeaders(text)
                            val location = headers["location"] ?: continue
                            /*
                             * LOCATION 先过一次准入再拿去 GET。
                             *
                             * SSDP 应答是明文 UDP、没有认证：同网段任何设备都能回一份把
                             * LOCATION 指向公网地址的假应答。照着它去 GET 就已经是一次出站请求
                             * （SSRF 的第一跳），所以在发出任何请求之前就挡掉。
                             */
                            if (!isAllowedLocation(location)) continue
                            val usn = headers["usn"] ?: location
                            if (!replies.containsKey(usn)) replies[usn] = location
                        } catch (timeout: java.net.SocketTimeoutException) {
                            // 本轮没有更多回复，继续等下一轮重发。
                        } catch (error: Exception) {
                            Log.w(TAG, "SSDP receive failed", error)
                        }
                    }
                }
            }
            return replies.entries.distinctBy { it.value }.mapNotNull { (usn, location) ->
                readSpeaker(usn, location)
            }.distinctBy { it.controlUrl }
        } finally {
            try {
                lock?.release()
            } catch (error: Exception) {
                Log.w(TAG, "release multicast lock failed", error)
            }
        }
    }

    private fun buildSearch(target: ByteArray): ByteArray {
        val head = "M-SEARCH * HTTP/1.1\r\n" +
            "HOST: $SSDP_ADDRESS:$SSDP_PORT\r\n" +
            "MAN: \"ssdp:discover\"\r\n" +
            "MX: 2\r\n" +
            "ST: "
        val headBytes = head.toByteArray(Charsets.UTF_8)
        val tail = "\r\n\r\n".toByteArray(Charsets.UTF_8)
        return headBytes + target + tail
    }

    /** 应答里的 LOCATION 是否落在局域网内（判据见 LanCastTargetPolicy）。 */
    private fun isAllowedLocation(location: String): Boolean = try {
        LanCastTargetPolicy.requireAllowedTarget(location, "设备地址")
        true
    } catch (error: java.io.IOException) {
        Log.w(TAG, "ignored SSDP reply from a non-LAN location: " + error.message)
        false
    }

    /** SSDP 回复是 HTTP 风格的头，键统一小写。 */
    private fun parseHeaders(text: String): Map<String, String> {
        val headers = HashMap<String, String>()
        for (line in text.split("\r\n")) {
            val colon = line.indexOf(':')
            if (colon <= 0) continue
            headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
        }
        return headers
    }

    /** GET 设备描述，确认它真的是 MediaRenderer 并取出 AVTransport 的 controlURL。 */
    private fun readSpeaker(usn: String, location: String): Speaker? {
        return try {
            val deviceUrl = LanCastTargetPolicy.requireAllowedTarget(location, "设备地址")
            val request = Request.Builder().url(deviceUrl).header("User-Agent", "Folia/1.0 UPnP/1.0").build()
            httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@use null
                val body = response.body?.string() ?: return@use null
                val parsed = parseDescription(body)
                val controlPath = parsed.controlUrl ?: return@use null
                val absolute = resolveControlUrl(deviceUrl, controlPath, parsed.urlBase) ?: return@use null
                Speaker(
                    id = usn,
                    name = parsed.name.ifEmpty { hostOf(location) },
                    location = location,
                    controlUrl = absolute.toString(),
                    manufacturer = parsed.manufacturer,
                    volumeControlUrl = parsed.volumeControlUrl
                        ?.let { resolveControlUrl(deviceUrl, it, parsed.urlBase)?.toString() },
                )
            }
        } catch (error: Exception) {
            Log.w(TAG, "read description failed: $location", error)
            null
        }
    }

    private data class Description(
        var name: String = "",
        var manufacturer: String = "",
        var deviceType: String = "",
        var urlBase: String = "",
        var controlUrl: String? = null,
        var volumeControlUrl: String? = null,
    )

    /** 只挑需要的几个元素；嵌套的 embedded device 也一起扫，有些音响把服务挂在子设备下。 */
    private fun parseDescription(xml: String): Description {
        val result = Description()
        val parser = Xml.newPullParser()
        parser.setInput(StringReader(xml))
        var inService = false
        var serviceType = ""
        var eventType = parser.eventType
        while (eventType != XmlPullParser.END_DOCUMENT) {
            if (eventType == XmlPullParser.START_TAG) {
                when (parser.name) {
                    "friendlyName" -> result.name = parser.nextText().trim()
                    "manufacturer" -> result.manufacturer = parser.nextText().trim()
                    "deviceType" -> result.deviceType = parser.nextText().trim()
                    "URLBase" -> result.urlBase = parser.nextText().trim()
                    "service" -> { inService = true; serviceType = "" }
                    "serviceType" -> if (inService) serviceType = parser.nextText().trim()
                    "controlURL" -> {
                        val path = parser.nextText().trim()
                        if (inService && serviceType.startsWith("urn:schemas-upnp-org:service:AVTransport") && result.controlUrl == null) {
                            result.controlUrl = path
                        }
                        if (inService && serviceType.startsWith("urn:schemas-upnp-org:service:RenderingControl") && result.volumeControlUrl == null) {
                            result.volumeControlUrl = path
                        }
                    }
                }
            } else if (eventType == XmlPullParser.END_TAG && parser.name == "service") {
                inService = false
            }
            eventType = parser.next()
        }
        // MediaServer（比如 NAS）也会回 ssdp:all，但它没有 AVTransport；
        // readSpeaker 会因为没有 controlURL 直接把它丢掉。
        return result
    }

    /**
     * 设备描述里的 controlURL 拼成绝对地址，并做准入。
     *
     * 过去绝对 URL 原样接受：一份伪造的设备描述就能把后续所有 SOAP 指向任意主机。
     * 现在相对路径以设备描述自己的地址（或它声明的 URLBase）为基准，拼完统一过
     * [LanCastTargetPolicy]：局域网、允许端口、且绝对 URL 必须与设备同段。
     * 不合格返回 null，那台设备直接被丢弃（发现列表里不出现）。
     */
    private fun resolveControlUrl(deviceUrl: URL, controlPath: String, urlBase: String): URL? {
        return try {
            val raw = if (controlPath.startsWith("http://", true) || controlPath.startsWith("https://", true)) {
                controlPath
            } else {
                val base = if (urlBase.isNotEmpty()) urlBase else {
                    "${deviceUrl.protocol}://${deviceUrl.host}${if (deviceUrl.port > 0) ":${deviceUrl.port}" else ""}/"
                }
                base.trimEnd('/') + "/" + controlPath.trimStart('/')
            }
            val target = LanCastTargetPolicy.requireAllowedTarget(raw, "控制地址")
            LanCastTargetPolicy.requireSameLanAs(target, deviceUrl)
            target
        } catch (error: Exception) {
            Log.w(TAG, "rejected control url $controlPath: " + error.message)
            null
        }
    }

    private fun hostOf(location: String): String = try {
        URL(location).host
    } catch (error: Exception) {
        location
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
    ): String? {
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
        return httpClient.newCall(request).execute().use { response ->
            val text = response.body?.string() ?: ""
            // UPnP 的错误用 500 + SOAP Fault 回，别把「设备收到了但拒绝」当成成功。
            if (response.isSuccessful && !text.contains("<s:Fault", true) && !text.contains("UPnPError", true)) text else null
        }
    }

    private fun soap(
        controlUrl: URL,
        action: String,
        args: List<Pair<String, String>>,
        service: String = AV_TRANSPORT,
    ): Boolean = soapRaw(controlUrl, action, args, service) != null

    /** GetVolume 的响应形如 <CurrentVolume>42</CurrentVolume>，命名空间前缀各家不一样。 */
    private fun soapNumber(controlUrl: URL, action: String, args: List<Pair<String, String>>, tag: String): Int? {
        val text = soapRaw(controlUrl, action, args, RENDERING_CONTROL) ?: return null
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
        durationMs: Int,
    ): String {
        val duration = if (durationMs > 0) {
            val total = durationMs / 1000
            String.format("%02d:%02d:%02d", total / 3600, (total % 3600) / 60, total % 60)
        } else "00:00:00"
        val art = if (coverUrl.startsWith("http", true)) {
            "<upnp:albumArtURI>${escapeXml(coverUrl)}</upnp:albumArtURI>"
        } else ""
        val albumPart = if (album.isNotEmpty()) "<upnp:album>${escapeXml(album)}</upnp:album>" else ""
        return "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" " +
            "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" " +
            "xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\">" +
            "<item id=\"folia-0\" parentID=\"-1\" restricted=\"1\">" +
            "<dc:title>${escapeXml(title)}</dc:title>" +
            "<dc:creator>${escapeXml(artist)}</dc:creator>" +
            albumPart +
            "<upnp:class>object.item.audioItem.musicTrack</upnp:class>" +
            art +
            "<res duration=\"$duration\" protocolInfo=\"http-get:*:audio/mpeg:DLNA.ORG_PN=MP3\">${escapeXml(audioUrl)}</res>" +
            "</item></DIDL-Lite>"
    }

    private fun escapeXml(value: String): String = value
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")
        .replace("'", "&apos;")
}
