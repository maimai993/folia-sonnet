package top.izuna.foliamajor

import java.io.IOException
import java.net.URL
import java.util.Collections
import java.util.HashMap
import java.util.LinkedHashMap
import java.util.UUID

// 远端资源注册表：凭据绑定精确 origin，回环 token 不包含 URL/凭据，也不跨注册复用。
internal class RemoteAudioRegistry {
    class Entry(val url: String, headers: Map<String, String>?) {
        val headers: Map<String, String> = if (headers == null) Collections.emptyMap()
        else Collections.unmodifiableMap(HashMap(headers))

        fun allowsRedirects(): Boolean {
            // 不让带自定义头的请求由 HTTP 客户端自动把凭据带往重定向目标。
            return headers.isEmpty()
        }
    }

    private val entries: MutableMap<String, Entry> = LinkedHashMap()

    fun register(url: String, headers: Map<String, String>?): String {
        val token = UUID.randomUUID().toString()
        entries[token] = Entry(url, headers)
        while (entries.size > 128) entries.remove(entries.keys.iterator().next())
        return token
    }

    fun registerReusable(url: String, headers: Map<String, String>?): String {
        val snapshot: Map<String, String> = if (headers == null) Collections.emptyMap() else headers
        var existing: String? = null
        for (registered in entries.entries) {
            val entry = registered.value
            if (entry.url == url && entry.headers == snapshot) {
                existing = registered.key
                break
            }
        }
        if (existing != null) {
            val entry = entries.remove(existing)!!
            entries[existing] = entry
            return existing
        }
        return register(url, headers)
    }

    fun get(token: String): Entry? {
        return entries[token]
    }

    fun remove(token: String) {
        entries.remove(token)
    }

    companion object {
        @Throws(IOException::class)
        fun validateOrigin(value: String, credentialOrigin: String) {
            val target = URL(value)
            val origin = URL(credentialOrigin)
            if (!("http" == target.protocol || "https" == target.protocol)
                || target.host.isEmpty() || target.userInfo != null || origin.userInfo != null
                || target.protocol != origin.protocol
                || !target.host.equals(origin.host, ignoreCase = true)
                || effectivePort(target) != effectivePort(origin)
                || !(origin.path.isEmpty() || "/" == origin.path)
                || origin.query != null || origin.ref != null) {
                throw IOException("Remote resource origin mismatch")
            }
        }

        private fun effectivePort(url: URL): Int {
            return if (url.port == -1) url.defaultPort else url.port
        }
    }
}
