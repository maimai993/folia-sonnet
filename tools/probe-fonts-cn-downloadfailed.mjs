/*
 * DownloadFailed 是从哪来的？
 *
 * 我自己的代码里错误码前缀只有 ERR:<code>（FontDownloadDisabled 等）。
 * "DownloadFailed" 不像站点返回的码，更像是我的原生下载或解压环节透了原始异常上来。
 *
 * 这里做两件事：
 *   1. 在代码里定位 DownloadFailed 的产生处
 *   2. 对真实字体走一遍「会话 → 拿地址 → 下载 zip → 解压」，看哪一步会炸
 *
 * 跑法：node tools/probe-fonts-cn-downloadfailed.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BASE = 'https://www.fonts.net.cn';

const fullFlow = async (fontId) => {
    const steps = {};

    // 1. 详情页 + cookie
    const detail = await fetch(`${BASE}/font-${fontId}.html`, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    const cookie = (detail.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ');
    steps.cookie = cookie || '（无 cookie）';
    await detail.text();

    // 2. 请求下载地址
    const api = await fetch(`${BASE}/api/font-download/url`, {
        method: 'POST',
        headers: {
            'User-Agent': UA,
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: `${BASE}/font-${fontId}.html`,
            Cookie: cookie,
        },
        body: `fontId=${encodeURIComponent(fontId)}`,
    });
    const json = await api.json().catch(() => null);
    steps.api = json?.success ? '成功' : (json?.code ?? '解析失败');
    if (!json?.success) return steps;

    // 3. 下载 zip（协议相对地址要补 https:）
    let url = json.data.url;
    if (url.startsWith('//')) url = `https:${url}`;
    steps.url = url.slice(0, 70);

    const zip = await fetch(url, { headers: { 'User-Agent': UA, Referer: `${BASE}/` } });
    steps.zipStatus = zip.status;
    steps.zipType = zip.headers.get('content-type');
    const buffer = Buffer.from(await zip.arrayBuffer());
    steps.zipBytes = buffer.length;
    steps.zipMagic = buffer.subarray(0, 4).toString('hex');

    // 4. 用最小的 zip 解析列出条目（只读中央目录）
    const entries = [];
    let at = 0;
    while ((at = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at)) !== -1) {
        try {
            const nameLength = buffer.readUInt16LE(at + 28);
            const extraLength = buffer.readUInt16LE(at + 30);
            const commentLength = buffer.readUInt16LE(at + 32);
            const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
            const compressed = buffer.readUInt32LE(at + 20);
            entries.push({ name, compressed });
            at += 46 + nameLength + extraLength + commentLength;
        } catch {
            break;
        }
    }
    steps.entries = entries.map((entry) => `${entry.name}(${entry.compressed}B)`);
    return steps;
};

for (const fontId of ['33115320682', '45666408022']) {
    console.log(`\n=== ${fontId} ===`);
    const steps = await fullFlow(fontId);
    for (const [key, value] of Object.entries(steps)) {
        console.log(`  ${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
    }
}
