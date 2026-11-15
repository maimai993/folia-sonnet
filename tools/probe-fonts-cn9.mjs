/*
 * 用 jQuery 的默认编码（form-urlencoded）调下载接口。
 *
 * 之前发的是 JSON，服务端解析不到 fontId 所以报 FontNotFound。
 * jQuery $.ajax({data:{fontId}}) 默认发的是 application/x-www-form-urlencoded。
 *
 * 跑法：node tools/probe-fonts-cn9.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BASE = 'https://www.fonts.net.cn';
const fontId = '37476120124';

const postForm = async (path, fields) => {
    const body = new URLSearchParams(fields).toString();
    const response = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'User-Agent': UA,
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: `${BASE}/font-${fontId}.html`,
        },
        body,
    });
    return { status: response.status, text: await response.text() };
};

console.log('=== /api/font-product/info (form) ===');
const info = await postForm('/api/font-product/info', { fontId });
console.log(`HTTP ${info.status}`);
console.log(info.text.slice(0, 700));

console.log('\n=== /api/font-download/url (form) ===');
const download = await postForm('/api/font-download/url', { fontId });
console.log(`HTTP ${download.status}`);
console.log(download.text.slice(0, 700));
