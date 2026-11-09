/*
 * fonts.net.cn 的下载流程：DOWNLOAD_FONT_URL 是空的，说明由 JS 拼。
 * 这里把 app 脚本里的接口与下载逻辑挖出来，并看字体详情页。
 *
 * 跑法：node tools/probe-fonts-cn2.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BASE = 'https://www.fonts.net.cn';

const get = async (url, extra = {}) => {
    const response = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', Accept: 'text/html,*/*;q=0.8', ...extra },
    });
    return { status: response.status, text: await response.text() };
};

// 1. app 脚本里的接口
const appJs = await get('https://static.fonts.net.cn/3.1.1.26110501/assets/js/dist.app-web.js');
console.log(`app-web.js: HTTP ${appJs.status}, ${(appJs.text.length / 1024).toFixed(0)} KB`);

const apis = [...new Set([...appJs.text.matchAll(/["'`]((?:\/[a-z][a-zA-Z0-9_\-\/]*)?(?:api|Api)[a-zA-Z0-9_\-\/]*(?:\?[^"'`]*)?)["'`]/g)].map((m) => m[1]))];
console.log('\n脚本里的接口路径:');
console.log(apis.slice(0, 40).join('\n') || '无');

const urls = [...new Set([...appJs.text.matchAll(/["'`](https?:\/\/[^"'`]{5,120})["'`]/g)].map((m) => m[1]))];
console.log('\n脚本里的绝对地址（前 20）:');
console.log(urls.slice(0, 20).join('\n') || '无');

// 2. 含 download 的代码片段
console.log('\n=== download 相关代码 ===');
const dl = [...appJs.text.matchAll(/.{80}[Dd]ownload.{120}/g)].slice(0, 6).map((m) => m[0].replace(/\s+/g, ' '));
console.log(dl.join('\n---\n') || '无');
