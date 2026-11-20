/**
 * 读取响应里的 Set-Cookie。
 *
 * `Set-Cookie` 是浏览器禁止暴露给 JS 的响应头（Fetch 规范里的 forbidden response-header name）。
 * 桥这条路上它有两个来源：
 *   - 浏览器 / 扩展能用的 `headers.getSetCookie()`，以及扩展页面里能直接读到的 `Set-Cookie`；
 *   - 安卓桥从**桥这一侧**交出来的那份原始值：它记在响应对象的一个符号属性上（见
 *     src/services/nativeAndroidBridge.ts 的 nativeRawSetCookies），页面脚本经 Response 的
 *     头永远读不到，只有这一段桥自己的代码能看见（M1）。
 *
 * 少了这条通路，扫码登录只能从 cookie 罐里回捞 qrsig / p_skey，而罐里可能是上一次会话留下的旧值 ——
 * 表现就是新建的二维码第一次轮询就「已失效」。
 */

/** 桥那一侧挂原始 Set-Cookie 用的键（桥接层与这里共用）。 */
export const NATIVE_RAW_SET_COOKIES = Symbol.for('folia.native.rawSetCookies');

/** 原始 Set-Cookie 头值（可能一条里含多个 cookie，调用方负责拆分）。 */
export function readRawSetCookies(resp) {
    const list = [];
    if (!resp) return list;
    // 桥那一侧的那一份：页面脚本拿不到，只有桥自己的代码能看到（M1）。
    try {
        const bridged = resp[NATIVE_RAW_SET_COOKIES];
        if (Array.isArray(bridged)) list.push(...bridged.filter(Boolean).map(String));
    } catch (_) {}
    const headers = resp.headers;
    if (!headers) return list;
    try {
        if (typeof headers.getSetCookie === 'function') {
            const values = headers.getSetCookie();
            if (Array.isArray(values)) list.push(...values.filter(Boolean).map(String));
        }
    } catch (_) {}
    try {
        // 扩展页面里 Set-Cookie 是可以直接读的（不是禁止暴露的头）；安卓桥那边读了也是 null。
        const single = headers.get('Set-Cookie');
        if (single) list.push(String(single));
    } catch (_) {}
    return list;
}
