/*
 * 抓字体天下**真实**的分类导航，不要自己编。
 *
 * 用户说"他源站不是有很多分类吗？你就按那个分类来显示"。
 * 这里把站点的导航与标签全部抓下来。
 *
 * 跑法：node tools/probe-fonts-cn-categories.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const get = async (url) => (await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } })).text();

const home = await get('https://www.fonts.net.cn/');

// 1. 所有 /fonts-* 与 tag 路径
const paths = [...new Set([...home.matchAll(/href="(\/(?:fonts-[a-z]+|fonts-zh\/tag-[a-z]+)[^"]*)"/g)].map((m) => m[1]))];
console.log(`=== 首页导航里的字体分类路径 ${paths.length} 个 ===`);
paths.forEach((path) => console.log(`  ${path}`));

// 2. 分类链接上的文字
console.log('\n=== 分类名与路径对照 ===');
const labelled = [...home.matchAll(/<a[^>]+href="(\/(?:fonts-[a-z]+-\d+|fonts-zh\/tag-[a-z]+-\d+)\.html)"[^>]*>([^<]{1,20})<\/a>/g)];
const seen = new Set();
for (const [, path, label] of labelled) {
    const key = path.replace(/-\d+\.html$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  ${label.trim().padEnd(10)} ${path}`);
}

// 3. 逐个分类验证能不能拿到内容
console.log('\n=== 各分类实测 ===');
const bases = [...seen.keys()];
for (const base of bases) {
    const url = `https://www.fonts.net.cn${base}-1.html`;
    const html = await get(url);
    const blocks = (html.match(/<li>\s*<div class="site_font_list_item_head"[\s\S]*?<\/li>/g) ?? []).length;
    const names = [...html.matchAll(/class="site_font_name"[^>]*title="([^"]*)"/g)].map((m) => m[1]);
    console.log(`  ${base.padEnd(30)} ${String(blocks).padStart(3)} 条  ${names.slice(0, 2).join(' / ')}`);
}
