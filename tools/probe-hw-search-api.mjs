/*
 * 壁纸汇（haowallpaper）的搜索到底走什么接口？
 *
 * 已知 /?s=风景 返回的是首页（标题就是站点名），说明不是搜索路由。
 * Nuxt 的搜索组件在 SearchInput / SearchDropdown 里，所以去这些分块的**文件名**里找，
 * 再在它们的内容里搜 api / fetch / axios 调用。
 *
 * 跑法：node tools/probe-hw-search-api.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const get = async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    return { status: response.status, text: await response.text() };
};

const home = await get('https://www.haowallpaper.com/');
const allChunks = [...new Set([...home.text.matchAll(/\/_nuxt\/[A-Za-z0-9._-]+\.js/g)].map((m) => m[0]))];
const searchChunks = allChunks.filter((name) => /search/i.test(name));
console.log(`=== 与搜索有关的分块 ${searchChunks.length} 个 ===`);
searchChunks.forEach((name) => console.log(`  ${name}`));

for (const chunk of searchChunks) {
    const r = await get(`https://www.haowallpaper.com${chunk}`);
    console.log(`\n--- ${chunk} (${r.text.length} 字节) ---`);
    // 找出所有字符串字面量里带 api / search 的片段
    const hits = new Set();
    for (const match of r.text.matchAll(/["'`]([^"'`]{0,80}(?:api|search|keyword|query)[^"'`]{0,80})["'`]/gi)) {
        const value = match[1];
        if (value.length > 2 && value.length < 120) hits.add(value);
    }
    [...hits].slice(0, 30).forEach((value) => console.log(`    ${value}`));
}

// 顺带看看站点根上有没有 sitemap 或 api 文档
console.log('\n=== 常见接口探测 ===');
const probes = [
    '/api/wallpaper/list',
    '/api/picture/search',
    '/api/search/keyword',
    '/api/wallpapers/search',
    '/api/v1/search',
];
for (const path of probes) {
    const r = await get(`https://www.haowallpaper.com${path}?keyword=cat`);
    const brief = r.text.slice(0, 80).replace(/\s+/g, ' ');
    console.log(`  ${path.padEnd(28)} HTTP ${r.status}  ${brief}`);
}
