// src/services/onlineMusic/lxmusic/lxRequestGuard.ts
// 音源脚本发出的 HTTP 请求的闸门：只许打公网，不许打本机与内网。
//
// 为什么单独一处：沙箱宿主（lxSourceSandbox.ts）要用它拦脚本的请求，而 lxRuntime.ts 要把它用到
// 自己的请求通路上 —— 两处互相 import 就成环（Dedicatus D301）。放在这里，两边都只依赖这一个文件。
//
// 拦的是「从一段第三方脚本到用户局域网」这条路：本机回环、链路本地（169.254，含云端元数据
// 100.100.100.200 所属的 100.64/10）、私有网段、`.local` / `.internal` / `.lan` 域名，以及不带点
// 的主机名（`router`、`nas` 这种只会解析到局域网）。音源的服务器都在公网上，不受影响。

/** 这个 URL 能不能替音源脚本发出去。 */
export const isAllowedLxRequestUrl = (url: string): boolean => {
    let parsed: URL;
    try {
        parsed = new URL(url.trim());
    } catch {
        return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    // userinfo 里塞 @ 能骗过肉眼检查（http://public@127.0.0.1/），直接不认。
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === '' || host === 'localhost') return false;
    if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) {
        return false;
    }
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        if (a === 0 || a === 127) return false;
        if (a === 10) return false;
        if (a === 169 && b === 254) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 192 && b === 168) return false;
        // 100.64/10：运营商级 NAT，也是云厂商元数据服务所在的段。
        if (a === 100 && b >= 64 && b <= 127) return false;
        return true;
    }
    // IPv6：回环、未指定、链路本地（fe80::/10）、唯一本地地址（fc00::/7）、IPv4 映射都拦。
    if (host.includes(':')) {
        if (host === '::1' || host === '::') return false;
        if (/^fe[89ab][0-9a-f]:/.test(host)) return false;
        if (/^f[cd][0-9a-f]{2}:/.test(host)) return false;
        if (host.startsWith('::ffff:')) return false;
        return true;
    }
    // 其余主机名必须带点（`router` / `nas` 只会解析到局域网）。
    return host.includes('.');
};
