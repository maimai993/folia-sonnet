/*
 * 验证 moewalls 的高清下载端点：go.moewalls.com/download.php?video={data-url}。
 *
 * data-url 是加密串，不需要解密，原样拼上去即可（Mineradio 的做法）。
 * 这里真的发一次请求，看重定向到哪、能拿到多大的视频。
 *
 * 跑法：node tools/probe-moewalls-dl2.mjs
 */
const UA = 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const detailUrl = 'https://moewalls.com/anime/dark-goth-girl-live-wallpaper/';
const html = await (await fetch(detailUrl, {
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8' },
})).text();

const dataUrl = /<a[^>]*id="moe-download"[^>]*data-url\s*=\s*"([^"]+)"/.exec(html)?.[1]
    ?? /data-url\s*=\s*"([^"]+)"[^>]*id="moe-download"/.exec(html)?.[1];

console.log(`data-url 长度: ${dataUrl?.length}`);
console.log(`data-url 前 60: ${dataUrl?.slice(0, 60)}`);

if (!dataUrl) {
    console.log('没找到 data-url，解析规则要改');
    process.exit(1);
}

const downloadUrl = `https://go.moewalls.com/download.php?video=${dataUrl}`;
console.log(`\n请求: ${downloadUrl.slice(0, 110)}...`);

const response = await fetch(downloadUrl, {
    headers: { 'User-Agent': UA, Referer: detailUrl, Accept: '*/*' },
    // 不跟随重定向，先看重定向到哪
    redirect: 'manual',
});

console.log(`状态: ${response.status}`);
console.log('重定向到:', response.headers.get('location')?.slice(0, 160));
console.log('content-type:', response.headers.get('content-type'));

// 跟随一次，看最终是什么
const followed = await fetch(downloadUrl, {
    headers: { 'User-Agent': UA, Referer: detailUrl, Accept: '*/*' },
    redirect: 'follow',
});
console.log(`\n跟随重定向后: ${followed.status} ${followed.headers.get('content-type')}`);
console.log('最终 URL:', followed.url.slice(0, 160));
const length = followed.headers.get('content-length');
console.log('体积:', length ? `${(Number(length) / 1024 / 1024).toFixed(2)} MB` : '未知');

// 读前 16 字节确认是视频
const buffer = new Uint8Array(await followed.arrayBuffer());
const magic = [...buffer.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
const ftyp = String.fromCharCode(...buffer.slice(4, 8));
console.log(`前 8 字节: ${magic}  (ftyp=${ftyp}) 实际读取 ${buffer.length} 字节`);
