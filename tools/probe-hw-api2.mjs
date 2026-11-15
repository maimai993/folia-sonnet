/*
 * Nuxt 应用的接口发现：把所有 _nuxt 资源（含 modulepreload）都翻一遍找接口前缀。
 *
 * 跑法：node tools/probe-hw-api2.mjs
 */
const UA = 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const BASE = 'https://haowallpaper.com';

const page = await (await fetch(`${BASE}/homeView?page=1`, { headers: { 'User-Agent': UA } })).text();

const assets = [...new Set([
    ...[...page.matchAll(/src="(\/_nuxt\/[^"]+\.js)"/g)].map((m) => m[1]),
    ...[...page.matchAll(/href="(\/_nuxt\/[^"]+\.js)"/g)].map((m) => m[1]),
])];
console.log(`发现 JS 资源 ${assets.length} 个`);
console.log(assets.slice(0, 12).join('\n'));

const apiPaths = new Set();
const absoluteUrls = new Set();

for (const asset of assets) {
    let js;
    try {
        js = await (await fetch(`${BASE}${asset}`, { headers: { 'User-Agent': UA } })).text();
    } catch {
        continue;
    }
    // 相对接口路径
    for (const m of js.matchAll(/["'`](\/[a-zA-Z][a-zA-Z0-9_\/-]{2,60})["'`]/g)) {
        const path = m[1];
        if (/^(api|webapi|v\d|home|look|detail|list|file|down)/i.test(path.slice(1))) {
            apiPaths.add(path);
        }
    }
    // 绝对地址里带 api 的
    for (const m of js.matchAll(/https?:\/\/[a-zA-Z0-9.-]+\.[a-z]{2,}[a-zA-Z0-9_\/.-]*/g)) {
        if (/api|download|file|img/i.test(m[0])) absoluteUrls.add(m[0]);
    }
}

console.log('\n相对接口候选:');
console.log([...apiPaths].slice(0, 40).map((p) => '  ' + p).join('\n') || '  无');

console.log('\n绝对地址候选（含 api/download/file/img）:');
console.log([...absoluteUrls].slice(0, 40).map((p) => '  ' + p).join('\n') || '  无');
