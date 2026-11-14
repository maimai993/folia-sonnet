/*
 * 壁纸汇与哲风壁纸的搜索结果，究竟能不能解析出条目？
 *
 * 上一轮只看了计数，没看真实内容。这里把卡片结构打出来，
 * 判断是否能复用列表页解析器。
 *
 * 跑法：node tools/probe-bg-search3.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const get = async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    return { status: response.status, text: await response.text() };
};

// ---- 壁纸汇 /?s=风景 ----
console.log('=== 壁纸汇 /?s=风景 ===');
const hw = await get('https://www.haowallpaper.com/?s=%E9%A3%8E%E6%99%AF');
console.log(`  HTTP ${hw.status}  长度 ${hw.text.length}`);
// 列表页的标记是 video_reduce_file / schema.org ItemList，看看搜索页有没有
for (const marker of ['video_reduce_file', 'pre_cache_file', 'ItemList', 'wallpaperList', '__NUXT_DATA__', 'application/ld+json', '.jpg']) {
    console.log(`  ${marker.padEnd(22)} ${(hw.text.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length} 次`);
}
// 标题看看
const title = /<title>([^<]*)<\/title>/.exec(hw.text)?.[1];
console.log(`  页面标题: ${title}`);
// 有没有 "未找到" 之类
const notFound = /找不到|没有找到|no result|未找到/i.test(hw.text);
console.log(`  含"未找到"字样: ${notFound}`);

// ---- 哲风壁纸 ----
console.log('\n=== 哲风壁纸 /search.php?q=风景 ===');
const bz = await get('https://www.bizhihui.com/search.php?q=%E9%A3%8E%E6%99%AF');
console.log(`  HTTP ${bz.status}  长度 ${bz.text.length}`);
const items = [...bz.text.matchAll(/<a[^>]+href="(\/p\/\d+\.html)"[^>]*>/gi)];
console.log(`  /p/N.html 链接 ${items.length} 个`);
// 打印第一个 /p/ 附近的上下文，看图片怎么给
const at = bz.text.indexOf('/p/');
if (at > 0) {
    console.log(`  上下文: ${bz.text.slice(Math.max(0, at - 200), at + 400).replace(/\s+/g, ' ')}`);
}

// ---- 对照：哲风壁纸列表页 ----
console.log('\n=== 哲风壁纸列表页（对照）===');
const bzList = await get('https://www.bizhihui.com/');
const listAt = bzList.text.indexOf('/p/');
console.log(`  HTTP ${bzList.status}  /p/ 链接 ${(bzList.text.match(/\/p\/\d+\.html/g) ?? []).length} 个`);
if (listAt > 0) {
    console.log(`  上下文: ${bzList.text.slice(Math.max(0, listAt - 200), listAt + 400).replace(/\s+/g, ' ')}`);
}
