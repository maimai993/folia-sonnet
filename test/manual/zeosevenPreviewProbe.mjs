/*
 * 用**真实的** ZeoSeven CSS 跑一遍解析与精选，确认：
 *   1. 240 个分片都能被解析出来（url + unicode-range 配对正确）；
 *   2. 只显示「永风起时花落无声AaBb」时，实际只登记了个位数或十几个分片；
 *   3. 分片地址是绝对地址。
 *
 * 跑法：node test/manual/zeosevenPreviewProbe.mjs
 */
const ORIGIN = 'https://fontsapi.zeoseven.com';
const FONT_ID = '292';

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

const parseSlices = (css, origin) => {
    const slices = [];
    const facePattern = /@font-face\s*\{([^}]*)\}/g;
    let match = facePattern.exec(css);
    while (match) {
        const body = match[1];
        const url = /url\(\s*['"]?([^)'"]+)['"]?\s*\)/.exec(body)?.[1];
        const range = /unicode-range\s*:\s*([^;}]+)/i.exec(body)?.[1];
        if (url && range) {
            const absolute = /^https?:\/\//i.test(url) ? url : `${origin}/${url.replace(/^\.?\//, '')}`;
            slices.push({ url: absolute, ranges: parseRanges(range) });
        }
        match = facePattern.exec(css);
    }
    return slices;
};

const css = await fetch(`${ORIGIN}/${FONT_ID}/main/result.css`, {
    headers: { Accept: 'text/css,*/*;q=0.1' },
}).then((r) => r.text());

const slices = parseSlices(css, ORIGIN);
console.log(`分片解析: ${slices.length} 个（CSS 里 @font-face 有 ${(css.match(/@font-face/g) ?? []).length} 个）`);

const emptyRanges = slices.filter((s) => s.ranges.length === 0).length;
console.log(`unicode-range 解析失败的: ${emptyRanges}`);
const notAbsolute = slices.filter((s) => !s.url.startsWith('https://')).length;
console.log(`分片地址不是绝对地址的: ${notAbsolute}`);
console.log('样例分片:', slices.slice(0, 2).map((s) => s.url + '  ranges=' + s.ranges.length));

const sample = '永风起时花落无声AaBb';
const codePoints = [...sample].map((c) => c.codePointAt(0));
const picked = slices.filter((s) => codePoints.some((cp) => s.ranges.some(({ start, end }) => cp >= start && cp <= end)));

console.log(`\n预览样本 "${sample}"（${codePoints.length} 个码点）`);
console.log(`命中分片: ${picked.length} / ${slices.length}`);
for (const slice of picked) {
    const file = slice.url.split('/').pop();
    console.log('  ' + file);
}

const missing = [...sample].filter((ch) => {
    const cp = ch.codePointAt(0);
    return !slices.some((s) => s.ranges.some(({ start, end }) => cp >= start && cp <= end));
});
console.log(missing.length ? `\n⚠ 没有分片覆盖的字: ${missing.join('')}` : '\n样本里每个字都有分片覆盖');

// 对比：如果把整份 CSS 都塞进去（不精选），登记多少个。
console.log(`\n不精选时登记的分片数: ${slices.length}；精选后: ${picked.length}`);
