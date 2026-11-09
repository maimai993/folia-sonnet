/*
 * 摸清 moewalls（视频壁纸源）的结构。
 *
 * 从服务器这边访问会 403（Cloudflare 挡机房 IP），但用户手机能访问 ——
 * 所以解析逻辑必须写得对，没法用真实响应反复验证。这里尽量用能拿到的信息
 * 对齐 Mineradio 的解析规则，并列出我们依赖的每一个选择器。
 *
 * 跑法：node tools/probe-moewalls.mjs
 */
const UA = 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const urls = [
    'https://moewalls.com/',
    'https://moewalls.com/anime/',
    'https://moewalls.com/latest-wallpapers/',
];

for (const url of urls) {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': UA,
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                Referer: 'https://moewalls.com/',
            },
        });
        const text = await response.text();
        console.log(`${url} -> HTTP ${response.status}, ${(text.length / 1024).toFixed(0)} KB`);
        if (response.ok) {
            console.log(text.slice(0, 500));
        }
    } catch (error) {
        console.log(`${url} -> 失败 ${error.message}`);
    }
}
