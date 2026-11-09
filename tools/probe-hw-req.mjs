/*
 * 找到壁纸汇请求封装 C 的真身，看它对 requestUrl 做了什么。
 *
 * 已知：/pc/wallpaper/selSearchList 直接请求 404，且没有 baseURL 配置。
 * 那就得看封装里是不是拼了别的路径前缀，或者换了域名。
 *
 * 跑法：node tools/probe-hw-req.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const get = async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    return await response.text();
};

const home = await get('https://www.haowallpaper.com/');
const chunks = [...new Set([...home.matchAll(/\/_nuxt\/[A-Za-z0-9._-]+\.js/g)].map((m) => m[0]))];

// 找定义了 getSearchData 的块（搜索组件从 w() 里取它）
for (const chunk of chunks) {
    const text = await get(`https://www.haowallpaper.com${chunk}`);
    const at = text.indexOf('getSearchData');
    if (at < 0) continue;
    console.log(`=== ${chunk} ===`);
    console.log(text.slice(Math.max(0, at - 400), at + 900).replace(/\s+/g, ' '));
    console.log('');
}
