/*
 * 直接用 /font-<id>.html 上的数字 id 调下载接口。
 *
 * 跑法：node tools/probe-fonts-cn6.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BASE = 'https://www.fonts.net.cn';

const getHtml = async (url) => (await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } }));
const fontId = '37476120124';

const detail = await getHtml(`${BASE}/font-${fontId}.html`);
const html = await detail.text();
console.log(`/font-${fontId}.html -> HTTP ${detail.status}, ${(html.length / 1024).toFixed(0)} KB`);

const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1]?.trim();
console.log(`标题: ${title}`);

// 下载按钮与相关 data
for (const pattern of [
    /<button[^>]*data-button="download"[^>]*>[\s\S]{0,80}/,
    /data-font-id="[^"]*"/,
    /data-id="[^"]*"/,
    /DOWNLOAD_FONT_URL[^;]{0,120}/,
    /FONT_ID[^;]{0,80}/,
]) {
    const match = pattern.exec(html);
    if (match) console.log(`  ${match[0].replace(/\s+/g, ' ').slice(0, 160)}`);
}

// 页面里所有内联 script 变量
const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const vars = scripts.filter((script) => /var\s+\w+|=\s*\{/.test(script)).slice(0, 4);
console.log('\n=== 内联 script 片段 ===');
vars.forEach((script) => {
    const trimmed = script.replace(/\s+/g, ' ').trim();
    if (trimmed.length > 40) console.log(`  ${trimmed.slice(0, 300)}`);
});

// 调接口
console.log('\n=== 下载接口 ===');
for (const [label, path, body, method] of [
    ['GET ?fontId', `/api/font-download/url?fontId=${fontId}`, null, 'GET'],
    ['POST fontId num', '/api/font-download/url', { fontId: Number(fontId) }, 'POST'],
    ['POST product info', '/api/font-product/info', { fontId: Number(fontId) }, 'POST'],
    ['POST product info str', '/api/font-product/info', { fontId }, 'POST'],
]) {
    try {
        const response = await fetch(`${BASE}${path}`, {
            method,
            headers: {
                'User-Agent': UA,
                Accept: 'application/json, text/plain, */*',
                'Content-Type': 'application/json',
                Referer: `${BASE}/font-${fontId}.html`,
                'X-Requested-With': 'XMLHttpRequest',
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await response.text();
        console.log(`  ${label} -> ${response.status}: ${text.slice(0, 240).replace(/\s+/g, ' ')}`);
    } catch (error) {
        console.log(`  ${label} -> 失败 ${error.message}`);
    }
}
