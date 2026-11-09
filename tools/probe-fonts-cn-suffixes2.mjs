/*
 * 扩大抽样，专找非 .ttf 的包。
 *
 * 用户明确说「后缀名不一定是这种，需要涵盖其他的后缀名」。
 * 前面 10 个都是 ttf，那是中文站常见的形态；英文包 / 特殊包可能是 otf / woff / woff2。
 *
 * 跑法：node tools/probe-fonts-cn-suffixes2.mjs
 */
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

const listZipEntries = (buffer) => {
    const entries = [];
    let offset = buffer.length - 22;
    while (offset >= 0 && buffer.readUInt32LE(offset) !== 0x06054b50) offset -= 1;
    if (offset < 0) return entries;
    const count = buffer.readUInt16LE(offset + 10);
    let dirOffset = buffer.readUInt32LE(offset + 16);
    for (let i = 0; i < count; i += 1) {
        if (buffer.readUInt32LE(dirOffset) !== 0x02014b50) break;
        const nameLen = buffer.readUInt16LE(dirOffset + 28);
        const extraLen = buffer.readUInt16LE(dirOffset + 30);
        const commentLen = buffer.readUInt16LE(dirOffset + 32);
        const size = buffer.readUInt32LE(dirOffset + 24);
        entries.push({ name: buffer.slice(dirOffset + 46, dirOffset + 46 + nameLen).toString('utf8'), size });
        dirOffset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
};

// 英文站与更多分类
const lists = [
    `${BASE}/fonts-en-1.html`,
    `${BASE}/fonts-en-2.html`,
    `${BASE}/fonts-pic-1.html`,
    `${BASE}/fonts-zh/tag-lishu-1.html`,
    `${BASE}/fonts-zh/tag-youyuan-1.html`,
    `${BASE}/fonts-zh/tag-xingshu-1.html`,
    `${BASE}/fonts-zh-3.html`,
    `${BASE}/fonts-zh-4.html`,
];

const ids = [];
for (const url of lists) {
    const list = await getHtml(url);
    for (const match of list.text.matchAll(/\/font-(\d+)\.html/g)) {
        if (!ids.includes(match[1])) ids.push(match[1]);
    }
}
console.log(`候选 ${ids.length} 个，抽样 22 个`);

const allExt = new Map();
const nonTtf = [];

for (const id of ids.slice(0, 22)) {
    const referer = `${BASE}/font-${id}.html`;
    const detail = await getHtml(referer);
    const name = /<title>([\s\S]*?)<\/title>/.exec(detail.text)?.[1]?.split('字体')[0]?.trim() ?? '?';
    const dl = await postForm('/api/font-download/url', { fontId: id }, referer, detail.cookie);
    if (!dl.success || !dl.data?.url) continue;

    const url = dl.data.url.startsWith('//') ? `https:${dl.data.url}` : dl.data.url;

    // 中央目录里有全包偏移，Range 取尾部会让偏移失效，所以整包取。包大就跳过。
    const head = await fetch(url, { headers: { 'User-Agent': UA, Referer: referer } });
    const contentLength = Number(head.headers.get('content-length') ?? 0);
    if (contentLength > 20 * 1024 * 1024) {
        console.log(`${id.padEnd(14)} ${name.padEnd(24)} 包太大（${(contentLength / 1024 / 1024).toFixed(1)} MB），跳过`);
        continue;
    }
    const buffer = Buffer.from(await head.arrayBuffer());
    const entries = listZipEntries(buffer);

    const exts = entries.map((e) => /\.([a-z0-9]+)$/i.exec(e.name)?.[1]?.toLowerCase()).filter(Boolean);
    for (const ext of exts) allExt.set(ext, (allExt.get(ext) ?? 0) + 1);

    const summary = entries.filter((e) => e.name.includes('.')).map((e) => `${e.name.split('/').pop()} (${(e.size / 1024).toFixed(0)}KB)`);
    console.log(`${id.padEnd(14)} ${name.padEnd(24)} ${summary.join(' | ')}`);

    if (exts.some((ext) => ext !== 'ttf')) nonTtf.push({ id, name, entries });
}

console.log('\n=== 后缀统计 ===');
console.log([...allExt.entries()].sort((a, b) => b[1] - a[1]).map(([ext, count]) => `${ext}: ${count}`).join('  '));

if (nonTtf.length > 0) {
    console.log(`\n=== 非 ttf 的包 ${nonTtf.length} 个 ===`);
    nonTtf.forEach((pack) => console.log(`  ${pack.name}: ${pack.entries.filter((e) => e.name.includes('.')).map((e) => e.name.split('/').pop()).join(', ')}`));
}
