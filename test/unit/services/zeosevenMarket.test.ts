// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    fetchFontMarket,
    installMarketFont,
    listFontMarketCategories,
    readFontMarketChoice,
    restoreMarketFontChoice,
    writeFontMarketChoice,
    type FontMarketFont,
} from '@/services/fontMarket';

// 当前文件：字体市场目录（ZeoSeven / ZSFT 来源）的分页、筛选与选择持久化。
//
// 与以前最不一样的一点：目录在构建时就烘进了包里（见 fontMarket/zeosevenCatalog.json），
// 所以分页与筛选是**本地**完成的，没有网络往返，也不会有「服务端 500」这种错误态。
// 字体本体是切片 WebFont，不再整包下载 —— 安装只登记全部分片，不落 IndexedDB。

const marketFont = (overrides: Partial<FontMarketFont> = {}): FontMarketFont => ({
    id: '292',
    name: '霞鹜文楷',
    family: 'zsft-full-292-main',
    category: 'kai',
    categoryLabel: '楷书',
    license: 'OFL-1.1',
    designer: 'LXGW',
    alias: 'LXGW WenKai',
    languages: ['cn', 'tw', 'jp'],
    weights: 3,
    fileName: '',
    mimeType: 'font/woff2',
    fileSize: 0,
    fileUrl: '',
    previewUrl: '',
    previewAspect: 0,
    enabled: true,
    sort: 0,
    createdAt: '',
    updatedAt: '',
    ...overrides,
});

const stubFonts = () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
        '@font-face{font-family:"X";src:url("./a.woff2")format("woff2");unicode-range:U+4E00;}',
        { status: 200 },
    )));
    Object.defineProperty(document, 'fonts', {
        configurable: true,
        value: { load: vi.fn(async () => []), add: vi.fn() },
    });
};

describe('fetchFontMarket', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('目录不依赖网络：不发请求也能翻页', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        const result = await fetchFontMarket({ page: 1, pageSize: 10 });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(result.error).toBeNull();
        expect(result.fonts).toHaveLength(10);
        expect(result.total).toBeGreaterThan(1000);
        expect(result.hasMore).toBe(true);
    });

    it('按风格筛选（多风格字体只要含该风格就算命中）', async () => {
        const result = await fetchFontMarket({ page: 1, pageSize: 50, category: '楷' });
        expect(result.fonts.length).toBeGreaterThan(0);
        // 一款字体可能有多个风格，`category` 只是第一个，所以这里查的是完整 styles。
        const ids = new Set(result.fonts.map((font) => font.id));
        const { ZEOSEVEN_FONTS } = await import('@/services/fontMarket/zeosevenCatalog');
        const expected = ZEOSEVEN_FONTS.filter((font) => font.styles.includes('楷')).map((font) => font.id);
        expect([...ids].every((id) => expected.includes(id))).toBe(true);
    });

    it("'all' 或空表示不过滤", async () => {
        const all = await fetchFontMarket({ page: 1, pageSize: 5, category: 'all' });
        const none = await fetchFontMarket({ page: 1, pageSize: 5 });
        expect(all.total).toBe(none.total);
    });

    it('按名称搜索', async () => {
        const result = await fetchFontMarket({ page: 1, pageSize: 20, q: '霞鹜' });
        expect(result.fonts.length).toBeGreaterThan(0);
        expect(result.fonts.some((font) => font.name.includes('霞鹜') || font.alias.includes('霞鹜'))).toBe(true);
    });

    it('翻到最后一页时 hasMore 为 false', async () => {
        const first = await fetchFontMarket({ page: 1, pageSize: 5 });
        const lastPage = Math.ceil(first.total / 5);
        const last = await fetchFontMarket({ page: lastPage, pageSize: 5 });
        expect(last.hasMore).toBe(false);
    });

    it('越界页码返回空列表而不是报错', async () => {
        const result = await fetchFontMarket({ page: 99999, pageSize: 20 });
        expect(result.fonts).toHaveLength(0);
        expect(result.error).toBeNull();
    });

    it('每款字体都带上 ZeoSeven 的元信息', async () => {
        const result = await fetchFontMarket({ page: 1, pageSize: 3 });
        for (const font of result.fonts) {
            expect(font.id).toBeTruthy();
            expect(font.name).toBeTruthy();
            // 切片字体：没有单一文件地址，family 指向运行时注册的名字。
            expect(font.family).toContain('zsft-full-');
            expect(font.mimeType).toBe('font/woff2');
        }
    });
});

