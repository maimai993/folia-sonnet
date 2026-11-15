/*
 * 验证 Mineradio 用的那两个公开端点现在是否还有效。
 *
 * 只试 img.haowallpaper.com 会误判成「拿不到原图」，主站上还有 link//common/file/ 这套。
 * 同一个 fileId 分别探图片与视频端点，看状态、类型、体积。
 *
 * 跑法：node tools/probe-hw-link.mjs
 */
const UA = 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const fileId = '17815907003452800';

const candidates = [
    ['图片 getCroppingImg', `https://haowallpaper.com/link//common/file/getCroppingImg/${fileId}`],
    ['图片 getPreviewFileImg', `https://haowallpaper.com/link//common/file/getPreviewFileImg/${fileId}`],
    ['视频 getVideoReduce', `https://haowallpaper.com/link//common/file/getVideoReduce/${fileId}`],
    ['图片 单斜杠', `https://haowallpaper.com/link/common/file/getCroppingImg/${fileId}`],
];

for (const [label, url] of candidates) {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': UA,
                Referer: 'https://haowallpaper.com/',
                Range: 'bytes=0-9',
            },
        });
        const total = response.headers.get('content-range')?.split('/')[1] ?? response.headers.get('content-length');
        const type = response.headers.get('content-type');
        const buffer = new Uint8Array(await response.arrayBuffer());
        const magic = [...buffer.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
        const size = total ? `${(Number(total) / 1024).toFixed(1)} KB` : '?';
        console.log(`${label.padEnd(24)} HTTP ${response.status}  ${type}  ${size}  magic=${magic}`);
    } catch (error) {
        console.log(`${label.padEnd(24)} 失败 -> ${error.message}`);
    }
}
