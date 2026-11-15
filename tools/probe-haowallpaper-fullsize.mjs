/*
 * 详情页里找**原图**：列表给的是 24 KB 缩略图，壁纸得用高清的。
 *
 * 跑法：node tools/probe-haowallpaper-fullsize.mjs
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

const detailUrl = 'https://haowallpaper.com/homeViewLook/17815999759895936';
const fileId = '17815907003452800';
const html = await get(detailUrl);

// 与当前 fileId 同名的所有路径，按目录分组看有哪些"变体"。
const sameId = [...new Set([...html.matchAll(new RegExp(`https://img\\.haowallpaper\\.com/([a-z_]+)/([0-9_]+_file)/${fileId}\\.([a-z0-9]+)`, 'g'))]
    .map((m) => `${m[1]}/${m[3]}`))];
console.log(`同 fileId 的变体目录: ${sameId.join('  ') || '无'}`);

// 直接 HEAD 探一下各个目录的尺寸，找出最大的那张。
const dirs = ['cache_file', 'pre_cache_file', 'file', 'origin_file', 'download_file', 'getCroppingImg'];
for (const dir of dirs) {
    const url = `https://img.haowallpaper.com/${dir}/2025_10_20_file/${fileId}.png`;
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': UA, Referer: `${BASE}/`, Range: 'bytes=0-0' },
        });
        const total = response.headers.get('content-range')?.split('/')[1];
        console.log(`  ${dir.padEnd(16)} HTTP ${response.status}  ${total ? `${(Number(total) / 1024).toFixed(1)} KB` : response.headers.get('content-length')}`);
    } catch (error) {
        console.log(`  ${dir.padEnd(16)} 失败 ${error.message}`);
    }
}

// 详情页里出现的最大图片（按 href/src 属性）
const allImg = [...new Set([...html.matchAll(/https:\/\/img\.haowallpaper\.com\/[a-z_]+\/[0-9_]+_file\/[0-9]+\.(?:png|webp|jpg)/g)].map((m) => m[0]))];
console.log(`\n详情页图片总数: ${allImg.length}`);
console.log('前 5:', allImg.slice(0, 5).join('\n     '));
