/*
 * 验证字体天下的搜索：/font-search-result.html?q=
 *
 * 用户要求加搜索。先确认：
 *   1. 搜索页结构和列表页是否一致（能不能复用同一个解析器）
 *   2. 分页怎么传
 *   3. 中文 / 英文关键字都能搜到吗
 *
 * 跑法：node tools/probe-fonts-cn-search.mjs
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
        items.push({
            id,
            name: (/class="site_font_name"[^>]*title="([^"]*)"/.exec(block)?.[1] ?? '').trim(),
            fontFile: /data-font-file="([^"]+)"/.exec(block)?.[1],
        });
    }
    return items;
};

for (const keyword of ['黑体', '毛笔', 'round', 'serif', '思源']) {
    const html = await get(`https://www.fonts.net.cn/font-search-result.html?q=${encodeURIComponent(keyword)}`);
    const items = parse(html);
    const total = /共\s*(\d+)\s*个/.exec(html)?.[1] ?? '?';
    console.log(`\n"${keyword}": ${items.length} 条（页面标注共 ${total} 个）`);
    items.slice(0, 3).forEach((item) => console.log(`   ${item.id}  ${item.name}`));
    // 分页参数长什么样
    const pager = [...new Set([...html.matchAll(/href="([^"]*font-search-result[^"]*)"/g)].map((m) => m[1]))];
    if (pager.length > 0) console.log(`   分页链接样例: ${pager.slice(1, 3).join(' , ')}`);
}

// 空关键字会不会报错
const empty = await get('https://www.fonts.net.cn/font-search-result.html?q=');
console.log(`\n空关键字: 解析出 ${parse(empty).length} 条`);

// 搜不到的词
const none = await get('https://www.fonts.net.cn/font-search-result.html?q=zzzzqqqq');
console.log(`搜不到的词: 解析出 ${parse(none).length} 条`);
