/*
 * 壁纸汇搜索接口（第二方案）：从 Nuxt 构建清单里定位 SearchInput 对应的 js。
 *
 * 上一轮发现没有名字带 search 的分块，但首页 CSS 里有 SearchInput / SearchDropdown。
 * Nuxt 会在 HTML 里给出所有资源名，改成在**全部**分块内容里搜 "查询接口"，而不是只看名字。
 *
 * 跑法：node tools/probe-hw-search-api2.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const get = async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    return { status: response.status, text: await response.text() };
};

const home = await get('https://www.haowallpaper.com/');

// Nuxt 的 CSS 名和 JS 名通常成对出现（SearchInput.xxxx.css / SearchInput.xxxx.js）
const cssNames = [...new Set([...home.text.matchAll(/\/_nuxt\/(Search[A-Za-z0-9]*)\.[A-Za-z0-9_-]+\.css/g)].map((m) => m[1]))];
console.log(`=== CSS 里出现的 Search* 组件: ${cssNames.join(', ') || '（无）'} ===`);

const allChunks = [...new Set([...home.text.matchAll(/\/_nuxt\/[A-Za-z0-9._-]+\.js/g)].map((m) => m[0]))];
console.log(`首页 js 分块 ${allChunks.length} 个`);

// 全部扫一遍，找含搜索关键字的
const found = [];
for (const chunk of allChunks) {
    const r = await get(`https://www.haowallpaper.com${chunk}`);
    if (/keyword|searchKeyword|searchList|querySearch/i.test(r.text)) {
        found.push({ chunk, text: r.text });
    }
}
console.log(`\n含搜索关键字的块: ${found.length} 个`);
for (const { chunk, text } of found.slice(0, 4)) {
    console.log(`\n--- ${chunk} ---`);
    // 找 URL 片段与请求函数
    const urls = new Set();
    for (const match of text.matchAll(/["'`]((?:\/|https?:\/\/)[A-Za-z0-9/._-]*(?:api|search|picture|wallpaper)[A-Za-z0-9/._-]*)["'`]/gi)) {
        urls.add(match[1]);
    }
    [...urls].slice(0, 20).forEach((url) => console.log(`    URL: ${url}`));
    // 找环绕 keyword 的片段
    const idx = text.search(/keyword/i);
    if (idx > 0) console.log(`    片段: ${text.slice(Math.max(0, idx - 180), idx + 220).replace(/\s+/g, ' ')}`);
}
