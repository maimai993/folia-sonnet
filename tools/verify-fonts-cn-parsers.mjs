/*
 * 验证修正后的列表解析器（按 li 切块 + 取 data-font-file）。
 *
 * 跑法：node tools/verify-fonts-cn-parsers.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const get = async (url) => (await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } })).text();

// 与 fontsNetCn.ts 里的 parseFontsCnList 同一套规则
const parse = (html) => {
    const blocks = html.match(/<li>\s*<div class="site_font_list_item_head"[\s\S]*?<\/li>/g) ?? [];
    const items = [];
    const seen = new Set();
    for (const block of blocks) {
        const detailPath = /href="(\/font-\d+\.html)"/.exec(block)?.[1];
        if (!detailPath) continue;
        const id = /\/font-(\d+)\.html/.exec(detailPath)?.[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const name = (/class="site_font_name"[^>]*title="([^"]*)"/.exec(block)?.[1] ?? /class="site_font_name"[^>]*>([^<]*)</.exec(block)?.[1] ?? '').trim();
        const coverSrc = /<img[^>]*src="([^"]+)"/.exec(block)?.[1] ?? '';
        const fontFile = /data-font-file="([^"]+)"/.exec(block)?.[1];
        items.push({ id, name: name || `字体 ${id}`, coverUrl: coverSrc.startsWith('//') ? `https:${coverSrc}` : coverSrc, detailPath, fontFile });
    }
    return items;
};

let totalWithCover = 0;
let totalWithFontFile = 0;
let totalItems = 0;

for (const [label, url] of [
    ['中文第1页', 'https://www.fonts.net.cn/fonts-zh-1.html'],
    ['中文第2页', 'https://www.fonts.net.cn/fonts-zh-2.html'],
    ['英文第1页', 'https://www.fonts.net.cn/fonts-en-1.html'],
    ['黑体标签', 'https://www.fonts.net.cn/fonts-zh/tag-heiti-1.html'],
    ['草书标签', 'https://www.fonts.net.cn/fonts-zh/tag-caoshu-1.html'],
]) {
    const items = parse(await get(url));
    const withCover = items.filter((item) => item.coverUrl).length;
    const withFontFile = items.filter((item) => item.fontFile).length;
    const genericNames = items.filter((item) => /^字体 \d+$/.test(item.name)).length;
    totalItems += items.length;
    totalWithCover += withCover;
    totalWithFontFile += withFontFile;
    console.log(`\n${label}: ${items.length} 条 | 封面 ${withCover} | fontFile ${withFontFile} | 名字兜底 ${genericNames}`);
    items.slice(0, 2).forEach((item) => {
        console.log(`   ${item.id}  ${item.name}`);
        console.log(`      封面: ${item.coverUrl}`);
        console.log(`      fontFile: ${item.fontFile}`);
    });
}

console.log(`\n=== 合计 ${totalItems} 条：封面 ${totalWithCover}，fontFile ${totalWithFontFile} ===`);
