/*
 * 验证「详情页里 font-download 出现次数」能否判断可下载性。
 *
 * 待验证规律：可下载 = 2 次，已停止 = 1 次。
 * 如果成立，列表页若也有同样标记，就能在不点的情况下标出来。
 *
 * 跑法：node tools/probe-fonts-cn-downloadable-flag2.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const BASE = 'https://www.fonts.net.cn';
const get = async (url) => (await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } })).text();

const countDownloadMarkers = (html) => ({
    fontDownload: (html.match(/font-download/g) ?? []).length,
    // 可能的其它标记
    stopDownload: (html.match(/停止下载|暂停下载/g) ?? []).length,
});

/** 真的去请求下载接口，作为判定基准。 */
const canDownload = async (fontId) => {
    const detail = await fetch(`${BASE}/font-${fontId}.html`, { headers: { 'User-Agent': UA } });
    const cookie = (detail.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ');
    const response = await fetch(`${BASE}/api/font-download/url`, {
        method: 'POST',
        headers: {
            'User-Agent': UA,
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: `${BASE}/font-${fontId}.html`,
            Cookie: cookie,
        },
        body: `fontId=${encodeURIComponent(fontId)}`,
    });
    const json = await response.json().catch(() => null);
    return { ok: Boolean(json?.success), code: json?.code ?? null };
};

// 从中文列表页抓一批
const list = await get(`${BASE}/fonts-zh-1.html`);
const cards = list.match(/<li>\s*<div class="site_font_list_item_head"[\s\S]*?<\/li>/g) ?? [];
const items = [];
const seen = new Set();
for (const card of cards) {
    const id = /\/font-(\d+)\.html/.exec(card)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push({ id, name: (/class="site_font_name"[^>]*title="([^"]*)"/.exec(card)?.[1] ?? '').trim() });
}

console.log(`抽查 ${Math.min(items.length, 10)} 个字体\n`);
let correct = 0;
let total = 0;
for (const item of items.slice(0, 10)) {
    const detail = await get(`${BASE}/font-${item.id}.html`);
    const markers = countDownloadMarkers(detail);
    const actual = await canDownload(item.id);
    // 规律：可下载 => fontDownload >= 2
    const predicted = markers.fontDownload >= 2;
    const hit = predicted === actual.ok;
    total += 1;
    if (hit) correct += 1;
    console.log(
        `  ${item.name.slice(0, 14).padEnd(16)} font-download=${String(markers.fontDownload).padEnd(2)} ` +
        `预测=${predicted ? '可下' : '停了'}  实际=${actual.ok ? '可下' : (actual.code ?? '失败')}  ${hit ? '✓' : '✗'}`,
    );
}
console.log(`\n准确率: ${correct}/${total}`);

// 列表页有没有同样的标记
console.log('\n列表页 font-download 出现次数:', (list.match(/font-download/g) ?? []).length);
