/*
 * 实测 /api/font-download/url 的行为：未登录时返回什么？
 *
 * 这决定 fonts.net.cn 能不能当字体源 —— 如果下载必须登录+激活，
 * 那"市场里点一下就下载"根本做不到，界面得改成引导到官网。
 *
 * 跑法：node tools/probe-fonts-cn4.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BASE = 'https://www.fonts.net.cn';

const callApi = async (path, body) => {
    const label = `${path}${body ? ' (POST)' : ' (GET)'}`;
    try {
        const response = await fetch(`${BASE}${path}`, {
            method: body ? 'POST' : 'GET',
            headers: {
                'User-Agent': UA,
                Accept: 'application/json, text/plain, */*',
                'Content-Type': 'application/json',
                Referer: `${BASE}/fonts-zh-1.html`,
                'X-Requested-With': 'XMLHttpRequest',
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await response.text();
        console.log(`${label} -> HTTP ${response.status}`);
        console.log(`   ${text.slice(0, 300).replace(/\s+/g, ' ')}`);
        return { status: response.status, text };
    } catch (error) {
        console.log(`${label} -> 失败 ${error.message}`);
        return null;
    }
};

// 先拿一个真实字体 id：从列表页解析
const listHtml = await (await fetch(`${BASE}/fonts-zh-1.html`, { headers: { 'User-Agent': UA } })).text();
const fontIds = [...new Set([...listHtml.matchAll(/\/font-([a-z0-9-]+)\.html/gi)].map((m) => m[1]))];
console.log(`列表页找到 ${fontIds.length} 个字体 slug，前 5: ${fontIds.slice(0, 5).join(', ')}`);

console.log('\n=== 未登录调用 ===');
await callApi('/api/font-download/url', { fontId: fontIds[0] });
await callApi('/api/font-download/url', { id: fontIds[0] });
await callApi('/api/font-product/info', { fontId: fontIds[0] });
await callApi('/api/user/current');
