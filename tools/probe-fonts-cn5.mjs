/*
 * 用真实的数字字体 ID 调下载接口，看未登录到底给不给。
 *
 * 前面用 slug 报 FontNotFound，改用详情页里的数字 id。
 *
 * 跑法：node tools/probe-fonts-cn5.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BASE = 'https://www.fonts.net.cn';

const getHtml = async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    return { status: response.status, text: await response.text(), url: response.url };
};

const list = await getHtml(`${BASE}/fonts-zh-1.html`);
// 抓详情页链接
const detailLinks = [...new Set([...list.text.matchAll(/href="(\/[a-z0-9-]*?font[a-z0-9-]*?-\d+\.html|\/[a-z0-9]+-\d+\.html)"/gi)].map((m) => m[1]))];
console.log(`列表页详情链接 ${detailLinks.length} 个，前 8:`);
console.log(detailLinks.slice(0, 8).join('\n'));

if (detailLinks.length > 0) {
    const first = detailLinks.find((link) => /\d+\.html$/.test(link) && !/fonts-(zh|en|pic)/.test(link));
    console.log(`\n取一个详情页: ${first}`);
    const detail = await getHtml(`${BASE}${first}`);
    console.log(`HTTP ${detail.status}, ${(detail.text.length / 1024).toFixed(0)} KB`);

    // 数字 id：页面里的 data-font-id / FONT_ID 变量
    const ids = [
        ...new Set([
            ...[...detail.text.matchAll(/data-(?:font|id)-?id="(\d+)"/gi)].map((m) => m[1]),
            ...[...detail.text.matchAll(/FONT_ID\s*[=:]\s*["']?(\d+)["']?/gi)].map((m) => m[1]),
            ...[...detail.text.matchAll(/fontId\s*[=:]\s*["']?(\d+)["']?/gi)].map((m) => m[1]),
        ]),
    ];
    console.log(`页面里的数字 id: ${ids.slice(0, 8).join(', ') || '无'}`);

    // 下载按钮上的 data-id
    const btn = /data-button="download"[^>]*/.exec(detail.text)?.[0]
        ?? /<button[^>]*data-button="download"[^>]*>/.exec(detail.text)?.[0];
    console.log(`下载按钮: ${btn}`);

    // 页面上所有 data-* 属性名，看有没有带 id 的
    const dataAttrs = [...new Set([...detail.text.matchAll(/data-([a-z-]*(?:font|id)[a-z-]*)="([^"]{1,30})"/gi)].map((m) => `${m[1]}=${m[2]}`))];
    console.log(`data-* 属性（含 id/font）: ${dataAttrs.slice(0, 15).join(', ') || '无'}`);

    // 字体名
    const title = /<title>([\s\S]*?)<\/title>/.exec(detail.text)?.[1]?.trim();
    console.log(`标题: ${title}`);

    if (ids.length > 0) {
        const fontId = ids[0];
        console.log(`\n=== 用 fontId=${fontId} 调下载接口 ===`);
        for (const body of [{ fontId }, { fontId: Number(fontId) }, { id: fontId }, { id: Number(fontId) }]) {
            const response = await fetch(`${BASE}/api/font-download/url`, {
                method: 'POST',
                headers: {
                    'User-Agent': UA,
                    Accept: 'application/json, text/plain, */*',
                    'Content-Type': 'application/json',
                    Referer: `${BASE}${first}`,
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body: JSON.stringify(body),
            });
            const text = await response.text();
            console.log(`  ${JSON.stringify(body)} -> ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
        }
    }
}
