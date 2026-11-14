/*
 * bizhihui 的列表页在哪？首页几乎没内容（JS 渲染），试着找列表路由与接口。
 *
 * 跑法：node tools/probe-bizhihui2.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const get = async (url) => {
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' },
            redirect: 'follow',
        });
        return { status: response.status, text: await response.text(), finalUrl: response.url };
    } catch (error) {
        return { status: 0, text: '', error: error.message };
    }
};

const home = await get('https://bizhihui.com/');
console.log(`首页: HTTP ${home.status} -> ${home.finalUrl}, ${(home.text.length / 1024).toFixed(0)} KB`);

// 页脚/导航里的真实链接（绝对地址也算）
const allLinks = [...new Set([...home.text.matchAll(/href="([^"#]+)"/g)].map((m) => m[1]))];
console.log(`\n所有链接 ${allLinks.length} 个:`);
console.log(allLinks.slice(0, 30).join('\n'));

// 试探常见列表路由
console.log('\n=== 试探列表路由 ===');
for (const path of ['/wallpaper', '/list', '/bizhi', '/4k', '/pc', '/rank', '/new', '/category']) {
    const result = await get(`https://bizhihui.com${path}`);
    const imgCount = [...result.text.matchAll(/\.(?:jpg|jpeg|png|webp)/g)].length;
    console.log(`  ${path.padEnd(12)} HTTP ${result.status}  ${(result.text.length / 1024).toFixed(0).padStart(4)}KB  图${imgCount}`);
}
