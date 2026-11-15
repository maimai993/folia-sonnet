/*
 * 壁纸汇的请求封装 C({requestUrl, methodVal, data}) 到底打到哪个域名？
 *
 * 直接 /pc/wallpaper/selSearchList 是 404，说明 baseURL 不是 www.haowallpaper.com。
 * 从分块里找 axios 实例的 baseURL / create({baseURL}) 配置。
 *
 * 跑法：node tools/probe-hw-base.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const get = async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    return await response.text();
};

const home = await get('https://www.haowallpaper.com/');
const chunks = [...new Set([...home.matchAll(/\/_nuxt\/[A-Za-z0-9._-]+\.js/g)].map((m) => m[0]))];

const domains = new Set();
const baseUrls = new Set();
for (const chunk of chunks) {
    const text = await get(`https://www.haowallpaper.com${chunk}`);
    for (const match of text.matchAll(/baseURL\s*:\s*["'`]([^"'`]{1,120})["'`]/g)) baseUrls.add(match[1]);
    for (const match of text.matchAll(/https?:\/\/[a-z0-9.-]*(?:api|wallpaper|haowall)[a-z0-9.-]*/gi)) domains.add(match[0]);
}
console.log('=== baseURL 配置 ===');
[...baseUrls].forEach((url) => console.log(`  ${url}`));
console.log('\n=== 出现过的域名 ===');
[...domains].slice(0, 20).forEach((domain) => console.log(`  ${domain}`));
