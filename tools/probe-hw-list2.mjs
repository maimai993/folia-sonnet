/*
 * wallpaperList 的必填参数是什么？
 *
 * 400 Bad Request 说明参数缺失或名字不对。到分块里找调用点，把 data:{} 打出来。
 *
 * 跑法：node tools/probe-hw-list2.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const home = await (await fetch('https://www.haowallpaper.com/', { headers: { 'User-Agent': UA } })).text();
const chunks = [...new Set([...home.matchAll(/\/_nuxt\/[A-Za-z0-9._-]+\.js/g)].map((m) => m[0]))];

for (const chunk of chunks) {
    const text = await (await fetch(`https://www.haowallpaper.com${chunk}`, { headers: { 'User-Agent': UA } })).text();
    const at = text.indexOf('wallpaper/wallpaperList');
    if (at < 0) continue;
    console.log(`=== ${chunk} ===`);
    console.log(text.slice(Math.max(0, at - 700), at + 700).replace(/\s+/g, ' '));
    console.log('');
}
