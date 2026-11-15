/*
 * 探清 previewer.fonts.net.cn/canvas.php 的参数与返回。
 *
 * 这是预览的基础：站点自己的预览器怎么画字、怎么知道某款字体有哪些字符（字符映射表）。
 *
 * 跑法：node tools/probe-canvas-preview.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BASE = 'https://www.fonts.net.cn';
const fontId = '41569702150';

// 1. 详情页里预览器相关的 DOM 与属性
const detail = await (await fetch(`${BASE}/font-${fontId}.html`, { headers: { 'User-Agent': UA } })).text();

console.log('=== 预览器 DOM ===');
const previewerBlock = /<[^>]*site_font_detail_previewer[\s\S]{0,1500}?<\/section>/i.exec(detail)?.[0]
    ?? /<[^>]*site_font_detail_previewer[\s\S]{0,1200}/i.exec(detail)?.[0]
    ?? '';
console.log(previewerBlock.replace(/\s+/g, ' ').slice(0, 1200));

// 2. 页面里的 data-* 预览参数
console.log('\n=== 预览相关 data 属性 ===');
const dataAttrs = [...new Set([...detail.matchAll(/data-[a-z-]+="[^"]{1,80}"/gi)]
    .map((m) => m[0])
    .filter((attr) => /preview|font|text|canvas|char/i.test(attr)))];
console.log(dataAttrs.slice(0, 20).join('\n') || '无');

// 3. 内联 script 里的预览配置
console.log('\n=== 内联 script 中的预览配置 ===');
const scripts = [...detail.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
for (const script of scripts) {
    if (/preview|canvas|char/i.test(script)) {
        console.log('---');
        console.log(script.replace(/\s+/g, ' ').slice(0, 600));
    }
}

// 4. canvas.php 试探
console.log('\n=== canvas.php 试探 ===');
const probes = [
    `${'https://previewer.fonts.net.cn'}/canvas.php?fontId=${fontId}`,
    `${'https://previewer.fonts.net.cn'}/canvas.php?fontId=${fontId}&text=测试`,
    `${'https://previewer.fonts.net.cn'}/canvas.php?id=${fontId}&text=hello`,
];
for (const url of probes) {
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': UA, Referer: `${BASE}/font-${fontId}.html` },
        });
        const contentType = response.headers.get('content-type');
        const buffer = Buffer.from(await response.arrayBuffer());
        console.log(`${response.status}  ${contentType}  ${buffer.length} 字节  ${url.slice(0, 100)}`);
        if (contentType?.includes('image')) {
            console.log(`   magic: ${buffer.slice(0, 8).toString('hex')}`);
        } else {
            console.log(`   ${buffer.toString('utf8').slice(0, 200).replace(/\s+/g, ' ')}`);
        }
    } catch (error) {
        console.log(`失败 ${url.slice(0, 90)} -> ${error.message}`);
    }
}
