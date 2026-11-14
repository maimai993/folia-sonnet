/*
 * haowallpaper 两条视频路径对比：video_reduce_file vs pre_cache_file。
 *
 * 解析器里我选了 pre_cache_file（假设更清楚），这个假设必须验证：
 * 要是它 404，视频就全坏了；要是它反而更小，那就该用另一个。
 *
 * 跑法：node tools/probe-hw-video-compare.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const samples = [
    ['2025_10_20_file', '17815907003452800'],
    ['2025_09_13_file', '17603630336822656'],
    ['2025_08_29_file', '17518936273046912'],
];

for (const [dateDir, fileId] of samples) {
    console.log(`\n${fileId}:`);
    for (const dir of ['video_reduce_file', 'pre_cache_file']) {
        const url = `https://img.haowallpaper.com/${dir}/${dateDir}/${fileId}.mp4`;
        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': UA, Referer: 'https://haowallpaper.com/', Range: 'bytes=0-15' },
            });
            const total = Number(response.headers.get('content-range')?.split('/')[1] ?? 0);
            const buffer = new Uint8Array(await response.arrayBuffer());
            const ftyp = String.fromCharCode(...buffer.slice(4, 8));
            console.log(`  ${dir.padEnd(20)} HTTP ${response.status}  ${(total / 1024).toFixed(1).padStart(7)} KB  ftyp=${ftyp}`);
        } catch (error) {
            console.log(`  ${dir.padEnd(20)} 失败 ${error.message}`);
        }
    }
}
