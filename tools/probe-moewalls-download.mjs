/*
 * moewalls 的高清视频从哪来？
 *
 * 详情页 <video> 只是 preview/xxx.webm（小预览）。壁纸要的是完整版。
 * 这里把详情页里所有下载相关的线索挖出来。
 *
 * 跑法：node tools/probe-moewalls-download.mjs
 */
const UA = 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const detailUrl = 'https://moewalls.com/anime/dark-goth-girl-live-wallpaper/';
const response = await fetch(detailUrl, {
    headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
    },
});
const html = await response.text();
console.log(`HTTP ${response.status}, ${(html.length / 1024).toFixed(0)} KB\n`);

// 1. 所有 .webm / .mp4 出现的位置（含相对路径）
console.log('=== 所有视频地址（含相对）===');
const all = [...new Set([...html.matchAll(/["'(]((?:\/[^"'()\s]+?|https?:\/\/[^"'()\s]+?)\.(?:webm|mp4))["')]/gi)].map((m) => m[1]))];
console.log(all.slice(0, 20).join('\n') || '无');

// 2. 下载按钮
console.log('\n=== download 相关标签 ===');
const dl = [...html.matchAll(/<a[^>]*(?:class|id)="[^"]*download[^"]*"[^>]*>[\s\S]{0,200}?<\/a>/gi)].map((m) => m[0]);
console.log(dl.slice(0, 6).map((s) => s.replace(/\s+/g, ' ').slice(0, 300)).join('\n') || '无');

// 3. 关键 JS 变量：wp 主题常把视频地址塞进内联 script
console.log('\n=== 内联 script 里含 video/url 的片段 ===');
const inline = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
for (const script of inline) {
    if (/video|\.webm|\.mp4|download/i.test(script)) {
        const hits = [...new Set([...script.matchAll(/["']([^"']*(?:webm|mp4|download)[^"']*)["']/gi)].map((m) => m[1]))];
        if (hits.length > 0) console.log('  ' + hits.slice(0, 8).join('\n  '));
    }
}

// 4. og:video 之类的 meta
console.log('\n=== meta 里的视频 ===');
const meta = [...html.matchAll(/<meta[^>]*(?:og:video|twitter:player)[^>]*>/gi)].map((m) => m[0]);
console.log(meta.slice(0, 5).map((s) => s.replace(/\s+/g, ' ')).join('\n') || '无');
