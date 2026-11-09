/*
 * bizhihui 详情页：原图地址在哪、体积多大。
 *
 * 跑法：node tools/probe-bizhihui3.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const get = async (url) => {
    const response = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    return { status: response.status, text: await response.text(), finalUrl: response.url };
};

const detailUrl = 'https://www.bizhihui.com/p/24385.html';
const { status, text } = await get(detailUrl);
console.log(`详情页 HTTP ${status}, ${(text.length / 1024).toFixed(0)} KB`);

// 1. 图片地址（各种域名）
const imgs = [...new Set([...text.matchAll(/(?:src|data-src|data-original|href)="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi)].map((m) => m[1]))];
console.log(`\n图片地址 ${imgs.length} 个:`);
console.log(imgs.slice(0, 12).join('\n'));

// 2. 标题
const title = /<title>([\s\S]*?)<\/title>/.exec(text)?.[1]?.trim();
console.log(`\n标题: ${title}`);

// 3. 分辨率
const res = [...new Set([...text.matchAll(/(\d{3,5})\s*[x×]\s*(\d{3,5})/g)].map((m) => `${m[1]}x${m[2]}`))];
console.log('分辨率:', res.slice(0, 5));

// 4. 列表页结构：一页多少条
const listPage = await get('https://www.bizhihui.com/page/2/?order=views');
const links = [...new Set([...listPage.text.matchAll(/href="(https:\/\/www\.bizhihui\.com\/p\/\d+\.html)"/g)].map((m) => m[1]))];
console.log(`\n列表页(第2页) 详情链接 ${links.length} 个:`);
console.log(links.slice(0, 8).join('\n'));

// 5. 列表页里的缩略图
const thumbs = [...new Set([...listPage.text.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]).filter((s) => !s.startsWith('data:')))];
console.log(`\n列表缩略图 ${thumbs.length} 个:`);
console.log(thumbs.slice(0, 6).join('\n'));
