/*
 * fonts.net.cn 的预览机制：previewer.fonts.net.cn/canvas.php 怎么用？
 *
 * 用户提示「字符映射表」可以直接复用。这里探清：
 *   1. 预览接口收什么参数
 *   2. 返回什么（图片？字体的子集？）
 *   3. 有没有现成的字符映射/字符集清单
 *
 * 跑法：node tools/probe-fonts-cn-preview.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BASE = 'https://www.fonts.net.cn';
const fontId = '41569702150';

const appJs = await (await fetch('https://static.fonts.net.cn/3.1.1.26110501/assets/js/dist.app-web.js', {
    headers: { 'User-Agent': UA },
})).text();

// 1. preview 相关代码
console.log('=== preview 相关代码 ===');
for (const match of [...appJs.matchAll(/.{200}preview.{300}/gi)].slice(0, 4)) {
    console.log('---');
    console.log(match[0].replace(/\s+/g, ' '));
}

// 2. canvas.php 的调用参数
console.log('\n\n=== canvas.php 调用 ===');
for (const match of [...appJs.matchAll(/.{300}canvas\.php.{300}/gi)].slice(0, 3)) {
    console.log('---');
    console.log(match[0].replace(/\s+/g, ' '));
}

// 3. 详情页里的预览元素
const detail = await (await fetch(`${BASE}/font-${fontId}.html`, { headers: { 'User-Agent': UA } })).text();
console.log('\n\n=== 详情页里的预览元素 ===');
for (const pattern of [
    /previewer\.fonts\.net\.cn[^"'\s)]{0,200}/g,
    /data-preview[a-z-]*="[^"]*"/g,
    /data-text[a-z-]*="[^"]*"/g,
    /class="[^"]*preview[^"]*"/g,
]) {
    const matches = [...new Set([...detail.matchAll(pattern)].map((m) => m[0]))];
    if (matches.length > 0) console.log(`${pattern.source.slice(0, 30)}:\n  ${matches.slice(0, 6).join('\n  ')}`);
}
