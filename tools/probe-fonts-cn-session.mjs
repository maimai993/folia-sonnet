/*
 * 重新验证：未登录到底能不能下载？
 *
 * 用户说他那边没登录点下载也能下。我上一轮用的是最简 cookie 空 + form 编码。
 * 这次带上浏览器会有的完整头（Origin、Sec-Fetch-*、真实 UA 等），
 * 并且先访问页面拿 cookie，再调接口 —— 很多站靠 cookie 里的匿名会话判断。
 *
 * 跑法：node tools/probe-fonts-cn-session.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BASE = 'https://www.fonts.net.cn';
const fontId = '37476120124';

// 1. 先访问详情页，收集 cookie
const pageResponse = await fetch(`${BASE}/font-${fontId}.html`, {
    headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
    },
});
console.log(`详情页 HTTP ${pageResponse.status}`);

// 收 cookie
const setCookie = pageResponse.headers.getSetCookie?.() ?? [];
console.log(`Set-Cookie ${setCookie.length} 条:`);
setCookie.forEach((c) => console.log(`  ${c.split(';')[0]}`));
const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
console.log(`拼接后的 cookie: ${cookie || '(空)'}`);

await pageResponse.text();

// 2. 带 cookie + 完整头再调
const post = async (path, fields) => {
    const response = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'User-Agent': UA,
            Accept: '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: BASE,
            Referer: `${BASE}/font-${fontId}.html`,
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            ...(cookie ? { Cookie: cookie } : {}),
        },
        body: new URLSearchParams(fields).toString(),
    });
    return { status: response.status, text: await response.text() };
};

console.log('\n=== product/info（带会话）===');
const info = await post('/api/font-product/info', { fontId });
console.log(info.text.slice(0, 500));

console.log('\n=== download/url（带会话）===');
const download = await post('/api/font-download/url', { fontId });
console.log(download.text.slice(0, 500));

// 3. 试 /font-download.html 这个页面（DOWNLOAD_FONT_URL 指向它）
console.log('\n=== /font-download.html?fontId= ===');
const dlPage = await fetch(`${BASE}/font-download.html?fontId=${fontId}`, {
    headers: { 'User-Agent': UA, Referer: `${BASE}/font-${fontId}.html`, ...(cookie ? { Cookie: cookie } : {}) },
    redirect: 'follow',
});
console.log(`HTTP ${dlPage.status} -> ${dlPage.url}`);
const dlHtml = await dlPage.text();
// 找页面里的下载链接
const zipLinks = [...new Set([...dlHtml.matchAll(/["']([^"']*\.(?:zip|rar|7z|ttf|otf)[^"']*)["']/gi)].map((m) => m[1]))];
console.log(`页面里的文件链接: ${zipLinks.slice(0, 5).join(', ') || '无'}`);
const downVars = [...dlHtml.matchAll(/var\s+\w*DOWNLOAD\w*\s*=\s*[^;]+;/g)].map((m) => m[0]);
console.log(`下载相关变量: ${downVars.join(' ').slice(0, 300) || '无'}`);
