/*
 * 端到端确认：预览挑出来的那几个分片**真的能下载**，且返回的是合法 woff2。
 *
 * 前面只验证了「解析出 7 个分片」，但解析对不代表地址对。这里真的把那几个分片拉下来，
 * 检查 magic number（woff2 = "wOF2"）与大小。
 *
 * 跑法：node test/manual/zeosevenSliceFetchProbe.mjs
 */
const ORIGIN = 'https://fontsapi.zeoseven.com';
const FONT_ID = '292';
const SAMPLE = '永风起时花落无声AaBb';

const parseRanges = (raw) => {
    const ranges = [];
    for (const piece of raw.split(',')) {
        const token = piece.trim();
        if (!token.toUpperCase().startsWith('U+')) continue;
        const [from, to] = token.slice(2).split('-');
        const start = Number.parseInt(from, 16);
        if (!Number.isFinite(start)) continue;
        const end = to ? Number.parseInt(to, 16) : start;
        ranges.push({ start, end: Number.isFinite(end) ? end : start });
    }
    return ranges;
};

const css = await fetch(`${ORIGIN}/${FONT_ID}/main/result.css`).then((r) => r.text());
const slices = [];
const facePattern = /@font-face\s*\{([^}]*)\}/g;
let match = facePattern.exec(css);
while (match) {
    const body = match[1];
    const url = /url\(\s*['"]?([^)'"]+)['"]?\s*\)/.exec(body)?.[1];
    const range = /unicode-range\s*:\s*([^;}]+)/i.exec(body)?.[1];
    if (url && range) {
        // 分片在 /<id>/<style>/ 子目录下，不是站点根目录（照 zeoseven 自己的改写法）。
        slices.push({
            url: /^https?:\/\//i.test(url) ? url : `${ORIGIN}/${FONT_ID}/main/${url.replace(/^\.?\//, '')}`,
            ranges: parseRanges(range),
        });
    }
    match = facePattern.exec(css);
}

const codePoints = [...SAMPLE].map((c) => c.codePointAt(0));
const picked = slices.filter((s) => codePoints.some((cp) => s.ranges.some(({ start, end }) => cp >= start && cp <= end)));

console.log(`预览样本命中 ${picked.length} 个分片，逐个下载验证...\n`);

let totalBytes = 0;
let okCount = 0;
for (const slice of picked) {
    try {
        const response = await fetch(slice.url);
        if (!response.ok) {
            console.log(`  ✗ ${slice.url.split('/').pop()} -> HTTP ${response.status}`);
            continue;
        }
        const buffer = new Uint8Array(await response.arrayBuffer());
        const magic = String.fromCharCode(...buffer.slice(0, 4));
        const valid = magic === 'wOF2';
        totalBytes += buffer.byteLength;
        if (valid) okCount += 1;
        console.log(`  ${valid ? '✓' : '✗'} ${slice.url.split('/').pop()}  ${(buffer.byteLength / 1024).toFixed(1)} KB  magic=${magic}`);
    } catch (error) {
        console.log(`  ✗ ${slice.url.split('/').pop()} -> ${error.message}`);
    }
}

console.log(`\n成功: ${okCount}/${picked.length}，合计 ${(totalBytes / 1024).toFixed(1)} KB`);
console.log('对比：整份字体 240 个分片，若全下是十几 MB 级别。');
