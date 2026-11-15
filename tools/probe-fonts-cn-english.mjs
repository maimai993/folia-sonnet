/*
 * 为什么英文分类是空的？
 *
 * 用户的判断很可能是对的：我拿中文当预览去测英文源。
 * 这里把英文页的结构、fontFile、以及"用英文页的 fontFile + 中文预览文字"会发生什么，全部查清。
 *
 * 跑法：node tools/probe-fonts-cn-english.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const get = async (url) => (await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } })).text();

const parse = (html) => {
    const blocks = html.match(/<li>\s*<div class="site_font_list_item_head"[\s\S]*?<\/li>/g) ?? [];
    const seen = new Set();
    const items = [];
    for (const block of blocks) {
        const detailPath = /href="(\/font-\d+\.html)"/.exec(block)?.[1];
        const id = detailPath && /\/font-(\d+)\.html/.exec(detailPath)?.[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const name = (/class="site_font_name"[^>]*title="([^"]*)"/.exec(block)?.[1] ?? '').trim();
        const fontFile = /data-font-file="([^"]+)"/.exec(block)?.[1];
        const cover = /<img[^>]*src="([^"]+)"/.exec(block)?.[1];
        items.push({ id, name, fontFile, cover });
    }
    return items;
};

console.log('=== 英文第 1 页 ===');
const en = parse(await get('https://www.fonts.net.cn/fonts-en-1.html'));
console.log(`解析出 ${en.length} 条`);
en.slice(0, 4).forEach((item) => console.log(`  ${item.id}  ${item.name}  fontFile=${item.fontFile}`));

console.log('\n=== 中文第 1 页 ===');
const zh = parse(await get('https://www.fonts.net.cn/fonts-zh-1.html'));
console.log(`解析出 ${zh.length} 条`);
zh.slice(0, 3).forEach((item) => console.log(`  ${item.id}  ${item.name}`));

// 关键验证：英文字体 + 中文预览文字 vs 英文预览文字
const englishFont = en[0];
const chineseFont = zh[0];
const previewer = 'https://previewer.fonts.net.cn/canvas.php';
const jpegSize = (buffer) => {
    let at = 2;
    while (at < buffer.length) {
        if (buffer[at] !== 0xff) { at += 1; continue; }
        const marker = buffer[at + 1];
        const length = buffer.readUInt16BE(at + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: buffer.readUInt16BE(at + 5), width: buffer.readUInt16BE(at + 7) };
        }
        at += 2 + length;
    }
    return null;
};

const tryPreview = async (label, fontFile, text) => {
    const url = `${previewer}?font=${encodeURIComponent(fontFile)}&text=${encodeURIComponent(text)}`;
    const response = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.fonts.net.cn/' } });
    const buffer = Buffer.from(await response.arrayBuffer());
    const size = jpegSize(buffer);
    const empty = buffer.length <= 1600;
    console.log(`  ${label.padEnd(28)} ${String(buffer.length).padStart(6)} 字节  ${size ? `${size.width}x${size.height}` : '?'}  ${empty ? '【空白】' : ''}`);
};

console.log('\n=== 预览对照实验 ===');
if (englishFont) {
    await tryPreview('英文字体 + 中文文字', englishFont.fontFile, '永风起时花落无声');
    await tryPreview('英文字体 + 英文文字', englishFont.fontFile, 'The quick brown fox');
    await tryPreview('英文字体 + 该字体名', englishFont.fontFile, englishFont.name);
}
if (chineseFont) {
    await tryPreview('中文字体 + 中文文字', chineseFont.fontFile, '永风起时花落无声');
    await tryPreview('中文字体 + 英文文字', chineseFont.fontFile, 'The quick brown fox');
}
