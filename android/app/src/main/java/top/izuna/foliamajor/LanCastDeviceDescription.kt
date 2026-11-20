package top.izuna.foliamajor

import android.util.Xml
import org.xmlpull.v1.XmlPullParser
import java.io.StringReader
import java.net.URL

/*
 * 设备描述（device description XML）的解析与地址拼装。
 *
 * 从 FoliaLanCastPlugin 里拆出来：这一段是纯解析 + 准入判定，不碰网络，也不依赖插件实例，
 * 放在单独的文件里既好读也能（对不依赖 android.util.Xml 的部分）在 JVM 上钉住。
 */
internal object LanCastDeviceDescription {

    /** 从设备描述里挑出来的几个字段。 */
    data class Description(
        var name: String = "",
        var manufacturer: String = "",
        var deviceType: String = "",
        var urlBase: String = "",
        var controlUrl: String? = null,
        var volumeControlUrl: String? = null,
    )

    /** 只挑需要的几个元素；嵌套的 embedded device 也一起扫，有些音响把服务挂在子设备下。 */
    fun parse(xml: String): Description {
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
        // 调用方看到 controlUrl 为空会把它丢掉。
        return result
    }

    /**
     * 设备描述里的 controlURL 拼成绝对地址，并做准入。
     *
     * 过去绝对 URL 原样接受：一份伪造的设备描述就能把后续所有 SOAP 指向任意主机。
     * 现在相对路径以设备描述自己的地址（或它声明的 URLBase）为基准，拼完统一过
     * [LanCastTargetPolicy]：局域网、允许端口、且绝对 URL 必须与设备同段。
     * 不合格返回 null，那台设备直接被丢弃（发现列表里不出现）。
     *
     * 日志只记资源名，不记完整地址（issue M24）。
     */
    fun resolveControlUrl(deviceUrl: URL, controlPath: String, urlBase: String): URL? {
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
            android.util.Log.w(
                "FoliaLanCast",
                "rejected control url " + LanCastLogText.controlHint(controlPath) + ": " + error.message,
            )
            null
        }
    }

    /** SSDP 回复是 HTTP 风格的头，键统一小写。 */
    fun parseHeaders(text: String): Map<String, String> {
        val headers = HashMap<String, String>()
        for (line in text.split("\r\n")) {
            val colon = line.indexOf(':')
            if (colon <= 0) continue
            headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
        }
        return headers
    }

    /** 设备描述地址里的主机名；解析不了就退回原串（只用于显示，不外发）。 */
    fun hostOf(location: String): String = try {
        URL(location).host
    } catch (error: Exception) {
        location
    }
}
