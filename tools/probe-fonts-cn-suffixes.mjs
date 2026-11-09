/*
 * 抽样多个字体包，统计里面出现的**全部**文件后缀。
 *
 * 目的：后缀匹配规则不能只认 ttf/otf，得知道真实世界里还有哪些。
 * 这里下载若干个包，把每个包里的文件名和大小都列出来。
 *
 * 跑法：node tools/probe-fonts-cn-suffixes.mjs
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

/** 只读 zip 中央目录，不下载整个包（用 Range 取尾部）。 */
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
        entries.push({
            name: buffer.slice(dirOffset + 46, dirOffset + 46 + nameLen).toString('utf8'),
            size,
        });
        dirOffset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
};

// 从多个分类各取几个，样本更具代表性
const lists = [
    `${BASE}/fonts-zh-1.html`,
    `${BASE}/fonts-zh-2.html`,
    `${BASE}/fonts-en-1.html`,
    `${BASE}/fonts-zh/tag-caoshu-1.html`,
    `${BASE}/fonts-zh/tag-heiti-1.html`,
];

const ids = [];
for (const url of lists) {
    const list = await getHtml(url);
    for (const match of list.text.matchAll(/\/font-(\d+)\.html/g)) {
        if (!ids.includes(match[1])) ids.push(match[1]);
    }
}
console.log(`候选字体 ${ids.length} 个，抽样前 10 个下载`);

const allExt = new Map();
const samples = [];

for (const id of ids.slice(0, 10)) {
    const referer = `${BASE}/font-${id}.html`;
    const detail = await getHtml(referer);
    const name = /<title>([\s\S]*?)<\/title>/.exec(detail.text)?.[1]?.split('字体')[0]?.trim() ?? '?';
    const dl = await postForm('/api/font-download/url', { fontId: id }, referer, detail.cookie);

    if (!dl.success || !dl.data?.url) {
        console.log(`\n${id} ${name} -> ${dl.code ?? '无地址'}（跳过）`);
        continue;
    }
    let url = dl.data.url.startsWith('//') ? `https:${dl.data.url}` : dl.data.url;

    // 先只取尾部，读中央目录；读不到再整包
    let buffer = null;
    const head = await fetch(url, { headers: { 'User-Agent': UA, Referer: referer } });
    buffer = Buffer.from(await head.arrayBuffer());

    const entries = listZipEntries(buffer);
    console.log(`\n${id} ${name}  (${(buffer.length / 1024).toFixed(0)} KB, ${entries.length} 项)`);
    for (const entry of entries) {
        console.log(`   ${(entry.size / 1024).toFixed(1).padStart(8)} KB  ${entry.name}`);
        const ext = /\.([a-z0-9]+)$/i.exec(entry.name)?.[1]?.toLowerCase();
        if (ext) allExt.set(ext, (allExt.get(ext) ?? 0) + 1);
    }
    samples.push({ id, name, entries });
}

console.log('\n=== 后缀统计 ===');
console.log([...allExt.entries()].sort((a, b) => b[1] - a[1]).map(([ext, count]) => `${ext}: ${count}`).join('  '));
