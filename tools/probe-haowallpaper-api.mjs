/*
 * 找 haowallpaper 的 XHR 接口（Nuxt 应用，页面 HTML 里没有原图地址）。
 *
 * 思路：翻页是 page 参数，那接口大概长这样；再把页面里的 nuxt 状态/脚本地址里
 * 出现的 api 前缀都试一遍，看哪个能返回 JSON。
 *
 * 跑法：node tools/probe-haowallpaper-api.mjs
 */
const UA = 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const BASE = 'https://haowallpaper.com';

const tryUrl = async (url, accept = 'application/json, text/plain, */*') => {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': UA,
                Referer: `${BASE}/`,
                Accept: accept,
                'X-Requested-With': 'XMLHttpRequest',
            },
        });
        const text = await response.text();
        const trimmed = text.trimStart();
        const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');
        const snippet = text.slice(0, 160).replace(/\s+/g, ' ');
        console.log(`${String(response.status).padEnd(4)} ${isJson ? 'JSON' : 'HTML'} ${(text.length / 1024).toFixed(0).padStart(5)}KB  ${url}`);
        if (isJson) console.log(`      ${snippet}`);
        return { status: response.status, isJson, text };
    } catch (error) {
        console.log(`ERR  ${url} -> ${error.message}`);
        return null;
    }
};

// 1. 页面里出现的 _nuxt 脚本，里面大概率写着接口前缀。
const page = await (await fetch(`${BASE}/homeView?page=1`, { headers: { 'User-Agent': UA } })).text();
const scripts = [...new Set([...page.matchAll(/src="(\/_nuxt\/[^"]+\.js)"/g)].map((m) => m[1]))];
console.log(`页面脚本数: ${scripts.length}`);

const hits = new Map();
for (const script of scripts.slice(0, 40)) {
    try {
        const js = await (await fetch(`${BASE}${script}`, { headers: { 'User-Agent': UA } })).text();
        for (const m of js.matchAll(/["'`](\/(?:api|webapi|v\d)[a-zA-Z0-9_\/{}$.-]*)["'`]/g)) {
            hits.set(m[1], (hits.get(m[1]) ?? 0) + 1);
        }
        for (const m of js.matchAll(/https?:\/\/[a-z0-9.-]*haowallpaper\.com\/[a-zA-Z0-9_\/.-]*/g)) {
            hits.set(m[0], (hits.get(m[0]) ?? 0) + 1);
        }
    } catch {
        // 某个脚本取不到就跳过
    }
}
console.log('\n脚本里的接口候选:');
console.log([...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `  ${v}x ${k}`).join('\n'));

// 2. 直接试几个常见形态
console.log('\n常见形态试探:');
for (const path of [
    '/api/homeView?page=1',
    '/api/wallpaper/list?page=1',
    '/webapi/homeView?page=1',
    '/api/getHomeList?page=1',
    '/api/homeViewLook/17815999759895936',
    '/api/detail/17815999759895936',
]) {
    await tryUrl(`${BASE}${path}`);
}
