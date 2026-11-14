/*
 * 背景站有没有搜索？逐个找。
 *
 * 用户要求背景市场也能搜。三个源的结构完全不同，搜索入口也不一样：
 *   · Moewalls —— WordPress（bimber 主题），大概率是 ?s= 或 /?s=
 *   · 哲风壁纸 bizhihui —— Z-Blog，通常是 /search.php?q= 或 ?q=
 *   · 壁纸汇 haowallpaper —— 自己写的，需要看导航
 *
 * 每个都实测，并把返回结构跟列表页对比，确认能不能复用同一个解析器。
 *
 * 跑法：node tools/probe-bg-search.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const get = async (url) => {
    try {
        const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
        const text = await response.text();
        return { status: response.status, text, url: response.url };
    } catch (error) {
        return { status: 0, text: '', error: String(error) };
    }
};

const looks = (text) => ({
    长度: text.length,
    article数: (text.match(/<article/gi) ?? []).length,
    详情链接: (text.match(/\/[a-z]*[-_]?\d{3,}\.html/g) ?? []).length,
});

// ---- 1. Moewalls ----
console.log('=== Moewalls ===');
for (const path of ['/?s=cat', '/?s=nature', '/search/?q=cat']) {
    const r = await get(`https://moewalls.com${path}`);
    console.log(`  ${path.padEnd(18)} HTTP ${r.status}  ${JSON.stringify(looks(r.text))}`);
}
// 看首页有没有搜索框
const home = await get('https://moewalls.com/');
const searchForm = /<form[^>]*search[^>]*>[\s\S]{0,400}?<\/form>/i.exec(home.text)?.[0];
console.log(`  首页搜索表单: ${searchForm ? searchForm.replace(/\s+/g, ' ').slice(0, 260) : '（没找到）'}`);
const searchInput = /<input[^>]*name="([^"]+)"[^>]*(?:search|s)[^>]*>/i.exec(home.text);
console.log(`  搜索输入框 name: ${searchInput ? searchInput[1] : '（没找到）'}`);

// ---- 2. 哲风壁纸 bizhihui ----
console.log('\n=== 哲风壁纸 (bizhihui) ===');
for (const path of ['/search.php?q=风景', '/?q=风景', '/search/风景/', '/search.php?word=风景']) {
    const r = await get(`https://www.bizhihui.com${path}`);
    console.log(`  ${path.padEnd(24)} HTTP ${r.status}  ${JSON.stringify(looks(r.text))}`);
}
const bzHome = await get('https://www.bizhihui.com/');
const bzForm = /<form[^>]*>[\s\S]{0,400}?<\/form>/gi.exec(bzHome.text)?.[0];
console.log(`  首页表单: ${bzForm ? bzForm.replace(/\s+/g, ' ').slice(0, 300) : '（没找到）'}`);
const bzSearchLinks = [...new Set([...bzHome.text.matchAll(/href="([^"]*search[^"]*)"/g)].map((m) => m[1]))].slice(0, 5);
console.log(`  含 search 的链接: ${bzSearchLinks.join(' | ') || '（无）'}`);

// ---- 3. 壁纸汇 haowallpaper ----
console.log('\n=== 壁纸汇 (haowallpaper) ===');
for (const path of ['/search?q=风景', '/?s=风景', '/search/风景']) {
    const r = await get(`https://www.haowallpaper.com${path}`);
    console.log(`  ${path.padEnd(20)} HTTP ${r.status}  ${JSON.stringify(looks(r.text))}`);
}
const hwHome = await get('https://www.haowallpaper.com/');
const hwSearch = [...new Set([...hwHome.text.matchAll(/href="([^"]*search[^"]*)"/gi)].map((m) => m[1]))].slice(0, 5);
console.log(`  含 search 的链接: ${hwSearch.join(' | ') || '（无）'}`);
const hwInputs = [...hwHome.text.matchAll(/<input[^>]*>/gi)].map((m) => m[0]).filter((tag) => /search|keyword|q=/i.test(tag)).slice(0, 4);
console.log(`  搜索输入框: ${hwInputs.join(' ').slice(0, 300) || '（无）'}`);
