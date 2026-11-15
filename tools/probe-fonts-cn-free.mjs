/*
 * fonts.net.cn 里哪些字体能免费下载？
 *
 * 上一轮：字魂白鸽天行体 → FontDownloadDisabled + activated:false。
 * 站上一定有免激活的（开源字体的搬运），找出来并确认下载能真拿到 zip。
 *
 * 跑法：node tools/probe-fonts-cn-free.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BASE = 'https://www.fonts.net.cn';

const getHtml = async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    return { status: response.status, text: await response.text() };
};

const postForm = async (path, fields, referer) => {
    const response = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'User-Agent': UA,
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: referer,
        },
        body: new URLSearchParams(fields).toString(),
    });
    return response.json();
};

// 列表页抓一批字体 id
const list = await getHtml(`${BASE}/fonts-zh-1.html`);
const ids = [...new Set([...list.text.matchAll(/\/font-(\d+)\.html/g)].map((m) => m[1]))];
console.log(`列表页拿到 ${ids.length} 个字体 id`);

const results = [];
for (const id of ids.slice(0, 12)) {
    const detail = await getHtml(`${BASE}/font-${id}.html`);
    const name = /<title>([\s\S]*?)<\/title>/.exec(detail.text)?.[1]?.split('字体')[0]?.trim() ?? '';
    const referer = `${BASE}/font-${id}.html`;

    const info = await postForm('/api/font-product/info', { fontId: id }, referer);
    const product = info?.data?.products?.download;
    const activated = info?.data?.permission?.activated;

    // 只有 product 存在（说明有下载商品）才值得试下载
    let downloadUrl = null;
    let downloadCode = null;
    if (product) {
        const dl = await postForm('/api/font-download/url', { fontId: id }, referer);
        downloadCode = dl.code ?? (dl.success ? 'OK' : 'unknown');
        downloadUrl = dl?.data?.url ?? null;
    }

    const line = `${id.padEnd(14)} ${(product ? '有商品' : '无商品').padEnd(6)} 激活=${String(activated).padEnd(5)} ${String(downloadCode ?? '-').padEnd(22)} ${name}`;
    console.log(line);
    if (downloadUrl) {
        console.log(`   → ${downloadUrl}`);
        results.push({ id, name, downloadUrl });
    }
}

console.log(`\n能拿到下载地址的: ${results.length} 个`);
results.slice(0, 3).forEach((r) => console.log(`  ${r.name}: ${r.downloadUrl}`));
