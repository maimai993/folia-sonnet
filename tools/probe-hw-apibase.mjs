/*
 * 壁纸汇的 apiBrowserUrl 到底是什么？
 *
 * 请求封装用 baseURL = apiBrowserUrl + '/link'。
 * 如果响应是加密的（cryptoValue/decrypt/contract），那搜索的成本就很高，
 * 得先判断清楚再决定做不做。
 *
 * 跑法：node tools/probe-hw-apibase.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const get = async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    return await response.text();
};

const home = await get('https://www.haowallpaper.com/');

// 页面里内联的配置（__NUXT_DATA__ 或 window 注入）
const urls = [...new Set([...home.matchAll(/https?:\/\/[A-Za-z0-9.-]+/g)].map((m) => m[0]))];
console.log('=== 首页出现的域名 ===');
urls.slice(0, 25).forEach((url) => console.log(`  ${url}`));

// 找 apiBrowserUrl 字面量
const idx = home.indexOf('apiBrowserUrl');
if (idx >= 0) {
    console.log('\n=== apiBrowserUrl 上下文 ===');
    console.log(home.slice(Math.max(0, idx - 200), idx + 300).replace(/\s+/g, ' '));
} else {
    console.log('\n首页里没有内联 apiBrowserUrl（应该在 js 分块里）');
}

// 到运行时配置块里找
const chunks = [...new Set([...home.matchAll(/\/_nuxt\/[A-Za-z0-9._-]+\.js/g)].map((m) => m[0]))];
console.log(`\n=== 在 ${chunks.length} 个分块里找 apiBrowserUrl 与 /link 拼接 ===`);
for (const chunk of chunks) {
    const text = await get(`https://www.haowallpaper.com${chunk}`);
    const at = text.indexOf('apiBrowserUrl');
    if (at < 0) continue;
    console.log(`\n--- ${chunk} ---`);
    console.log(text.slice(Math.max(0, at - 250), at + 350).replace(/\s+/g, ' '));
}
