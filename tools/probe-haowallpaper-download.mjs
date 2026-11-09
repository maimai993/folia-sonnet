/*
 * 找高清原图的真实入口。
 *
 * 前面确认：cache_file 里只有 24 KB 缩略图，其它目录一律 403。
 * 那高清图要么在某个 API，要么在下载按钮触发的请求里。这里把详情页里所有
 * 非 img.haowallpaper.com 的链接、以及疑似接口的路径都列出来。
 *
 * 跑法：node tools/probe-haowallpaper-download.mjs
 */
const UA = 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const BASE = 'https://haowallpaper.com';

const get = async (url, extraHeaders = {}) => {
    const response = await fetch(url, {
        headers: {
            'User-Agent': UA,
            Referer: `${BASE}/`,
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            ...extraHeaders,
        },
    });
    return { status: response.status, text: await response.text() };
};

const detailUrl = 'https://haowallpaper.com/homeViewLook/17815999759895936';
const { text: html } = await get(detailUrl);

// 1. 所有形似接口的路径
const apis = [...new Set([...html.matchAll(/["'](\/?[a-zA-Z][a-zA-Z0-9_\/]*?(?:api|Api|API|down|Down|download|get)[a-zA-Z0-9_\/]*)["']/g)]
    .map((m) => m[1])
    .filter((p) => p.length > 4 && p.length < 80))].slice(0, 40);
console.log('疑似接口路径:');
console.log(apis.map((a) => '  ' + a).join('\n'));

// 2. 其它域名下的链接
const hosts = [...new Set([...html.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/g)].map((m) => m[1]))];
console.log('\n页面涉及的域名:');
console.log(hosts.map((h) => '  ' + h).join('\n'));

// 3. 下载相关的中文/英文关键词附近的内容
for (const keyword of ['下载原图', '原图', 'download', '高清下载']) {
    const index = html.indexOf(keyword);
    if (index >= 0) {
        console.log(`\n关键词「${keyword}」附近:`);
        console.log('  ' + html.slice(Math.max(0, index - 200), index + 260).replace(/\s+/g, ' '));
    }
}
