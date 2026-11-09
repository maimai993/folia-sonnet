/*
 * 壁纸汇搜索接口 /pc/wallpaper/selSearchList 的参数与返回。
 *
 * 先看调用点的参数名，再实测。
 *
 * 跑法：node tools/probe-hw-search-api3.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const get = async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    return { status: response.status, text: await response.text() };
};

const chunk = await get('https://www.haowallpaper.com/_nuxt/DGLmkwRj.js');
const at = chunk.text.indexOf('selSearchList');
console.log('=== 调用点上下文 ===');
console.log(chunk.text.slice(Math.max(0, at - 700), at + 500).replace(/\s+/g, ' '));

// 实测
console.log('\n=== 实测 ===');
for (const query of ['keyword=风景', 'searchWord=风景', 'name=风景', 'q=风景']) {
    const url = `https://www.haowallpaper.com/pc/wallpaper/selSearchList?${query}&page=1&size=10`;
    const r = await get(url);
    console.log(`\n?${query}  →  HTTP ${r.status}`);
    console.log(`  ${r.text.slice(0, 400).replace(/\s+/g, ' ')}`);
}
