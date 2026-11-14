/*
 * haowallpaper 列表页到底怎么标记「这是视频条目」？
 *
 * 之前看到 <video> 标签里是 video_reduce_file，但那是详情页。列表页要重新确认，
 * 否则视频条目会被当成图片 —— 用户点进去发现是静态图。
 *
 * 跑法：node tools/probe-hw-videoflag.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const response = await fetch('https://haowallpaper.com/homeView?page=1', { headers: { 'User-Agent': UA } });
const html = await response.text();

console.log(`HTTP ${response.status}, ${(html.length / 1024).toFixed(0)} KB`);

for (const keyword of ['pre_cache_file', 'video_reduce_file', '<video', 'isVideo', 'video', 'dynamic', '动图', '动态']) {
    const count = (html.match(new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
    console.log(`  ${keyword.padEnd(20)} ${count} 次`);
}

// 找 <video> 出现的上下文
const videoTags = [...html.matchAll(/<video[^>]*>/g)].map((m) => m[0]);
console.log(`\n<video> 标签 ${videoTags.length} 个:`);
videoTags.slice(0, 4).forEach((tag) => console.log('  ' + tag.slice(0, 200)));

// 找 mp4 出现的位置
const mp4s = [...new Set([...html.matchAll(/[^"'\s]*\.mp4/g)].map((m) => m[0]))];
console.log(`\nmp4 地址 ${mp4s.length} 个:`);
mp4s.slice(0, 5).forEach((mp4) => console.log('  ' + mp4));

// 条目附近的标记：取第一个 ItemList 条目，看它周围有没有视频线索
const firstItem = /"@type":"ListItem","position":1[\s\S]{0,400}/.exec(html)?.[0];
console.log(`\n第一个 ItemList 条目附近:\n  ${firstItem?.replace(/\s+/g, ' ')}`);
