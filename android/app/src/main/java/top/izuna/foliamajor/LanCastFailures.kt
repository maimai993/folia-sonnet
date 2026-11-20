package top.izuna.foliamajor

import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.URI
import java.net.UnknownHostException

/**
 * 一次 SOAP 调用的结局，以及怎么把它说成一句用户能据此行动的话（issue M22）。
 *
 * 为什么需要它：过去 `soapRaw` 只回答「成功 / 失败」，三种完全不同的失败 —— 音响明确拒绝
 * （500 + SOAP Fault）、根本连不上（断电、不在同一网络）、答了但不是我们认得的 SOAP ——
 * 全都折成一个 `null`，`play` 再折成一个布尔值，界面于是只有一句「音响拒绝了这次推送，
 * 请确认它支持 DLNA」。音响断电的用户照着这句去换音响，方向完全错了。
 *
 * 这里的规矩：
 *  - 一份响应同时命中多条时，按「设备确实答复了」优先：设备明确拒绝 / 响应异常 → 再谈连不上；
 *  - UPnP 的错误码原样带出来（`701 Transition not available` 这种对得上说明书），
 *    不认识的码照样保留数字 —— 前向兼容靠的就是「不认识也照实说」，而不是吞掉；
 *  - 用户可见文案里**不放**设备的主机与端口（那是用户的网络信息，见 issue M24），
 *    需要地址的排查走日志。
 *
 * 纯 JVM：接收一个已经拆分好的响应（状态行 + 正文），不碰 OkHttp 与 Android，单测能逐条核对。
 */
internal sealed class SoapOutcome {

    /** 设备接受了这次调用。响应正文里有 GetCurrentVolume 那种带值的节点时由调用方自己再解析。 */
    data class Ok(val body: String) : SoapOutcome()

    /** 设备答复了，而且明确拒绝：HTTP 非 2xx，或正文里带 SOAP Fault / UPnPError。 */
    data class Rejected(val httpStatus: Int, val upnpCode: Int?, val upnpDescription: String?) : SoapOutcome()

    /** 设备答复了，但内容不是一次正常的 SOAP 回复（空正文、解析不了、状态码说不通）。 */
    data class Malformed(val httpStatus: Int) : SoapOutcome()

    /** 连不上：断电、不在同一网络、端口关了、等不到答复。 */
    data class Unreachable(val cause: UnreachableCause) : SoapOutcome()

    /** 没走到设备：我们自己判定的问题（地址不合法、缺参数）。原文已经是可以给用户看的话。 */
    data class Unusable(val reason: String) : SoapOutcome()

    /**
     * 地址已经送进音响、音响也没报错，但播放没起来。
     *
     * 单独一态：这句要说的是「音响收到地址了，只是没开始播」，和「没送到」是两回事
     * —— 用户该做的是在音响一侧看看是否被暂停、被别的输入源占用，而不是去查网络。
     */
    data class SentButNotStarted(val play: SoapOutcome) : SoapOutcome()
}

/** 连不上的几种成因。给用户的话不一样，但都不是「请确认它支持 DLNA」。 */
internal enum class UnreachableCause {
    /** 地址解析不出来（主机名打错、mDNS 没解析到）。 */
    UNKNOWN_HOST,

    /** 连不上 / 等不到答复：端口关了、音响断电、不在同一网段。 */
    NO_ANSWER,

    /** 网络本身不可达。 */
    NO_ROUTE,
}

/** 「SetAVTransportURI 送进去之后，Play 有没有起来」的三态；只有前两态配说「地址已送出」。 */
internal enum class PlayDispatch {
    STARTED,
    SENT_NOT_STARTED,
    FAILED,
}

/** 一次投送里 `SetAVTransportURI` 的结论 + 失败时的成因，交给 [LanCastFailures.playReport]。 */
internal data class UriDispatch(val dispatch: PlayDispatch, val failure: SoapOutcome? = null)

internal object LanCastFailures {

