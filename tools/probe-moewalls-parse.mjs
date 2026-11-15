/*
 * 解析 moewalls 列表页（WordPress + bimber 主题）。
 *
 * 以前 403，现在 200 了，所以可以真实验证解析规则 —— 这比照抄 Mineradio 的正则靠谱。
 *
 * 跑法：node tools/probe-moewalls-parse.mjs
 */
const UA = 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const get = async (url) => {
    const response = await fetch(url, {
        headers: {
            'User-Agent': UA,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        },
    });
    return { status: response.status, text: await response.text() };
};

const { text: html } = await get('https://moewalls.com/');

// 1. article 块：每条壁纸一个
const articles = [...html.matchAll(/<article[^>]*>[\s\S]*?<\/article>/g)].map((m) => m[0]);
console.log(`article 块: ${articles.length} 个`);

if (articles[0]) {
    console.log('\n=== 第一个 article 的骨架 ===');
    // 只留标签与属性，去掉文字，方便看清结构
    const skeleton = articles[0].replace(/>[^<]{2,}</g, '><').slice(0, 1200);
    console.log(skeleton);
}

// 2. 详情页链接
const links = [...new Set([...html.matchAll(/href="(https:\/\/moewalls\.com\/[^"]*?\/)"/g)]
    .map((m) => m[1])
    .filter((link) => !/\/(category|tag|page|author|feed|about|privacy|dmca|contact|terms)\//.test(link)))];
console.log(`\n候选详情页链接: ${links.length}`);
console.log(links.slice(0, 8).join('\n'));

// 3. 缩略图
const thumbs = [...new Set([...html.matchAll(/(?:src|data-src)="(https:\/\/moewalls\.com\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"/g)].map((m) => m[1]))];
console.log(`\n缩略图: ${thumbs.length} 张`);
console.log(thumbs.slice(0, 5).join('\n'));
