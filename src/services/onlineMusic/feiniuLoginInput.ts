import { feiniuServerUrlFromFnId, normalizeFeiniuServerUrl } from './feiniuTransport';

// src/services/onlineMusic/feiniuLoginInput.ts
// 飞牛登录只有「一个输入框」：用户在里面填 FN ID（人在外面，只记得住那个短码）或局域网地址
// （人在家里，抄得到的 IP:端口）。两者是同一件事 —— NAS 在哪 —— 不该让用户先判断自己在哪种
// 网络里再挑一个入口；挑错的代价只是「连不上」，而那句提示对两种错法一模一样。
//
// 这一层只做一件事：把第一栏填的东西翻译成地址。规则很简单 —— 一串不带点的东西只可能是 FN ID
// （域名有点、IP 也有点），其余写法（IP、IP:端口、域名、整条 URL）本身就是地址，交给
// transport 的 `withSchemeAndPort` 补协议与 5666 端口即可。这里不替它补，补两遍会把 https 改成 http。

/** 一串不带点的东西只可能是 FN ID：域名有点，IP 也有点。 */
export const isBareFnId = (value: string): boolean => {
    const head = normalizeFeiniuServerUrl(value).replace(/^https?:\/\//i, '').split('/')[0] ?? '';
    const name = head.split(':')[0] ?? '';
    return name.length > 0 && !name.includes('.');
};

/** 把第一栏填的东西翻译成地址：短码拼中继域名，地址原样走。 */
export const feiniuServerUrlForLoginInput = (raw: string | undefined): string | undefined => {
    if (raw === undefined) return undefined;
    return isBareFnId(raw) ? feiniuServerUrlFromFnId(raw) : raw;
};
