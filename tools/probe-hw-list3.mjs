/*
 * 壁纸汇 wallpaperList 的参数结构（dataForm）到底是什么？
 *
 * 已知：参数是加密后的字符串，响应也要解密。这条路成本很高。
 * 先确认字段名，再判断有没有明文通道。
 *
 * 跑法：node tools/probe-hw-list3.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const get = async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': UA } });
    return await response.text();
};

const text = await get('https://www.haowallpaper.com/_nuxt/D6JdM6wX.js');

// 找 dataForm 的初始定义
const at = text.indexOf('dataForm:');
if (at >= 0) {
    console.log('=== dataForm 初始化 ===');
    console.log(text.slice(Math.max(0, at - 100), at + 500).replace(/\s+/g, ' '));
}

// 找搜索关键字字段名
for (const key of ['keyWord', 'keyword', 'searchKey', 'search']) {
    const idx = text.indexOf(`${key}:`);
    if (idx >= 0) {
        console.log(`\n=== ${key} 出现处 ===`);
        console.log(text.slice(Math.max(0, idx - 150), idx + 200).replace(/\s+/g, ' '));
    }
}

// 加密函数 Re 长什么样
const reAt = text.indexOf('Re=');
if (reAt >= 0) {
    console.log('\n=== Re 定义 ===');
    console.log(text.slice(reAt, reAt + 200).replace(/\s+/g, ' '));
}
