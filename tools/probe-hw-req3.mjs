/*
 * 精确定位壁纸汇的请求封装函数体。
 *
 * 思路：搜索 `methodVal` 出现最多的地方 —— 那一定是封装内部对它的分支处理。
 * 把那段完整打出来，就能看到它怎么拼 URL、加什么 header。
 *
 * 跑法：node tools/probe-hw-req3.mjs
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
    const count = (text.match(/methodVal/g) ?? []).length;
    if (count < 2) continue;
    // 找 `methodVal` 与 `requestUrl` 同时密集出现的位置
    const idx = text.indexOf('methodVal');
    console.log(`=== ${chunk}（methodVal 出现 ${count} 次）===`);
    console.log(text.slice(Math.max(0, idx - 900), idx + 900).replace(/\s+/g, ' '));
    console.log('');
}
