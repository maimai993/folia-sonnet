package top.izuna.foliamajor

// 局域网音响投送：SSDP 发现 DLNA / UPnP MediaRenderer，再用 AVTransport 的 SOAP 把
// 当前歌曲的地址交给音响自己播放。WebView 既发不了 UDP 组播、也读不了设备描述 XML，
// 这两步只能放在原生侧；Web 层只负责挑设备、给地址和元数据。

import android.content.Context
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
        private const val MEDIA_RENDERER = "urn:schemas-upnp-org:device:MediaRenderer:1"
        private val SOAP_XML = "text/xml; charset=\"utf-8\"".toMediaType()
    }

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(6, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

    /** 一次发现的结果。controlUrl 已经是绝对地址，Web 层不必再解析设备描述。 */
    private data class Speaker(
        val id: String,
        val name: String,
        val location: String,
        val controlUrl: String,
        val manufacturer: String,
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
                    })
                }
                val payload = JSObject()
                payload.put("devices", devices)
                call.resolve(payload)
            } catch (error: Exception) {
                Log.w(TAG, "discover failed", error)
                call.reject("发现失败：${error.message ?: "unknown"}", error)
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
                val sent = soap(controlUrl, "SetAVTransportURI", setUriBody(audioUrl, metadata))
                    || soap(controlUrl, "SetAVTransportURI", setUriBody(audioUrl, "NOT_IMPLEMENTED"))
                val started = sent && soap(
                    controlUrl,
                    "Play",
                    "<u:Play xmlns:u=\"$AV_TRANSPORT\"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play>",
                )
                if (!started) {
                    call.reject(if (sent) "地址已送出，但音响没有开始播放" else "音响拒绝了这次推送，请确认它支持 DLNA 播放")
                } else {
                    val payload = JSObject()
                    payload.put("ok", true)
                    call.resolve(payload)
                }
            } catch (error: Exception) {
                Log.w(TAG, "play failed", error)
                call.reject("推送失败：${error.message ?: "unknown"}", error)
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
        Thread {
            try {
                val stopped = soap(
                    controlUrl,
                    "Stop",
                    "<u:Stop xmlns:u=\"$AV_TRANSPORT\"><InstanceID>0</InstanceID></u:Stop>",
                )
                val payload = JSObject()
                payload.put("ok", stopped)
                call.resolve(payload)
            } catch (error: Exception) {
                Log.w(TAG, "stop failed", error)
                call.reject("停止失败：${error.message ?: "unknown"}", error)
            }
        }.start()
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
            val request = Request.Builder().url(location).header("User-Agent", "Folia/1.0 UPnP/1.0").build()
            httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@use null
                val body = response.body?.string() ?: return@use null
                val parsed = parseDescription(body)
                val controlPath = parsed.controlUrl ?: return@use null
                val absolute = absoluteUrl(location, controlPath, parsed.urlBase)
                Speaker(
                    id = usn,
                    name = parsed.name.ifEmpty { hostOf(location) },
                    location = location,
                    controlUrl = absolute,
                    manufacturer = parsed.manufacturer,
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

    private fun absoluteUrl(location: String, controlPath: String, urlBase: String): String {
        if (controlPath.startsWith("http://", true) || controlPath.startsWith("https://", true)) return controlPath
        val base = if (urlBase.isNotEmpty()) {
            urlBase
        } else {
            val url = URL(location)
            "${url.protocol}://${url.host}${if (url.port > 0) ":${url.port}" else ""}/"
        }
        return base.trimEnd('/') + "/" + controlPath.trimStart('/')
    }

    private fun hostOf(location: String): String = try {
        URL(location).host
    } catch (error: Exception) {
        location
    }

    // ------------------------------------------------------------------ SOAP

    private fun soap(controlUrl: String, action: String, body: String): Boolean {
        val envelope = "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
            "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">" +
            "<s:Body>$body</s:Body></s:Envelope>"
        val request = Request.Builder()
            .url(controlUrl)
            .header("SOAPACTION", "\"$AV_TRANSPORT#$action\"")
            .header("Content-Type", "text/xml; charset=\"utf-8\"")
            .header("User-Agent", "Folia/1.0 UPnP/1.0")
            .post(envelope.toByteArray(Charsets.UTF_8).toRequestBody(SOAP_XML))
            .build()
        return httpClient.newCall(request).execute().use { response ->
            val text = response.body?.string() ?: ""
            // UPnP 的错误用 500 + SOAP Fault 回，别把「设备收到了但拒绝」当成成功。
            response.isSuccessful && !text.contains("<s:Fault", true) && !text.contains("UPnPError", true)
        }
    }

    private fun setUriBody(audioUrl: String, metadata: String): String =
        "<u:SetAVTransportURI xmlns:u=\"$AV_TRANSPORT\">" +
            "<InstanceID>0</InstanceID>" +
            "<CurrentURI>${escapeXml(audioUrl)}</CurrentURI>" +
            "<CurrentURIMetaData>${escapeXml(metadata)}</CurrentURIMetaData>" +
            "</u:SetAVTransportURI>"

    /** DIDL-Lite 是塞在 XML 文本节点里的，所以整体还要在 setUriBody 里再转义一次。 */
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
