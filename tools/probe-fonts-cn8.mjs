/*
 * 找 apis.download(...) 的调用点，看它传什么字段。
 *
 * 跑法：node tools/probe-fonts-cn8.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const js = await (await fetch('https://static.fonts.net.cn/3.1.1.26110501/assets/js/dist.app-web.js', {
    headers: { 'User-Agent': UA },
})).text();

// apis.download 的所有调用形态
const patterns = [
    /apis\.download\s*\(/g,
    /apis\.productInfo\s*\(/g,
    /fontId\s*:/g,
    /font_id\s*:/g,
    /fontKey/g,
    /fontCode/g,
];

for (const pattern of patterns) {
    const matches = [...js.matchAll(pattern)];
    if (matches.length === 0) continue;
    console.log(`\n=== ${pattern.source} （${matches.length} 处）===`);
    for (const match of matches.slice(0, 3)) {
        const at = match.index;
        console.log('---');
        console.log(js.slice(Math.max(0, at - 200), at + 400).replace(/\s+/g, ' '));
    }
}
