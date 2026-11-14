/*
 * 找到壁纸汇的搜索接口。
 *
 * 它是 Nuxt 应用，搜索框在组件里，真实的查询大概率走 XHR。
 * 从打包产物里翻出接口路径，或者直接猜常见命名。
 *
 * 同时验证：Moewalls 与哲风壁纸的搜索结果页，能否用列表页的解析器解析。
 *
 * 跑法：node tools/probe-bg-search2.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const get = async (url, headers = {}) => {
    try {
        const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...headers } });
        return { status: response.status, text: await response.text() };
    } catch (error) {
        return { status: 0, text: '', error: String(error) };
    }
};

// ---------- 1. 壁纸汇：从 Nuxt 分块里找搜索接口 ----------
console.log('=== 壁纸汇搜索接口 ===');
const home = await get('https://www.haowallpaper.com/');
const chunks = [...new Set([...home.text.matchAll(/\/_nuxt\/[A-Za-z0-9._-]+\.js/g)].map((m) => m[0]))];
console.log(`  首页引用 ${chunks.length} 个 js 分块`);

const searchChunk = chunks.find((name) => /search/i.test(name));
console.log(`  搜索相关分块: ${searchChunk ?? '（没有直接叫 search 的）'}`);

// 在几个分块里找 api 路径
const candidates = new Set();
for (const chunk of chunks.slice(0, 40)) {
    const r = await get(`https://www.haowallpaper.com${chunk}`);
    for (const match of r.text.matchAll(/["'`](\/api\/[A-Za-z0-9/_-]+)["'`]/g)) candidates.add(match[1]);
    for (const match of r.text.matchAll(/["'`](https?:\/\/[^"'`]*api[^"'`]*)["'`]/g)) candidates.add(match[1]);
}
console.log(`  分块里出现 ${candidates.size} 个 api 路径:`);
[...candidates].slice(0, 25).forEach((path) => console.log(`    ${path}`));

// 试着打几个常见的搜索接口
console.log('\n  试打搜索接口:');
for (const path of ['/api/search?keyword=风景', '/api/search?q=风景', '/api/wallpaper/search?keyword=风景', '/api/searchPicture?keyword=风景']) {
    const r = await get(`https://www.haowallpaper.com${path}`);
    console.log(`    ${path.padEnd(42)} HTTP ${r.status}  ${r.text.slice(0, 90).replace(/\s+/g, ' ')}`);
}

// ---------- 2. Moewalls 搜索结果 vs 列表页 ----------
console.log('\n=== Moewalls 搜索结果结构 ===');
const mw = await get('https://moewalls.com/?s=nature');
const mwArticles = mw.text.match(/<article[\s\S]*?<\/article>/gi) ?? [];
console.log(`  article 块 ${mwArticles.length} 个`);
if (mwArticles[0]) console.log(`  第一个: ${mwArticles[0].replace(/\s+/g, ' ').slice(0, 300)}`);
const mwHasVideo = (mw.text.match(/data-video-url|videoUrl|\.mp4/gi) ?? []).length;
console.log(`  视频线索出现 ${mwHasVideo} 次`);

// ---------- 3. 哲风壁纸搜索结果 ----------
console.log('\n=== 哲风壁纸搜索结果结构 ===');
const bz = await get('https://www.bizhihui.com/search.php?q=风景');
console.log(`  详情链接 ${(bz.text.match(/\/p\/\d+\.html/g) ?? []).length} 个`);
const firstCard = /<a[^>]+href="(\/p\/\d+\.html)"[\s\S]{0,300}?<\/a>/i.exec(bz.text)?.[0];
console.log(`  第一张卡: ${firstCard ? firstCard.replace(/\s+/g, ' ').slice(0, 260) : '（无）'}`);
