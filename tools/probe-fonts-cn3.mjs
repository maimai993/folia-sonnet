/*
 * fonts.net.cn 的接口全貌：列表、详情、下载。
 *
 * 已经挖到一组 /api/font-* 端点。这里把它们完整列出来，然后真的调一次
 * /api/font-download/url，看它回什么（zip 地址？还是错误码？）。
 *
 * 跑法：node tools/probe-fonts-cn3.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BASE = 'https://www.fonts.net.cn';

const getJs = async () => {
    const response = await fetch('https://static.fonts.net.cn/3.1.1.26110501/assets/js/dist.app-web.js', {
        headers: { 'User-Agent': UA },
    });
    return response.text();
};

const js = await getJs();

// 把所有 /api/ 开头的路径都列出来
const apis = [...new Set([...js.matchAll(/["'`](\/api\/[a-zA-Z0-9_\-\/]+)["'`]/g)].map((m) => m[1]))];
console.log(`发现 ${apis.length} 个 /api/ 端点:`);
console.log(apis.sort().join('\n'));

// download 那段的上下文，看它怎么传参
console.log('\n=== download 调用上下文 ===');
const index = js.indexOf('font-download');
if (index >= 0) {
    console.log(js.slice(Math.max(0, index - 700), index + 900).replace(/\s+/g, ' '));
}