    /**
     * SetAVTransportURI 的结局。
     *
     * 两条路：先送带 DIDL 的完整元数据；设备不认（明确拒绝或响应异常）再退成
     * `NOT_IMPLEMENTED` —— 很多老设备只认这种写法，地址照样能播，只是音响上不显示歌名。
     * 两次都是连不上就别再重试第二次了：网络没通的情况下第二发必然也是连不上，
     * 只是让用户多等一个连接超时。
     */
    fun dispatchUri(setWithMetadata: () -> SoapOutcome, setWithoutMetadata: () -> SoapOutcome): UriDispatch {
        val first = setWithMetadata()
        if (first is SoapOutcome.Ok) return UriDispatch(PlayDispatch.SENT_NOT_STARTED)
        // 连不上：第二发必然也是连不上，只是让用户多等一个连接超时 —— 不再重试。
        if (first is SoapOutcome.Unreachable) return UriDispatch(PlayDispatch.FAILED, first)
        val second = setWithoutMetadata()
        if (second is SoapOutcome.Ok) return UriDispatch(PlayDispatch.SENT_NOT_STARTED)
        // 两次都没送进去：把第二次的成因带出去（设备依旧拒绝 / 依旧答不上来）。
        // 两次成因不同时以第一次为准：第一次是「设备明确拒绝」才触发了第二次尝试，那才是主因。
        val cause = if (second is SoapOutcome.Unreachable) second else first
        return UriDispatch(PlayDispatch.FAILED, cause)
    }

    /** 交给界面的整个 `play` 的结局：两态（播起来了 / 没播起来）+ 失败时的原因。 */
    data class PlayReport(val started: Boolean, val failure: SoapOutcome? = null)

    /** `play` 的整体判定：先看 SetAVTransportURI，再在必要时看 Play。 */
    fun playReport(dispatched: UriDispatch, playCall: () -> SoapOutcome): PlayReport = when (dispatched.dispatch) {
        PlayDispatch.STARTED -> PlayReport(started = true)
        PlayDispatch.SENT_NOT_STARTED -> {
            val played = playCall()
            when {
                played is SoapOutcome.Ok -> PlayReport(started = true)
                // 设备在、也没报错，只是没开始播：这跟「没送出去」不是一回事，
                // 换个地址重试也不会好，别照搬「连不上」的话。
                played is SoapOutcome.Unreachable || played is SoapOutcome.Unusable -> PlayReport(started = false, failure = played)
                else -> PlayReport(started = false, failure = SoapOutcome.SentButNotStarted(played))
            }
        }
        // 地址根本没送进去：成因由会话层带上来（连不上 / 设备拒绝 / 响应异常），别一概说成「设备拒绝」。
        PlayDispatch.FAILED -> PlayReport(started = false, failure = dispatched.failure)
    }

    /**
     * 把一次 SOAP 响应读成结局。
     *
     * @param httpStatus HTTP 状态码；0 表示没拿到响应（IOException 那一路）。
     * @param body 响应正文；空正文在 2xx 下算「响应异常」—— UI 控制端点的正常回包不会是空的。
     * @param transport 网络层抛出来的异常，没有就 null。
     */
    fun classify(httpStatus: Int, body: String, transport: Throwable? = null): SoapOutcome {
        if (transport != null) return SoapOutcome.Unreachable(causeOf(transport))
        if (httpStatus <= 0) return SoapOutcome.Unreachable(UnreachableCause.NO_ANSWER)
        val fault = findUpnpError(body)
        if (httpStatus in 200..299) {
            // 有的设备用 200 回一个 SOAP Fault，判据看正文而不是状态码。
            if (fault != null) return SoapOutcome.Rejected(httpStatus, fault.first, fault.second)
            if (body.isBlank()) return SoapOutcome.Malformed(httpStatus)
            return SoapOutcome.Ok(body)
        }
        if (fault != null) return SoapOutcome.Rejected(httpStatus, fault.first, fault.second)
        // 4xx/5xx 但正文不是 SOAP Fault：设备在，但答的不是一次控制调用能理解的东西
        // （认证页、反向代理的错误页、404）。这也**不是**「不支持 DLNA」。
        return SoapOutcome.Malformed(httpStatus)
    }

    /** 网络异常归到哪一种「连不上」。 */
    fun causeOf(error: Throwable): UnreachableCause {
        var current: Throwable? = error
        var guard = 0
        while (current != null && guard < 8) {
            when (current) {
                is UnknownHostException -> return UnreachableCause.UNKNOWN_HOST
                // NoRouteToHostException 是 SocketException 的子类，必须排在它前面。
                is NoRouteToHostException -> return UnreachableCause.NO_ROUTE
                is ConnectException,
                is SocketTimeoutException,
                is java.net.SocketException -> return UnreachableCause.NO_ANSWER
            }
            current = current.cause
            guard += 1
        }
        return UnreachableCause.NO_ANSWER
    }

