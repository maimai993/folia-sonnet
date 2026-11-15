/*
 * 摸清 fonts.net.cn 的 API 与下载包结构。
 *
 * 目标：
 *   1. 列表接口在哪（JSON？还是服务端渲染 HTML？）
 *   2. 字体详情页结构
 *   3. 下载链接是什么（zip？里面有哪些后缀的文件？）
 *
 * 跑法：node tools/probe-fonts-net-cn.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BASE = 'https://www.fonts.net.cn';

const get = async (url, extra = {}) => {
    const response = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', Accept: 'text/html,*/*;q=0.8', ...extra },
    });
    return { status: response.status, text: await response.text(), url: response.url };
};

const home = await get(`${BASE}/`);
console.log(`首页: HTTP ${home.status}, ${(home.text.length / 1024).toFixed(0)} KB`);

// 1. 站内链接，看路由规律
const links = [...new Set([...home.text.matchAll(/href="([^"#]+)"/g)].map((m) => m[1]))];
console.log(`\n链接 ${links.length} 个，前 30:`);
console.log(links.slice(0, 30).join('\n'));

// 2. 脚本里的接口
const scripts = [...new Set([...home.text.matchAll(/src="([^"]+\.js[^"]*)"/g)].map((m) => m[1]))];
console.log(`\n脚本 ${scripts.length} 个:`);
console.log(scripts.slice(0, 10).join('\n'));

// 3. 页面里疑似接口/下载的片段
console.log('\n=== 页面里含 api/download/zip 的片段 ===');
const hits = [...new Set([...home.text.matchAll(/["']([^"']{0,80}(?:api|download|\.zip)[^"']{0,80})["']/gi)].map((m) => m[1]))];
console.log(hits.slice(0, 20).join('\n') || '无');
