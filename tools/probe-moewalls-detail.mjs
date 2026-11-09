/*
 * moewalls 有没有内嵌的 JSON 数据？有的话比正则切 HTML 稳得多。
 * 同时把详情页的解析规则钉死（视频地址在哪）。
 *
 * 跑法：node tools/probe-moewalls-detail.mjs
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

// 1. 内嵌 JSON？
const ldJson = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
console.log(`ld+json 块: ${ldJson.length}`);
ldJson.forEach((block, index) => {
    console.log(`  [${index}] ${block.slice(0, 200).replace(/\s+/g, ' ')}`);
});

// 2. 详情页
const detailUrl = 'https://moewalls.com/anime/dark-goth-girl-live-wallpaper/';
const { status, text: detail } = await get(detailUrl);
console.log(`\n详情页 ${detailUrl} -> HTTP ${status}, ${(detail.length / 1024).toFixed(0)} KB`);

// 视频地址：mp4 / webm
const videos = [...new Set([...detail.matchAll(/https?:\/\/[^\s"'<>]+\.(?:mp4|webm)/gi)].map((m) => m[0]))];
console.log('\n视频地址候选:');
console.log(videos.slice(0, 10).join('\n') || '  无');

// video 标签本体
const videoTags = [...detail.matchAll(/<video[^>]*>[\s\S]{0,400}?<\/video>/g)].map((m) => m[0]);
console.log(`\n<video> 标签: ${videoTags.length}`);
videoTags.slice(0, 2).forEach((tag) => console.log('  ' + tag.replace(/\s+/g, ' ').slice(0, 400)));

// 3. data-* 属性里带 mp4 的
const dataAttrs = [...new Set([...detail.matchAll(/data-[a-z-]+="([^"]*\.(?:mp4|webm)[^"]*)"/gi)].map((m) => m[1]))];
console.log('\ndata-* 里的视频:', dataAttrs.slice(0, 5).join('\n') || '无');

// 4. 标题与分辨率
const title = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(detail)?.[1]?.replace(/<[^>]+>/g, '').trim();
console.log('\n标题:', title);
const resolutions = [...new Set([...detail.matchAll(/resolutions-(\d+x\d+)/g)].map((m) => m[1]))];
console.log('分辨率标记:', resolutions.slice(0, 6));
