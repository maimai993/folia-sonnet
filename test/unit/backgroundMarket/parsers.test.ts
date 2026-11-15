import { describe, expect, it } from 'vitest';
import { parseMoewallsList } from '@/services/backgroundMarket/moewalls';
import { parseHaowallpaperList, haowallpaperVideoUrl } from '@/services/backgroundMarket/haowallpaper';
import { bizhihuiFullImage, parseBizhihuiList } from '@/services/backgroundMarket/bizhihui';

// 当前文件：三个背景市场源的解析器。
//
// 用的都是**真实抓下来的 HTML 片段**（结构取自线上页面，只留本测试关心的部分）。
// 这些站点没有 API，解析质量就是这个功能的全部 —— 正则错一个字符，整个源就空了，
// 而界面上只会显示「没有结果」，看不出是解析坏了。

describe('parseMoewallsList', () => {
    const html = `
        <article class="entry-tpl-grid entry-tpl-grid-m g1-card post-21666 category-anime resolutions-3840x2160">
          <div class="entry-featured-media">
            <a title="Dark Goth Girl Live Wallpaper" class="g1-frame" href="https://moewalls.com/anime/dark-goth-girl-live-wallpaper/">
              <div class="g1-frame-inner">
                <img width="364" height="205" src="https://moewalls.com/wp-content/uploads/2026/11/dark-goth-girl-thumb-364x205.jpg"
                     srcset="https://moewalls.com/wp-content/uploads/2026/11/dark-goth-girl-thumb-364x205.jpg 364w, https://moewalls.com/wp-content/uploads/2026/11/dark-goth-girl-thumb-728x410.jpg 728w, https://moewalls.com/wp-content/uploads/2026/11/dark-goth-girl-thumb.jpg 1920w" />
              </div>
            </a>
          </div>
        </article>`;

    it('解析出条目、4K 分辨率与最大缩略图', () => {
        const page = parseMoewallsList(html, 1);
        expect(page.items).toHaveLength(1);
        const item = page.items[0];
        expect(item.kind).toBe('video');
        expect(item.source).toBe('moewalls');
        expect(item.name).toBe('Dark Goth Girl Live Wallpaper');
        expect(item.width).toBe(3840);
        expect(item.height).toBe(2160);
        // 取 srcset 里最大的那档，不是 364 的小图。
        expect(item.thumbnailUrl).toContain('dark-goth-girl-thumb.jpg');
        expect(item.thumbnailUrl).not.toContain('364x205');
        expect(item.detailUrl).toContain('/anime/dark-goth-girl-live-wallpaper/');
        // 高清地址要进详情页换，列表里拿不到。
        expect(item.mediaUrl).toBeUndefined();
    });

    it('详情页链接里没有 title 属性时也能取到名字', () => {
        const noTitle = html.replace(' title="Dark Goth Girl Live Wallpaper"', '');
        const page = parseMoewallsList(noTitle, 1);
        expect(page.items[0].name.toLowerCase()).toContain('dark');
    });

    it('条目不足一页时认为没有下一页', () => {
        expect(parseMoewallsList(html, 1).hasMore).toBe(false);
    });

    it('空页面不抛错', () => {
        const page = parseMoewallsList('<html><body>无内容</body></html>', 1);
        expect(page.items).toHaveLength(0);
        expect(page.hasMore).toBe(false);
    });
});

describe('parseHaowallpaperList', () => {
    // 结构取自真实页面：内嵌的 schema.org ItemList + 视频路径标记。
    const html = `
      <script type="application/ld+json">{"@type":"CollectionPage","mainEntity":{"@type":"ItemList","numberOfItems":2,
      "itemListElement":[
        {"@type":"ListItem","position":1,"url":"https://haowallpaper.com/homeViewLook/17815999759895936","name":"4k特写壁纸-蓝眼 - 银发「哲风壁纸」","image":"https://img.haowallpaper.com/cache_file/2025_10_20_file/17815907003452800.png"},
        {"@type":"ListItem","position":2,"url":"https://haowallpaper.com/homeViewLook/19886923996812160","name":"7kHH壁纸-伦敦 - 大本钟「哲风壁纸」","image":"https://img.haowallpaper.com/cache_file/2026_10_21_file/19886917858972544.png"}
      ]}}</script>
      <img src="https://img.haowallpaper.com/video_reduce_file/2025_10_20_file/17815907003452800.mp4">
    `;

    it('从 schema.org ItemList 里取条目，并去掉站名后缀', () => {
        const page = parseHaowallpaperList(html, 1);
        expect(page.items).toHaveLength(2);
        expect(page.items[0].name).toBe('4k特写壁纸-蓝眼 - 银发');
        expect(page.items[0].thumbnailUrl).toContain('cache_file');
    });

    it('靠 fileId 命中视频路径判断类型', () => {
        const page = parseHaowallpaperList(html, 1);
        // 17815907003452800 在 video_reduce_file 里出现过 → 视频
        expect(page.items[0].kind).toBe('video');
        // 19886917858972544 没出现过 → 图片
        expect(page.items[1].kind).toBe('image');
        expect(page.items[1].mediaUrl).toContain('cache_file');
    });

    it('视频地址指向 pre_cache_file 且 fileId 与日期目录不变', () => {
        const url = haowallpaperVideoUrl('https://img.haowallpaper.com/cache_file/2025_10_20_file/17815907003452800.png');
        expect(url).toBe('https://img.haowallpaper.com/pre_cache_file/2025_10_20_file/17815907003452800.mp4');
    });

    it('地址形态不认识时返回 null 而不是拼一个错地址', () => {
        expect(haowallpaperVideoUrl('https://example.com/abc.png')).toBeNull();
    });
});

describe('parseBizhihuiList', () => {
    const html = `
      <div class="item">
        <a href="https://www.bizhihui.com/p/24385.html">
          <img src="https://s.panlai.com/zb_users/upload/2026/10/bizhihui_com_202610291793244133809052.jpg-pcthumbs"
               alt="静物 树叶 书籍 圣杯 水果 棕色 4K壁纸" />
        </a>
      </div>`;

    it('解析出图片条目与详情链接', () => {
        const page = parseBizhihuiList(html, 1);
        expect(page.items).toHaveLength(1);
        const item = page.items[0];
        expect(item.kind).toBe('image');
        expect(item.name).toContain('静物');
        expect(item.detailUrl).toContain('/p/24385.html');
    });

    it('去掉 -pcthumbs 后缀就是原图', () => {
        const page = parseBizhihuiList(html, 1);
        expect(page.items[0].mediaUrl).toBe(
            'https://s.panlai.com/zb_users/upload/2026/10/bizhihui_com_202610291793244133809052.jpg',
        );
        // 缩略图本身仍保留后缀（列表显示用它）。
        expect(page.items[0].thumbnailUrl).toContain('-pcthumbs');
    });

    it('没有该后缀时原样返回', () => {
        expect(bizhihuiFullImage('https://a.com/x.png')).toBe('https://a.com/x.png');
    });

    it('同一个条目重复出现只收一次', () => {
        const page = parseBizhihuiList(html + html, 1);
        expect(page.items).toHaveLength(1);
    });
});
