/*
 * 探清楚：haowallpaper 到底有没有"高清原图"端点，还是它本身就只有缩略图 + 视频。
 *
 * 已知 getCroppingImg 返回 23.9 KB 的 webp（RIFF），太小，做壁纸不能用。
 * 这里逐个试常见端点名，并把返回体积列出来对比。
 *
 * 跑法：node tools/probe-hw-original.mjs
 */
const UA = 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const fileId = '17815907003452800';
const videoFileId = '17815907003452800';

// 主站 link//common/file/ 下可能的端点名
const endpoints = [
    'getFileImg', 'getFile', 'getImg', 'getImage', 'getOriginalImg', 'getOriginalFileImg',
    'getDownloadImg', 'getWallpaper', 'getFaceImg', 'getWallpaperImg', 'getPicImg',
    'getCroppingImg', 'getPreviewFileImg', 'getVideoReduce', 'getVideoFile', 'getVideo',
];

const probe = async (url) => {
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': UA, Referer: 'https://haowallpaper.com/', Range: 'bytes=0-9' },
        });
        if (!response.ok) return { ok: false, status: response.status };
        const total = Number(response.headers.get('content-range')?.split('/')[1] ?? response.headers.get('content-length') ?? 0);
        const buffer = new Uint8Array(await response.arrayBuffer());
        const magic = [...buffer.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
        return { ok: true, status: response.status, total, type: response.headers.get('content-type'), magic };
    } catch (error) {
        return { ok: false, error: error.message };
    }
};

console.log('== 主站 link//common/file/ 端点探测 ==');
for (const endpoint of endpoints) {
    const result = await probe(`https://haowallpaper.com/link//common/file/${endpoint}/${fileId}`);
    if (result.ok) {
        console.log(`  ✓ ${endpoint.padEnd(22)} ${(result.total / 1024).toFixed(1).padStart(7)} KB  ${result.type}  magic=${result.magic}`);
    } else {
        console.log(`  ✗ ${endpoint.padEnd(22)} ${result.status ?? result.error}`);
    }
}

// 详情页里"下载"按钮的真实行为：找 download / href 里的完整文件
const detailUrl = 'https://haowallpaper.com/homeViewLook/17815999759895936';
const html = await (await fetch(detailUrl, { headers: { 'User-Agent': UA } })).text();

console.log('\n== 详情页里的下载线索 ==');
const downloadAttrs = [...html.matchAll(/(?:download|href|data-url|data-src|content)="([^"]{20,200})"/g)]
    .map((m) => m[1])
    .filter((v) => /\.(jpg|jpeg|png|webp|mp4)|download|file/i.test(v));
console.log([...new Set(downloadAttrs)].slice(0, 15).join('\n') || '  无');

// 页面里出现过的所有"大文件"格式
console.log('\n== 页面里的文件地址（按后缀归类）==');
const files = [...new Set([...html.matchAll(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp|mp4|zip)/gi)].map((m) => m[0]))];
const byExt = {};
for (const file of files) {
    const ext = file.split('.').pop().toLowerCase();
    byExt[ext] = (byExt[ext] ?? 0) + 1;
}
console.log(byExt);
