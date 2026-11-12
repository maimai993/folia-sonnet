import md5 from 'blueimp-md5';

// src/services/bilibili/wbi.ts
//
// bilibili 的 wbi 签名。2023 年起搜索和播放地址这两个接口都要它，不带就回 -403。
//
// 变表是公开常量；密钥来自 /x/web-interface/nav 里 img_url / sub_url 的文件名。
// 这里只做「把一组参数排好序、算一个 w_rid」，不碰网络。

const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
] as const;

/** `https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png` → `7cd084941338484aae1ad9425b84077c`。 */
export const wbiKeyFromUrl = (url: string): string => {
    const name = url.split('/').pop() ?? '';
    return name.split('.')[0] ?? '';
};

export const getMixinKey = (imgKey: string, subKey: string): string => (
    MIXIN_KEY_ENC_TAB.map(index => (imgKey + subKey)[index] ?? '').join('').slice(0, 32)
);

/** 接口要的查询串：参数按 key 排序，加上 wts 和 w_rid。 */
export const signWbiParams = (
    params: Record<string, string | number>,
    imgKey: string,
    subKey: string,
    timestampSec: number = Math.round(Date.now() / 1000),
): string => {
    const mixinKey = getMixinKey(imgKey, subKey);
    const all: Record<string, string | number> = { ...params, wts: timestampSec };
    const query = Object.keys(all)
        .sort()
        .map(key => {
            // bilibili 的过滤规则：值里的 !'()* 先剔掉再编码。
            const value = String(all[key]).replace(/[!'()*]/g, '');
            return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
        })
        .join('&');
    return `${query}&w_rid=${md5(query + mixinKey)}`;
};
