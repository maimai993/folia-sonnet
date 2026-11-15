/*
 * canvas.php 的真实参数：data-font-file 里的那个文件名。
 *
 * 详情页里给出了 `data-font-file="41569-0eb5046846c738e9eb6f95120c2ab057.ttf"`，
 * 这个才是渲染用的键（前半段 41569 = fontId 的前 5 位，后面是 hash）。
 *
 * 跑法：node tools/probe-canvas-preview2.mjs
 */
import { writeFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BASE = 'https://www.fonts.net.cn';
const previewer = 'https://previewer.fonts.net.cn/canvas.php';
const fontId = '41569702150';

const detail = await (await fetch(`${BASE}/font-${fontId}.html`, { headers: { 'User-Agent': UA } })).text();
const fontFile = /data-font-file="([^"]+)"/.exec(detail)?.[1];
const coverUrl = /data-app-image="font-preview"[^>]*src="([^"]+)"/.exec(detail)?.[1]
    ?? /src="([^"]+cover[^"]+)"[^>]*data-app-image="font-preview"/.exec(detail)?.[1];
const fontSize = /data-font-size="([^"]*)"/.exec(detail)?.[1];
const charset = /data-charset="([^"]*)"/.exec(detail)?.[1];

console.log(`data-font-file: ${fontFile}`);
console.log(`封面图: ${coverUrl}`);
console.log(`data-font-size: "${fontSize}"`);
console.log(`data-charset: "${charset}"`);

// 1. 封面图能不能直接拿
if (coverUrl) {
    const full = coverUrl.startsWith('//') ? `https:${coverUrl}` : coverUrl;
    const response = await fetch(full, { headers: { 'User-Agent': UA, Referer: `${BASE}/font-${fontId}.html` } });
    const buffer = Buffer.from(await response.arrayBuffer());
    console.log(`\n封面图: HTTP ${response.status} ${response.headers.get('content-type')} ${(buffer.length / 1024).toFixed(1)} KB magic=${buffer.slice(0, 4).toString('hex')}`);
    writeFileSync('tools/_cover.jpg', buffer);
}

// 2. 用 fontFile 试 canvas.php
console.log('\n=== canvas.php with fontFile ===');
const variants = [
    `${previewer}?font=${encodeURIComponent(fontFile)}&text=${encodeURIComponent('永风起时花落无声')}`,
    `${previewer}?file=${encodeURIComponent(fontFile)}&text=${encodeURIComponent('永风起时花落无声')}`,
    `${previewer}?fontFile=${encodeURIComponent(fontFile)}&text=${encodeURIComponent('永风起时花落无声')}`,
    `${previewer}?fontId=${fontFile.split('-')[0]}&file=${encodeURIComponent(fontFile)}&text=${encodeURIComponent('永')}`,
];
for (const url of variants) {
    const response = await fetch(url, { headers: { 'User-Agent': UA, Referer: `${BASE}/font-${fontId}.html` } });
    const buffer = Buffer.from(await response.arrayBuffer());
    const distinct = new Set(buffer).size;
    console.log(`${response.status} ${String(buffer.length).padStart(6)} 字节  唯一字节=${distinct}  ${url.slice(60, 150)}`);
    if (buffer.length > 3000) {
        writeFileSync('tools/_preview_test.jpg', buffer);
        console.log(`   → 存到 tools/_preview_test.jpg，magic=${buffer.slice(0, 4).toString('hex')}`);
    }
}

// 3. 从 JS 里找 canvas.php 的完整调用代码
const appJs = await (await fetch('https://static.fonts.net.cn/3.1.1.26110501/assets/js/dist.app-web.js', {
    headers: { 'User-Agent': UA },
})).text();
const at = appJs.indexOf('FONT_PREVIEW_CANVAS_URL');
console.log('\n=== JS 里 canvas 渲染逻辑 ===');
// 找使用这个常量的地方
const uses = [...appJs.matchAll(/FONT_PREVIEW_CANVAS_URL/g)].map((m) => m.index);
console.log(`引用 ${uses.length} 处`);
for (const index of uses.slice(0, 2)) {
    console.log('---');
    console.log(appJs.slice(Math.max(0, index - 600), index + 600).replace(/\s+/g, ' '));
}
