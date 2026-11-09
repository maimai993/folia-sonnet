/*
 * 摸清 bizhihui（图片源）的列表与详情结构。
 *
 * 跑法：node tools/probe-bizhihui.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const get = async (url) => {
    const response = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    return { status: response.status, text: await response.text(), url };
};

const { status, text } = await get('https://bizhihui.com/');
console.log(`首页 HTTP ${status}, ${(text.length / 1024).toFixed(0)} KB`);

// 1. 链接结构
const links = [...new Set([...text.matchAll(/href="(\/[^"]{3,80})"/g)].map((m) => m[1]))];
console.log(`\n站内链接 ${links.length} 个，前 25:`);
console.log(links.slice(0, 25).join('\n'));

// 2. 图片地址
const imgs = [...new Set([...text.matchAll(/(?:src|data-src|data-original)="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp))"/g)].map((m) => m[1]))];
console.log(`\n图片 ${imgs.length} 张，前 6:`);
console.log(imgs.slice(0, 6).join('\n'));

// 3. 有没有列表容器
for (const cls of ['wallpaper', 'list', 'item', 'pic', 'card']) {
    const count = (text.match(new RegExp(`class="[^"]*${cls}[^"]*"`, 'g')) ?? []).length;
    if (count > 0) console.log(`  class 含 ${cls}: ${count} 处`);
}
