/*
 * 用线上真实 HTML 跑三个解析器，确认不是"只对我手写的片段有效"。
 *
 * 跑法：node tools/verify-market-parsers.mjs
 *
 * 这里刻意重写了一遍解析逻辑的等价实现，而不是 import TS 源码 —— 目的是拿线上的
 * 真实响应验证「解析规则对不对」。等解析规则确认无误，再由单元测试锁死在 TS 里。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const get = async (url, extra = {}) => {
    const response = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', ...extra },
    });
    return { status: response.status, text: await response.text() };
};

// ---------- Moewalls ----------
console.log('=== Moewalls ===');
const moe = await get('https://moewalls.com/');
const blocks = moe.text.match(/<article[^>]*class="[^"]*entry-tpl-grid[^"]*"[\s\S]*?<\/article>/g) ?? [];
const moeItems = [];
for (const block of blocks) {
    const detailUrl = /<a[^>]*class="g1-frame"[^>]*href="(https:\/\/moewalls\.com\/[^"]+)"/.exec(block)?.[1];
    const srcset = /srcset="([^"]+)"/.exec(block)?.[1];
    const largest = srcset?.split(',').map((e) => e.trim().split(/\s+/)).sort((a, b) => parseInt(b[1] ?? '0') - parseInt(a[1] ?? '0'))[0]?.[0];
    const name = (/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? '').replace(/<[^>]+>/g, '').trim()
        || /<a[^>]*title="([^"]+)"/.exec(block)?.[1];
    const res = /resolutions-(\d+x\d+)/.exec(block)?.[1];
    if (detailUrl && largest) moeItems.push({ detailUrl, thumbnailUrl: largest, name, res });
}
console.log(`HTTP ${moe.status} → 解析出 ${moeItems.length} 条（article 块 ${blocks.length} 个）`);
console.log('样例:', JSON.stringify(moeItems[0], null, 1));
const missing = moeItems.filter((i) => !i.name).length;
console.log(`缺名字的: ${missing}`);
console.log(`有分辨率的: ${moeItems.filter((i) => i.res).length}`);

// ---------- Haowallpaper ----------
console.log('\n=== Haowallpaper ===');
const hao = await get('https://haowallpaper.com/homeView?page=1');
const listBlock = /"@type":"ItemList"[\s\S]*?itemListElement":\[([\s\S]*?)\]\}/.exec(hao.text)?.[1] ?? '';
const entries = [...listBlock.matchAll(/"url":"([^"]+)"[\s\S]*?"name":"([^"]*)"[\s\S]*?"image":"([^"]*)"/g)];
const videoIds = new Set([...hao.text.matchAll(/video_reduce_file\/(?:\d{4}_\d{2}_\d{2}_file\/)?(\d+)\.mp4/g)].map((m) => m[1]));
const haoItems = entries.map((e) => {
    const fileId = /\/(\d+)\.(?:png|jpe?g|webp)$/i.exec(e[3])?.[1];
    return {
        name: e[2].replace(/「[^」]*」$/, '').trim(),
        fileId,
        isVideo: Boolean(fileId && videoIds.has(fileId)),
    };
});
console.log(`HTTP ${hao.status} → 解析出 ${haoItems.length} 条`);
console.log(`视频 ${haoItems.filter((i) => i.isVideo).length} 条，图片 ${haoItems.filter((i) => !i.isVideo).length} 条`);
console.log('样例:', JSON.stringify(haoItems[0], null, 1));
console.log(`缺名字的: ${haoItems.filter((i) => !i.name).length}`);

// ---------- Bizhihui ----------
console.log('\n=== Bizhihui ===');
const biz = await get('https://www.bizhihui.com/?order=views');
const bizBlocks = biz.text.match(/<a[^>]+href="https?:\/\/www\.bizhihui\.com\/p\/\d+\.html"[^>]*>[\s\S]{0,600}?<\/a>/g) ?? [];
const bizItems = [];
for (const block of bizBlocks) {
    const detailUrl = /href="([^"]+)"/.exec(block)?.[1];
    const thumb = /<img[^>]*src="([^"]+)"/.exec(block)?.[1];
    const alt = /<img[^>]*alt="([^"]*)"/.exec(block)?.[1];
    if (detailUrl && thumb && !thumb.startsWith('data:')) bizItems.push({ detailUrl, thumb, alt });
}
console.log(`HTTP ${biz.status} → 解析出 ${bizItems.length} 条（a 块 ${bizBlocks.length} 个）`);
console.log('样例:', JSON.stringify(bizItems[0], null, 1));
console.log(`带 alt 的: ${bizItems.filter((i) => i.alt).length}`);
console.log(`原图样例: ${bizItems[0]?.thumb.replace(/-pcthumbs$/, '')}`);
