/*
 * 换不同类型的字体再试下载。
 *
 * 前面只试了「字魂」「汉呈」这些商业字体。用户说没登录也能下，
 * 那多半是**免费字体**（开源字体搬运）可以下，商业字体才要激活。
 * 这里按分类找一批候选，逐个看下载码。
 *
 * 跑法：node tools/probe-fonts-cn-kinds.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BASE = 'https://www.fonts.net.cn';

const getHtml = async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    const cookie = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    return { status: response.status, text: await response.text(), cookie };
};

const postForm = async (path, fields, referer, cookie) => {
    const response = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'User-Agent': UA,
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: BASE,
            Referer: referer,
            ...(cookie ? { Cookie: cookie } : {}),
        },
        body: new URLSearchParams(fields).toString(),
    });
    return response.json();
};

// 多个入口：中文、英文、按标签（开源字体常见标签）
const entries = [
    ['中文第2页', `${BASE}/fonts-zh-2.html`],
    ['英文', `${BASE}/fonts-en-1.html`],
    ['黑体标签', `${BASE}/fonts-zh/tag-heiti-1.html`],
    ['草书标签', `${BASE}/fonts-zh/tag-caoshu-1.html`],
];

const seen = new Set();
for (const [label, url] of entries) {
    const list = await getHtml(url);
    const ids = [...new Set([...list.text.matchAll(/\/font-(\d+)\.html/g)].map((m) => m[1]))].filter((id) => !seen.has(id));
    ids.slice(0, 6).forEach((id) => seen.add(id));
    console.log(`\n${label}: ${ids.length} 个 id，试前 6 个`);
    for (const id of ids.slice(0, 6)) {
        const referer = `${BASE}/font-${id}.html`;
        const detail = await getHtml(referer);
        const name = /<title>([\s\S]*?)<\/title>/.exec(detail.text)?.[1]?.split('字体')[0]?.trim() ?? '?';
        const info = await postForm('/api/font-product/info', { fontId: id }, referer, detail.cookie);
        const dl = await postForm('/api/font-download/url', { fontId: id }, referer, detail.cookie);
        const code = dl.success ? 'OK' : (dl.code ?? '?');
        const url_ = dl?.data?.url;
        console.log(`  ${id.padEnd(14)} ${String(code).padEnd(30)} ${name}`);
        if (url_) console.log(`     → ${url_}`);
    }
}
