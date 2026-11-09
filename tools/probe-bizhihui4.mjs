/*
 * 验证 bizhihui 的「去掉 -pcthumbs 就是原图」以及原图是否真能下载、多大。
 *
 * 跑法：node tools/probe-bizhihui4.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const thumb = 'https://s.panlai.com/zb_users/upload/2026/08/bizhihui_com_202608221787381582780323.jpg-pcthumbs';
const full = thumb.replace(/-pcthumbs$/, '');

for (const [label, url] of [['缩略图', thumb], ['原图', full]]) {
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': UA, Referer: 'https://www.bizhihui.com/', Range: 'bytes=0-15' },
        });
        const total = Number(response.headers.get('content-range')?.split('/')[1] ?? response.headers.get('content-length') ?? 0);
        const buffer = new Uint8Array(await response.arrayBuffer());
        const magic = [...buffer.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`${label}: HTTP ${response.status}  ${response.headers.get('content-type')}  ${(total / 1024).toFixed(1)} KB  magic=${magic}`);
        console.log(`  ${url}`);
    } catch (error) {
        console.log(`${label}: 失败 -> ${error.message}`);
    }
}
