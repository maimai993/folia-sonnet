/*
 * 验证 haowallpaper 的图片与视频地址真的能下载，并看清体积。
 *
 * 只看「路径拼对了」不够 —— 上一轮字体分片就是解析全对、地址却 404。
 *
 * 跑法：node tools/probe-haowallpaper-media.mjs
 */
const UA = 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const candidates = [
    ['图片 完整', 'https://img.haowallpaper.com/cache_file/2025_10_20_file/17815907003452800.png'],
    ['视频 完整', 'https://img.haowallpaper.com/pre_cache_file/2025_10_20_file/17815907003452800.mp4'],
    ['视频 预览', 'https://img.haowallpaper.com/video_reduce_file/2025_10_20_file/17815907003452800.mp4'],
];

for (const [label, url] of candidates) {
    try {
        // 先只取头部，避免把几 MB 整个拉下来。
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'User-Agent': UA, Referer: 'https://haowallpaper.com/', Range: 'bytes=0-1023' },
        });
        const contentType = response.headers.get('content-type');
        const contentRange = response.headers.get('content-range');
        const length = response.headers.get('content-length');
        const buffer = new Uint8Array(await response.arrayBuffer());
        const magic = [...buffer.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`${label}: HTTP ${response.status}  type=${contentType}  len=${length}  range=${contentRange}  magic=${magic}`);
        console.log(`   ${url}`);
    } catch (error) {
        console.log(`${label}: 失败 -> ${error.message}`);
    }
}