describe('listFontMarketCategories', () => {
    it('返回风格与各自的字体数量，按数量降序', async () => {
        const categories = await listFontMarketCategories();
        expect(categories.length).toBeGreaterThan(3);
        const counts = categories.map((entry) => entry.count);
        expect([...counts].sort((a, b) => b - a)).toEqual(counts);
        expect(categories.every((entry) => entry.label && entry.value)).toBe(true);
    });

    /*
     * 防回归：字体商店的页签 id 必须真的能取到字体。
     *
     * 以前页签写的是 `handwriting` / `display`，而 ZeoSeven 的标记是 `script` / `dis`，
     * 点进去是空列表 —— 用户只看到「没有匹配项」，看不出是标记对不上。
     */
    it('每个页签都至少能取到一款字体', async () => {
        const tabs = ['all', 'sans', 'serif', '楷', 'dis', 'round', 'mono'];
        for (const tab of tabs) {
            const result = await fetchFontMarket({ page: 1, pageSize: 1, category: tab });
            expect(result.total, `页签 ${tab} 取不到任何字体`).toBeGreaterThan(0);
        }
    });
});

describe('installMarketFont', () => {
    beforeEach(() => {
        localStorage.clear();
        document.head.innerHTML = '';
        stubFonts();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        localStorage.clear();
    });

    it('登记全部分片并把选择记下来', async () => {
        const result = await installMarketFont(marketFont());
        expect(result.family).toBe('zsft-full-292-main');
        expect(result.label).toBe('霞鹜文楷');
        // 切片字体没有整包字节。
        expect(result.base64).toBe('');

        expect(document.querySelectorAll('style[data-folia-font="zsft-full-292-main"]')).toHaveLength(1);
        expect(readFontMarketChoice()?.id).toBe('292');
    });

    it('字体取不到时抛错，不留下半个选择', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
        await expect(installMarketFont(marketFont({ id: 'no-such' }))).rejects.toThrow();
        expect(readFontMarketChoice()).toBeNull();
    });
});

describe('选择持久化', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('写入后能读回来', () => {
        writeFontMarketChoice({ id: '292', family: 'f', label: '霞鹜文楷', previewUrl: '' });
        expect(readFontMarketChoice()).toEqual({ id: '292', family: 'f', label: '霞鹜文楷', previewUrl: '' });
    });

    it('清空后读回 null', () => {
        writeFontMarketChoice({ id: '292', family: 'f', label: 'x', previewUrl: '' });
        writeFontMarketChoice(null);
        expect(readFontMarketChoice()).toBeNull();
    });

    it('坏数据不会抛错', () => {
        localStorage.setItem('foliaFontMarketChoice', '{oops');
        expect(readFontMarketChoice()).toBeNull();
    });

    it('冷启动时把上次选的字体重新登记回来', async () => {
        document.head.innerHTML = '';
        stubFonts();
        writeFontMarketChoice({ id: '292', family: 'zsft-full-292-main', label: '霞鹜文楷', previewUrl: '' });

        const family = await restoreMarketFontChoice();
        expect(family).toBe('zsft-full-292-main');
        vi.unstubAllGlobals();
    });

    it('选中的字体已从目录下架时返回 null', async () => {
        writeFontMarketChoice({ id: 'definitely-not-in-catalog', family: 'x', label: 'x', previewUrl: '' });
        expect(await restoreMarketFontChoice()).toBeNull();
    });
});
