/*
 * 壁纸汇搜索结果列表接口。
 *
 * 已确认 `/link/pc/wallpaper/selSearchList?search=` 返回建议词（明 JSON）。
 * 现在要找"按关键字列出壁纸"的接口。SearchBar 里拿到关键字后走的是 getSearchData 再跳转，
 * 所以真正的列表大概率是另一个接口，带 keyword / search 参数 + 分页。
 *
 * 跑法：node tools/probe-hw-list.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const get = async (path) => {
    const response = await fetch(`https://www.haowallpaper.com${path}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.haowallpaper.com/' },
    });
    return { status: response.status, text: await response.text() };
};

// 首页列表页用的接口是什么？先看 /link/pc/wallpaper/ 下常见方法
const probes = [
    '/link/pc/wallpaper/selWallpaperList?page=1&size=10&search=风景',
    '/link/pc/wallpaper/getWallpaperList?page=1&size=10&search=风景',
    '/link/pc/wallpaper/selList?page=1&size=10&search=风景',
    '/link/pc/wallpaper/searchList?page=1&size=10&search=风景',
    '/link/pc/wallpaper/selSearchWallpaper?page=1&size=10&search=风景',
    '/link/pc/wallpaper/selSearchList?page=1&size=10&search=风景',
];
for (const path of probes) {
    const r = await get(path);
    const brief = r.text.slice(0, 150).replace(/\s+/g, ' ');
    console.log(`${String(r.status).padEnd(4)} ${path.slice(0, 62).padEnd(64)} ${brief}`);
}

// 从分块里找 wallpaper 相关接口名，抓全
const home = await (await fetch('https://www.haowallpaper.com/', { headers: { 'User-Agent': UA } })).text();
const chunks = [...new Set([...home.matchAll(/\/_nuxt\/[A-Za-z0-9._-]+\.js/g)].map((m) => m[0]))];
const endpoints = new Set();
for (const chunk of chunks) {
    const text = await (await fetch(`https://www.haowallpaper.com${chunk}`, { headers: { 'User-Agent': UA } })).text();
    for (const match of text.matchAll(/[`"'](?:pc|app)?\/?(?:pc\/)?wallpaper\/[A-Za-z]+[`"']/g)) {
        endpoints.add(match[0].replace(/[`"']/g, ''));
    }
}
console.log('\n=== 分块里所有 wallpaper/ 接口 ===');
[...endpoints].sort().forEach((path) => console.log(`  ${path}`));
