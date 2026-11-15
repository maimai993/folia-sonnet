/*
 * 壁纸汇请求封装的真身：找 `ce`（SearchBar 里调用的那个）与 C（SearchInput 里调用的那个）。
 *
 * 它们来自同一个 composable。搜 "requestUrl" 的定义与使用，看 method/headers/baseURL。
 *
 * 跑法：node tools/probe-hw-req2.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const get = async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    return await response.text();
};

const home = await get('https://www.haowallpaper.com/');
const chunks = [...new Set([...home.matchAll(/\/_nuxt\/[A-Za-z0-9._-]+\.js/g)].map((m) => m[0]))];

for (const chunk of chunks) {
    const text = await get(`https://www.haowallpaper.com${chunk}`);
    // 找 requestUrl 作为参数名被解构的地方（函数定义处）
    const idx = text.indexOf('requestUrl:');
    if (idx < 0) continue;
    console.log(`=== ${chunk} ===`);
    console.log(text.slice(Math.max(0, idx - 500), idx + 700).replace(/\s+/g, ' '));
    console.log('');
    break;
}
