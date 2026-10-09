/**
 * src/utils/secureApiBase.ts
 *
 * 把明文后端的地址在「必须加密的页面」里升级成 https。
 *
 * 为什么需要这个：Capacitor Android 的页面跑在 `https://localhost` 上，向 `http://...`
 * 发请求属于混合内容，WebView 会直接拦掉 —— 而且拦掉的方式是让 `fetch` 抛一个
 * `TypeError: Failed to fetch`。这个错误跟「后端挂了」「DNS 不通」「CORS 没配」
 * 长得一模一样，光看日志根本分不出来，线上排查要花很久。
 *
 * 只对「页面本身已经是 https」的情况生效：那一刻明文请求无论如何都不可能成功，
 * 升级最多是把一个必然失败的请求换成可能成功的，不会把本来能用的配置改坏。
 * 回环地址（Electron 内嵌服务、本机调试）是安全上下文，明文照旧放行。
 */

/** 安全上下文里允许明文的地址：Electron 内嵌服务与本机调试都落在这些主机名上。 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0:0:0:0:0:0:0:1']);

const isSecurePage = (): boolean => {
    if (typeof window === 'undefined' || !window.location) return false;
    return String(window.location.protocol || '').toLowerCase() === 'https:';
};

/**
 * 需要升级时返回 https 版本，否则原样返回。
 *
 * 端口一并丢掉：自托管的明文服务常挂在 8080 / 3000 这类端口上，而同域的 https
 * 入口几乎总在默认端口（本项目的 `http://host:8080/kugou` ↔ `https://host/kugou`
 * 就是这种）。留着 8080 去连 https 只会换来一次必然的握手失败。
 */
export const upgradeInsecureApiBase = (base: string): string => {
    const value = String(base ?? '').trim();
    if (!/^http:\/\//i.test(value) || !isSecurePage()) return value;
    try {
        const parsed = new URL(value);
        if (LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return value;
        const path = parsed.pathname.replace(/\/+$/, '');
        return `https://${parsed.hostname}${path}`;
    } catch {
        // 解析不了（相对路径之类）就别动，交给调用方按原样使用。
        return value;
    }
};
