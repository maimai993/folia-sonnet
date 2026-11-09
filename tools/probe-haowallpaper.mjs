/*
 * 摸清 haowallpaper 详情页的结构：怎么判断视频/图片、原图在哪。
 *
 * Mineradio 里的正则全部失效了（CDN 域名与路径都换过），所以这里按当前真实
 * 结构重新确认一遍，再决定解析怎么写。
 *
 * 跑法：node tools/probe-haowallpaper.mjs
 */
const UA = 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const BASE = 'https://haowallpaper.com';

const get = async (url) => {
    const response = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: `${BASE}/`, Accept: 'text/html,application/xhtml+xml' },
    });
    if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
    return response.text();
};

const listHtml = await get(`${BASE}/homeView?page=1`);

// 列表走内嵌的 schema.org ItemList，比正则切 HTML 稳得多。
const itemList = /"@type":"ItemList"[\s\S]*?itemListElement":\[([\s\S]*?)\]\}/.exec(listHtml);
const items = [...(itemList?.[1] ?? '').matchAll(/"url":"([^"]+)"[\s\S]*?"name":"([^"]*)"[\s\S]*?"image":"([^"]*)"/g)]
    .map((m) => ({ detailUrl: m[1], name: m[2], image: m[3] }));

console.log(`列表解析：${items.length} 条`);
console.log('前两条:', JSON.stringify(items.slice(0, 2), null, 1));

// 列表页里的视频条目：<video> 标签会把条目和视频地址放一起。
const videoBlocks = [...listHtml.matchAll(/video_reduce_file\/([0-9_]+_file\/[0-9]+\.mp4)/g)].map((m) => m[1]);
console.log(`\n列表页视频条目数: ${videoBlocks.length}`);
console.log('视频样例:', videoBlocks.slice(0, 3));

// 详情页：判断本体是视频还是图片，靠 fileId 出现在哪种路径里。
for (const item of items.slice(0, 3)) {
    const html = await get(item.detailUrl);
    const ownFileId = /cache_file\/[0-9_]+_file\/([0-9]+)\.png/.exec(item.image)?.[1];
    const videoOwn = ownFileId
        ? new RegExp(`video_reduce_file/[0-9_]+_file/${ownFileId}\\.mp4`).test(html)
        : false;

    // 与当前条目同 fileId 的所有路径形态
    const sameId = ownFileId
        ? [...new Set([...html.matchAll(new RegExp(`[a-z_]+_file/[0-9_]+_file/${ownFileId}\\.[a-z0-9]+`, 'g'))].map((m) => m[0]))]
        : [];

    console.log(`\n--- ${item.name.slice(0, 30)}`);
    console.log(`  fileId=${ownFileId}  是视频=${videoOwn}`);
    console.log(`  同 id 路径: ${sameId.join(' | ') || '无'}`);

    // 找原图/大图的候选：png 里尺寸最大的那个通常就是原图
    const pngs = [...new Set([...html.matchAll(/https:\/\/img\.haowallpaper\.com\/[a-z_]+\/[0-9_]+_file\/[0-9]+\.(?:png|jpg|webp)/g)].map((m) => m[0]))];
    console.log(`  图片候选数: ${pngs.length}，首个: ${pngs[0]?.slice(0, 90)}`);
}
