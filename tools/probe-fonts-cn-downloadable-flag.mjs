/*
 * 列表页能不能提前看出"哪些字体不能下载"？
 *
 * 用户点了一个停了下发的字体才看到失败，体验很差。
 * 理想做法是列表上就标出来。找找列表卡片里有没有相关标记。
 *
 * 跑法：node tools/probe-fonts-cn-downloadable-flag.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const BASE = 'https://www.fonts.net.cn';
const get = async (url) => (await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } })).text();

// 已知可下载 vs 已知被停的，各看详情页与列表页
const samples = [
    { id: '37476120124', name: '字魂白鸽天行体', downloadable: false },
    { id: '33115320682', name: '青鸟华光简美黑', downloadable: true },
];

for (const sample of samples) {
    const detail = await get(`${BASE}/font-${sample.id}.html`);
    console.log(`\n=== ${sample.name}（${sample.downloadable ? '可下载' : '已停止'}）===`);
    // 详情页里与下载状态相关的按钮/类名
    for (const marker of ['停止下载', '立即下载', '下载字体', 'font-download', 'btn-download', 'disabled']) {
        const count = (detail.match(new RegExp(marker, 'g')) ?? []).length;
        if (count > 0) console.log(`  "${marker}" × ${count}`);
    }
    // 下载按钮附近的 HTML
    const at = detail.search(/下载/);
    if (at > 0) console.log(`  下载字样附近: ${detail.slice(Math.max(0, at - 200), at + 160).replace(/\s+/g, ' ')}`);
}
