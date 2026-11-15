/*
 * 验证解压与后缀匹配的**完整流程**，并且专门测试多文件包。
 *
 * 到目前为止抽到的包都只有一个 .ttf。但用户提醒后缀不一定 —— 所以要确认：
 *   1. 解压出来是不是真的 TTF（读 magic：00010000 / true / typ1）
 *   2. 万一包里有两个以上字体文件，选哪个
 *   3. 万一有 .docx/.txt 之类的干扰文件，别选错
 *
 * 跑法：node tools/probe-fonts-cn-unzip.mjs
 */
import { inflateRawSync } from 'node:zlib';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BASE = 'https://www.fonts.net.cn';

const getHtml = async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    const cookie = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    return { text: await response.text(), cookie };
};

const postForm = async (path, fields, referer, cookie) => {
    const response = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'User-Agent': UA,
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: referer,
            ...(cookie ? { Cookie: cookie } : {}),
        },
        body: new URLSearchParams(fields).toString(),
    });
    return response.json();
};

/** 解析中央目录并解压指定条目。 */
const readZip = (buffer) => {
    let offset = buffer.length - 22;
    while (offset >= 0 && buffer.readUInt32LE(offset) !== 0x06054b50) offset -= 1;
    if (offset < 0) throw new Error('不是 zip');
    const count = buffer.readUInt16LE(offset + 10);
    let dirOffset = buffer.readUInt32LE(offset + 16);
    const entries = [];
    for (let i = 0; i < count; i += 1) {
        if (buffer.readUInt32LE(dirOffset) !== 0x02014b50) break;
        const nameLen = buffer.readUInt16LE(dirOffset + 28);
        const extraLen = buffer.readUInt16LE(dirOffset + 30);
        const commentLen = buffer.readUInt16LE(dirOffset + 32);
        entries.push({
            name: buffer.slice(dirOffset + 46, dirOffset + 46 + nameLen).toString('utf8'),
            method: buffer.readUInt16LE(dirOffset + 10),
            compressedSize: buffer.readUInt32LE(dirOffset + 20),
            size: buffer.readUInt32LE(dirOffset + 24),
            localOffset: buffer.readUInt32LE(dirOffset + 42),
        });
        dirOffset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
};

const extract = (buffer, entry) => {
    const at = entry.localOffset;
    if (buffer.readUInt32LE(at) !== 0x04034b50) throw new Error('本地头不对');
    const nameLen = buffer.readUInt16LE(at + 26);
    const extraLen = buffer.readUInt16LE(at + 28);
    const start = at + 30 + nameLen + extraLen;
    const raw = buffer.slice(start, start + entry.compressedSize);
    if (entry.method === 0) return raw;                       // stored
    if (entry.method === 8) return inflateRawSync(raw);       // deflate
    throw new Error(`不支持的压缩方式 ${entry.method}`);
};

/** 判断字体文件类型。 */
const sniff = (bytes) => {
    const hex = bytes.slice(0, 4).toString('hex');
    if (hex === '00010000') return 'truetype (TTF)';
    if (hex === '4f54544f') return 'opentype CFF (OTF)';
    if (hex === '74746366') return 'ttc collection';
    if (hex === '774f4646') return 'woff';
    if (hex === '774f4632') return 'woff2';
    if (hex === '74727565') return 'truetype (true)';
    return `未知 (${hex})`;
};

const fontId = '41569702150';
const referer = `${BASE}/font-${fontId}.html`;
const detail = await getHtml(referer);
const dl = await postForm('/api/font-download/url', { fontId }, referer, detail.cookie);
let url = dl.data.url.startsWith('//') ? `https:${dl.data.url}` : dl.data.url;

const pack = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': UA, Referer: referer } })).arrayBuffer());
const entries = readZip(pack);
console.log(`包内 ${entries.length} 项:`);

for (const entry of entries) {
    const isDir = entry.name.endsWith('/');
    console.log(`  ${isDir ? '[目录]' : '[文件]'} ${entry.name}  ${(entry.size / 1024).toFixed(1)} KB  压缩方式=${entry.method}`);
    if (isDir) continue;

    const bytes = extract(pack, entry);
    console.log(`      解压后 ${(bytes.length / 1024).toFixed(1)} KB，类型: ${sniff(bytes)}`);

    // 读字体 name 表里的家族名（确认是可用的字体，不是别的文件）
    if (bytes.length > 12) {
        const numTables = bytes.readUInt16BE(4);
        console.log(`      sfnt 表数: ${numTables}`);
    }
}

// 后缀优先级演示
const FONT_EXT_ORDER = ['ttf', 'otf', 'ttc', 'woff2', 'woff'];
const pickFont = (names) => names
    .map((name) => ({ name, ext: /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() }))
    .filter((item) => item.ext && FONT_EXT_ORDER.includes(item.ext))
    .sort((left, right) => FONT_EXT_ORDER.indexOf(left.ext) - FONT_EXT_ORDER.indexOf(right.ext))[0]?.name ?? null;

console.log('\n=== 后缀优先级测试 ===');
for (const sample of [
    ['Font.woff2', 'Font.otf', 'Font.ttf'],
    ['readme.txt', 'Font.otf'],
    ['Font.woff'],
    ['license.docx', 'Font.ttc', 'Font.woff2'],
    ['readme.txt'],
]) {
    console.log(`  ${JSON.stringify(sample)} -> ${pickFont(sample)}`);
}
