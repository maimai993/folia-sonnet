import { describe, expect, it } from 'vitest';
import { buildFontsCnPreviewUrl, parseFontsCnList } from '@/services/fontMarket/fontsNetCn';

// 当前文件：字体天下（fonts.net.cn）的列表解析与预览地址。
//
// 站点没有 JSON 接口，解析质量就是整个功能的全部。正则错一处，列表就空了，
// 而界面上只会显示「没有结果」—— 看不出是解析坏了。
//
// 下面的 HTML 片段取自线上真实结构（见 docs/fonts-net-cn-api.md）。

describe('parseFontsCnList', () => {
    const card = (id: string, name: string, cover: string, fontFile: string) => `
      <li>
        <div class="site_font_list_item_head">
          <a href="/font-${id}.html" class="site_font_name" target="_blank" title="${name}">${name}</a>
          <div class="site_font_meta"><a href="/fonts-zh-1.html" title="中文字体">中文字体</a></div>
        </div>
        <div class="site_font_list_item_body">
          <a href="/font-${id}.html" class="site_font_cover" target="_blank" title="${name}">
            <img src="//img.cdn.fonts.net.cn/${cover}" data-app-image="font-preview"
                 data-font-file="${fontFile}" data-font-size="" data-charset=""
                 alt="${name}的封面图" />
          </a>
          <div class="site_font_download">
            <button type="button" data-app-button="font-bookmark" data-font-id="${id}">收藏</button>
          </div>
        </div>
      </li>`;

    const html = card('37476120124', '字魂白鸽天行体', 'cover-37476-57102-220907103938.jpg', '37476-816e367d6930cf6ea0fbe2ad06b0f123.ttf')
        + card('41569702150', '三极花朝体 粗', 'cover-41569-62714-221110183817.jpg', '41569-0eb5046846c738e9eb6f95120c2ab057.ttf');

    it('解析出条目，名字取 title 而不是 alt', () => {
        const page = parseFontsCnList(html, 1);
        expect(page.items).toHaveLength(2);
        expect(page.items[0].name).toBe('字魂白鸽天行体');
        // alt 是「xxx的封面图」，不能拿来当名字。
        expect(page.items[0].name).not.toContain('封面图');
    });

    it('封面图补全 https:', () => {
        const page = parseFontsCnList(html, 1);
        expect(page.items[0].coverUrl).toBe('https://img.cdn.fonts.net.cn/cover-37476-57102-220907103938.jpg');
    });

    it('列表页就能拿到 fontFile，不用再进详情页', () => {
        const page = parseFontsCnList(html, 1);
        expect(page.items[0].fontFile).toBe('37476-816e367d6930cf6ea0fbe2ad06b0f123.ttf');
        expect(page.items[1].fontFile).toBe('41569-0eb5046846c738e9eb6f95120c2ab057.ttf');
    });

    it('数字 ID 解析正确', () => {
        const page = parseFontsCnList(html, 1);
        expect(page.items[0].id).toBe('37476120124');
        expect(page.items[0].detailPath).toBe('/font-37476120124.html');
    });

    it('同一款字体在卡片里出现多次也只收一条', () => {
        // 一个卡片里有名字链接、封面链接两个 href，按 <a> 切会重复。
        const page = parseFontsCnList(card('37476120124', '测试体', 'c.jpg', 'f.ttf'), 1);
        expect(page.items).toHaveLength(1);
    });

    it('没有 fontFile 时仍能出条目（只是不能自定义预览）', () => {
        const noFontFile = card('123', '某字体', 'c.jpg', 'f.ttf')
            .replace('data-font-file="f.ttf"', '');
        const page = parseFontsCnList(noFontFile, 1);
        expect(page.items).toHaveLength(1);
        expect(page.items[0].fontFile).toBeUndefined();
        expect(page.items[0].name).toBe('某字体');
    });

    it('名字缺失时用 id 兜底，不留空标题', () => {
        const broken = card('999', '占位', 'c.jpg', 'f.ttf')
            .replace(/title="占位"/g, '')
            .replace('>占位</a>', '></a>');
        const page = parseFontsCnList(broken, 1);
        expect(page.items[0].name).toBe('字体 999');
    });

    it('空页面不抛错', () => {
        const page = parseFontsCnList('<html><body>没有内容</body></html>', 2);
        expect(page.items).toHaveLength(0);
        expect(page.hasMore).toBe(false);
        expect(page.page).toBe(2);
    });
});

describe('buildFontsCnPreviewUrl', () => {
    it('参数名是 font（不是 fontId / file），值为完整的 fontFile', () => {
        const url = buildFontsCnPreviewUrl('37476-816e367d6930cf6ea0fbe2ad06b0f123.ttf', '你好');
        // 传错参数名时服务端仍返回 200，只是给一张空白图 —— 所以这里必须锁死。
        expect(url).toContain('font=37476-816e367d6930cf6ea0fbe2ad06b0f123.ttf');
        expect(url).not.toContain('fontId=');
        expect(url).toContain('text=%E4%BD%A0%E5%A5%BD');
    });

    it('文字里的特殊字符会被转义，不会拼坏 URL', () => {
        const url = buildFontsCnPreviewUrl('a.ttf', 'a&b=c 你好');
        expect(url).not.toContain('a&b=c');
        expect(url).toContain('a%26b%3Dc');
    });
});
