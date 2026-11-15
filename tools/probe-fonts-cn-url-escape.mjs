/*
 * 验证：接口返回的 url 里有 \u0026，Java 侧正则直接取会不会炸。
 *
 * 站点返回形如：
 *   "url":"\/\/fileres.fonts.net.cn\/font-45666-260430221059.zip?...\u0026auth_key=..."
 *
 * 注意两点：
 *   · \/ 是 JSON 转义的斜杠
 *   · \u0026 是 & 的 JSON 转义
 *
 * 如果 Java 只把 // 补成 https:，却没解 \\/ 和 \\u0026，请求就会 404 → DownloadFailed。
 *
 * 跑法：node tools/probe-fonts-cn-url-escape.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BASE = 'https://www.fonts.net.cn';

const detail = await fetch(`${BASE}/font-45666408022.html`, { headers: { 'User-Agent': UA } });
const cookie = (detail.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ');
await detail.text();

const api = await fetch(`${BASE}/api/font-download/url`, {
    method: 'POST',
    headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${BASE}/font-45666408022.html`,
        Cookie: cookie,
    },
    body: 'fontId=45666408022',
});
const raw = await api.text();
console.log('=== 服务端原始响应 ===');
console.log(raw.slice(0, 400));

// 模拟 Java 侧的正则提取（完全照抄当前实现）
const naive = /"url"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
console.log('\n=== 正则直接取到（Java 现状）===');
console.log(naive?.slice(0, 200));
console.log(`  含字面反斜杠: ${naive?.includes('\\')}`);
console.log(`  含字面 \\u0026: ${naive?.includes('\\u0026')}`);

// 只补 https: 就去请求（Java 现在的做法）
const naiveUrl = naive?.startsWith('//') ? `https:${naive}` : naive;
const naiveResult = await fetch(naiveUrl, { headers: { 'User-Agent': UA } }).catch((error) => ({ status: `ERR ${error.message}` }));
console.log(`\n  直接请求结果: HTTP ${naiveResult.status}`);

// 正确做法：按 JSON 解转义
const decoded = JSON.parse(raw).data.url;
const decodedUrl = decoded.startsWith('//') ? `https:${decoded}` : decoded;
console.log('\n=== 正确解转义后 ===');
console.log(`  ${decodedUrl.slice(0, 200)}`);
const goodResult = await fetch(decodedUrl, { headers: { 'User-Agent': UA, Referer: `${BASE}/` } });
console.log(`  请求结果: HTTP ${goodResult.status}  长度 ${(await goodResult.arrayBuffer()).byteLength}`);
