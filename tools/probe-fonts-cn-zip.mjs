/*
 * 下载一个真实 zip 并检查里面的文件类型。
 *
 * 用户说「压缩包里面有具体文件，可以匹配文件后缀名」—— 这里确认：
 *   1. zip 能不能无鉴权下载
 *   2. 里面有哪些后缀（ttf / otf / woff2 …）
 *   3. 哪个是主字体文件（可能有多个字重）
 *
 * 跑法：node tools/probe-fonts-cn-zip.mjs
 */
import { writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BASE = 'https://www.fonts.net.cn';
const fontId = '41569702150';

// 1. 拿下载地址
const referer = `${BASE}/font-${fontId}.html`;
const pageResponse = await fetch(referer, { headers: { 'User-Agent': UA } });
const cookie = (pageResponse.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
await pageResponse.text();

const dlResponse = await fetch(`${BASE}/api/font-download/url`, {
    method: 'POST',
    headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: referer,
        ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams({ fontId }).toString(),
});
const dlJson = await dlResponse.json();
let url = dlJson?.data?.url;
console.log(`下载地址: ${url}`);
if (url.startsWith('//')) url = `https:${url}`;

// 2. 下载
console.log(`\n开始下载...`);
const zipResponse = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: referer },
});
console.log(`HTTP ${zipResponse.status}, content-type=${zipResponse.headers.get('content-type')}`);
const buffer = Buffer.from(await zipResponse.arrayBuffer());
console.log(`体积: ${(buffer.length / 1024).toFixed(1)} KB`);
console.log(`magic: ${buffer.slice(0, 4).toString('hex')}  (504b0304 = ZIP)`);

writeFileSync('tools/_sample.zip', buffer);

// 3. 读 zip 中央目录，列出文件名
const entries = [];
let offset = buffer.length - 22;
while (offset >= 0) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) break;
    offset -= 1;
}
if (offset < 0) {
    console.log('没找到 zip 中央目录结尾');
} else {
    const count = buffer.readUInt16LE(offset + 10);
    let dirOffset = buffer.readUInt32LE(offset + 16);
    console.log(`\nzip 内 ${count} 个文件:`);
    for (let i = 0; i < count; i += 1) {
        if (buffer.readUInt32LE(dirOffset) !== 0x02014b50) break;
        const nameLen = buffer.readUInt16LE(dirOffset + 28);
        const extraLen = buffer.readUInt16LE(dirOffset + 30);
        const commentLen = buffer.readUInt16LE(dirOffset + 32);
        const size = buffer.readUInt32LE(dirOffset + 24);
        const name = buffer.slice(dirOffset + 46, dirOffset + 46 + nameLen).toString('utf8');
        entries.push({ name, size });
        dirOffset += 46 + nameLen + extraLen + commentLen;
    }
    entries.forEach((entry) => console.log(`  ${(entry.size / 1024).toFixed(1).padStart(8)} KB  ${entry.name}`));

    const fonts = entries.filter((e) => /\.(ttf|otf|woff2?|ttc)$/i.test(e.name));
    console.log(`\n字体文件 ${fonts.length} 个:`);
    fonts.forEach((f) => console.log(`  ${f.name}  ${(f.size / 1024).toFixed(1)} KB`));
}
