/*
 * 为什么"字魂白鸽天行体"下载失败？
 *
 * 用户看到的提示是「此字体已停止下载」。要弄清：
 *   1. 这个错误码是哪个（FontDownloadDisabled?）
 *   2. 是我漏了必要参数/header，还是这个字体真的停了
 *   3. 同类字体里有多少是这种情况 —— 决定是不是选品问题
 *
 * 跑法：node tools/probe-fonts-cn-download-state.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const BASE = 'https://www.fonts.net.cn';

/** 拿详情页并建会话，返回 cookie 与页面文本。 */
const openSession = async (fontId) => {
    const response = await fetch(`${BASE}/font-${fontId}.html`, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    const cookie = setCookie.map((entry) => entry.split(';')[0]).join('; ');
    const html = await response.text();
    return { cookie, html };
};

const requestDownload = async (fontId) => {
    const { cookie, html } = await openSession(fontId);
    const response = await fetch(`${BASE}/api/font-download/url`, {
        method: 'POST',
        headers: {
            'User-Agent': UA,
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: `${BASE}/font-${fontId}.html`,
            Origin: BASE,
            Cookie: cookie,
        },
        body: `fontId=${encodeURIComponent(fontId)}`,
    });
    const body = await response.text();
    // 页面上有没有"停止下载"之类的说明
    const notice = /停止下载|已下架|暂停下载|版权/.exec(html)?.[0] ?? '';
    return { status: response.status, body, notice, htmlLength: html.length };
};

const targets = [
    { id: '37476120124', name: '字魂白鸽天行体' },
    { id: '33115320682', name: '青鸟华光简美黑' },
    { id: '45666408022', name: '山海夏日烟火W' },
];

for (const target of targets) {
    const result = await requestDownload(target.id);
    console.log(`\n=== ${target.name} (${target.id}) ===`);
    console.log(`  HTTP ${result.status}  详情页 ${result.htmlLength} 字节`);
    console.log(`  页面提示: ${result.notice || '（无）'}`);
    console.log(`  接口返回: ${result.body.slice(0, 200)}`);
}