    /** UPnP 的错误码与说明；没有 SOAP Fault 就返回 null。`<errorCode>701</errorCode>` 各家前缀不一样。 */
    fun findUpnpError(body: String): Pair<Int?, String?>? {
        if (!body.contains("Fault", ignoreCase = true) && !body.contains("UPnPError", ignoreCase = true)) return null
        val code = Regex("<(?:[A-Za-z0-9_]+:)?errorCode[^>]*>\\s*(-?[0-9]+)\\s*</", RegexOption.IGNORE_CASE)
            .find(body)?.groupValues?.get(1)?.toIntOrNull()
        val description = Regex("<(?:[A-Za-z0-9_]+:)?errorDescription[^>]*>([^<]*)</", RegexOption.IGNORE_CASE)
            .find(body)?.groupValues?.get(1)?.trim()?.takeIf { it.isNotEmpty() }
        return code to description
    }

    /**
     * 用户可见的那句话。
     *
     * 四种成因四句话；「设备拒绝」把 UPnP 的错误码与说明带出来（音响的口径比我们的猜测准），
     * 不认识的新错误码也照实显示数字，不退回含糊的「不支持 DLNA」。
     */
    fun message(outcome: SoapOutcome): String = when (outcome) {
        is SoapOutcome.Ok -> ""
        is SoapOutcome.Unusable -> outcome.reason
        is SoapOutcome.Unreachable -> when (outcome.cause) {
            UnreachableCause.UNKNOWN_HOST -> "找不到这台音响的地址，请重新搜索后确认它还在同一个 WiFi"
            UnreachableCause.NO_ANSWER -> "连不上这台音响：请确认它已开机、和手机在同一个 WiFi"
            UnreachableCause.NO_ROUTE -> "网络不可达：请检查手机当前连接的网络"
        }
        is SoapOutcome.Malformed -> "音响的回复看不懂（HTTP ${outcome.httpStatus}），可能不是标准的 DLNA 设备"
        is SoapOutcome.Rejected -> {
            val code = outcome.upnpCode
            val detail = outcome.upnpDescription
            when {
                code != null && detail != null -> "音响拒绝了这次推送（UPnP $code：$detail）"
                code != null -> "音响拒绝了这次推送（UPnP $code）"
                else -> "音响拒绝了这次推送（HTTP ${outcome.httpStatus}）"
            }
        }
        is SoapOutcome.SentButNotStarted -> when (val play = outcome.play) {
            // 设备对 Play 明确回了错：那句 UPnP 原因照样有用（例如 701 传输不可用 → 音响被别的输入源占着）。
            is SoapOutcome.Rejected, is SoapOutcome.Malformed -> "音响收到了地址，但没有开始播放：" + message(play)
            else -> "音响收到了地址，但没有开始播放：请在音响上确认它没被暂停、也没有被别的输入源占用"
        }
    }

    /**
     * `play` 失败时整句话。
     *
     * 和 [message] 的区别在语义层级：这里拿到的是整个 play 的结论，所以「地址已送出但没播起来」
     * 能单独说清楚；连不上 / 设备拒绝的时刻用同一套成因判定。
     */
    fun failedReportMessage(report: PlayReport): String {
        if (report.started) return ""
        // 没拿到更细的结论（SetAVTransportURI 的三种写法都没送进去）：保留原来的兜底文案。
        val failure = report.failure ?: return "音响拒绝了这次推送，请确认它支持 DLNA 播放"
        return message(failure)
    }

    /** 记日志用的短标签：排查时一眼能分出是「连不上」还是「设备明确拒绝」。 */
    fun label(outcome: SoapOutcome): String = when (outcome) {
        is SoapOutcome.Ok -> "ok"
        is SoapOutcome.Unusable -> "unusable"
        is SoapOutcome.Unreachable -> "unreachable/" + outcome.cause.name.lowercase()
        is SoapOutcome.Malformed -> "malformed/" + outcome.httpStatus
        is SoapOutcome.Rejected -> "rejected/" + (outcome.upnpCode?.toString() ?: "http-" + outcome.httpStatus)
        is SoapOutcome.SentButNotStarted -> "sent-not-started/" + label(outcome.play)
    }

    /**
     * 地址里能不能看出「这台设备还在不在」：只记网段（见 [LanCastLogText.hostHint]），
     * 别把主机与端口写进日志（issue M24）。
     */
    fun targetHint(raw: String?): String {
        if (raw.isNullOrBlank()) return "无地址"
        return try {
            LanCastLogText.hostHint(URI(raw).host)
        } catch (error: Exception) {
            "无法解析的地址（${raw.length} 字符）"
        }
    }

    /** 探设备描述失败时的分类标签（发现阶段用），同样只记结论不记地址。 */
    fun discoveryFailureLabel(error: Throwable?): String = when {
        error == null -> "unknown"
        error is IOException -> "io/" + causeOf(error).name.lowercase()
        else -> "malformed"
    }
}
