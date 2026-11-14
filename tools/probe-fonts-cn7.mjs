/*
 * 把 app-web.js 里调用 /api/font-download/url 的那段代码完整挖出来。
 *
 * 猜参数名已经浪费两轮了，直接看它怎么调。
 *
 * 跑法：node tools/probe-fonts-cn7.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const response = await fetch('https://static.fonts.net.cn/3.1.1.26110501/assets/js/dist.app-web.js', {
    headers: { 'User-Agent': UA },
});
const js = await response.text();

// 1. 所有出现 font-download/url 的地方
let index = js.indexOf('font-download/url');
let round = 0;
while (index >= 0 && round < 5) {
    console.log(`\n=== 第 ${round + 1} 处 @${index} ===`);
    console.log(js.slice(Math.max(0, index - 500), index + 500).replace(/\s+/g, ' '));
    index = js.indexOf('font-download/url', index + 1);
    round += 1;
}

// 2. download 这个键被谁用
console.log('\n\n=== 用到 .download 的调用 ===');
const calls = [...js.matchAll(/.{120}download:.{200}/g)].slice(0, 5);
calls.forEach((match) => console.log('---\n' + match[0].replace(/\s+/g, ' ')));

// 3. 请求封装：看它怎么拼 body（可能字段名是 fontKey / fontCode 之类）
console.log('\n\n=== 请求封装（post/ajax）===');
for (const keyword of ['postJSON', 'request(', 'fetch(', 'ajax(']) {
    const at = js.indexOf(keyword);
    if (at >= 0) {
        console.log(`--- ${keyword} @${at} ---`);
        console.log(js.slice(Math.max(0, at - 100), at + 400).replace(/\s+/g, ' '));
    }
}
