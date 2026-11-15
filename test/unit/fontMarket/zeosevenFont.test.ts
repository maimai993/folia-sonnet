// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * ZeoSeven 的取用逻辑有两条硬约束，都必须钉住：
 *   1. 预览只注册**覆盖到预览文字**的分片 —— 不然一段中文会把几百个分片全登记进文档；
 *   2. 相对 url 要按 CSS 实际来源的域名改写成绝对地址 —— 主站挂了走镜像时，分片
 *      也得跟着换域名，否则路径对不上、字体静默不生效。
 */

const CSS = `/* header */
@font-face{font-family:"Test Font";src:local("Test Font"),url("./aaa.woff2")format("woff2");font-style:normal;font-display:swap;font-weight:400;unicode-range:U+4E00-4E01,U+4E03;}
@font-face{font-family:"Test Font";src:local("Test Font"),url("./bbb.woff2")format("woff2");font-style:normal;font-display:swap;font-weight:400;unicode-range:U+65E5-65E5;}
@font-face{font-family:"Test Font";src:local("Test Font"),url("./ccc.woff2")format("woff2");font-style:normal;font-display:swap;font-weight:400;unicode-range:U+0041-005A;}`;

const injected = () => [...document.querySelectorAll('style[data-folia-font]')];

describe('zeosevenFont', () => {
    beforeEach(() => {
        vi.resetModules();
        document.head.innerHTML = '';
        document.querySelectorAll('style[data-folia-font]').forEach((node) => node.remove());
    });

    it('预览只注册覆盖到预览文字的分片', async () => {
        const fetchMock = vi.fn(async () => new Response(CSS, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        // jsdom 没有 FontFace 加载：让 fonts.load 直接过。
        Object.defineProperty(document, 'fonts', {
            configurable: true,
            value: { load: vi.fn(async () => []), add: vi.fn() },
        });

        const { loadPreviewFamily } = await import('../../../src/services/fontMarket/zeosevenFont');
        // 预览文字「一」= U+4E00，只该命中 aaa.woff2 那个分片。
        const family = await loadPreviewFamily('292', 'main', '一', );

        expect(family).toBe('zsft-preview-292-main');
        const sheets = injected();
        expect(sheets).toHaveLength(1);
        const css = sheets[0].textContent ?? '';
        expect(css).toContain('aaa.woff2');
        expect(css).not.toContain('bbb.woff2');
        expect(css).not.toContain('ccc.woff2');
        // 相对路径必须补成绝对地址，且**带上 /<id>/<style>/ 子目录**。
        // 只去掉 "./" 会得到 /aaa.woff2 —— 那是 404（真实网络验证过）。
        expect(css).toContain('https://fontsapi.zeoseven.com/292/main/aaa.woff2');
        // 原版的 local(...) 不能留：留着就可能用系统字体顶替，预览失真。
        expect(css).not.toContain('local(');
    });

    it('预览命中多个分片时全都注册', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(CSS, { status: 200 })));
        Object.defineProperty(document, 'fonts', {
            configurable: true,
            value: { load: vi.fn(async () => []), add: vi.fn() },
        });

        const { loadPreviewFamily } = await import('../../../src/services/fontMarket/zeosevenFont');
        // 「一」U+4E00 与「日」U+65E5 分属两个分片。
        await loadPreviewFamily('292', 'main', '一日');

        const css = injected()[0].textContent ?? '';
        expect(css).toContain('aaa.woff2');
        expect(css).toContain('bbb.woff2');
        expect(css).not.toContain('ccc.woff2');
    });

    it('正式使用注册全部分片', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(CSS, { status: 200 })));
        Object.defineProperty(document, 'fonts', {
            configurable: true,
            value: { load: vi.fn(async () => []), add: vi.fn() },
        });

        const { loadFullFamily } = await import('../../../src/services/fontMarket/zeosevenFont');
        const family = await loadFullFamily('292', 'main');
        expect(family).toBe('zsft-full-292-main');

        const css = injected()[0].textContent ?? '';
        expect(css).toContain('aaa.woff2');
        expect(css).toContain('bbb.woff2');
        expect(css).toContain('ccc.woff2');
    });

    it('主站失败时换镜像，且分片地址跟着换域名', async () => {
        let call = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            call += 1;
            // 第一次（主站）失败，第二次（镜像）成功。
            if (call === 1) return new Response('', { status: 502 });
            return new Response(CSS, { status: 200 });
        }));
        Object.defineProperty(document, 'fonts', {
            configurable: true,
            value: { load: vi.fn(async () => []), add: vi.fn() },
        });

        const { loadFullFamily } = await import('../../../src/services/fontMarket/zeosevenFont');
        await loadFullFamily('292', 'main');

        const css = injected()[0].textContent ?? '';
        expect(css).toContain('https://fontsapi-storagedriver.zeoseven.com/292/main/aaa.woff2');
    });

    it('两个镜像都不通时返回 null，不注入半个样式表', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
        Object.defineProperty(document, 'fonts', {
            configurable: true,
            value: { load: vi.fn(async () => []), add: vi.fn() },
        });

        const { loadPreviewFamily } = await import('../../../src/services/fontMarket/zeosevenFont');
        expect(await loadPreviewFamily('292', 'main', '一')).toBeNull();
        expect(injected()).toHaveLength(0);
    });

    it('同一款字体重复预览不会重复注入', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(CSS, { status: 200 })));
        Object.defineProperty(document, 'fonts', {
            configurable: true,
            value: { load: vi.fn(async () => []), add: vi.fn() },
        });

        const { loadPreviewFamily } = await import('../../../src/services/fontMarket/zeosevenFont');
        await loadPreviewFamily('292', 'main', '一');
        await loadPreviewFamily('292', 'main', '一');
        expect(injected()).toHaveLength(1);
    });
});

describe('zeosevenCatalog', () => {
    it('目录非空，且每条都有 id 与名称', async () => {
        const { ZEOSEVEN_FONTS } = await import('../../../src/services/fontMarket/zeosevenCatalog');
        expect(ZEOSEVEN_FONTS.length).toBeGreaterThan(1000);
        for (const font of ZEOSEVEN_FONTS.slice(0, 50)) {
            expect(font.id).toBeTruthy();
            expect(font.name).toBeTruthy();
        }
    });

    it('能按 id 取回字体', async () => {
        const { getZeosevenFont } = await import('../../../src/services/fontMarket/zeosevenCatalog');
        const font = getZeosevenFont('292');
        expect(font?.name).toContain('霞鹜文楷');
    });

    it('风格与语种有中文名，认不出的原样返回', async () => {
        const { styleLabel, languageLabel } = await import('../../../src/services/fontMarket/zeosevenCatalog');
        expect(styleLabel('serif')).toBe('衬线');
        expect(styleLabel('unknown-style-xyz')).toBe('unknown-style-xyz');
        expect(languageLabel('cn')).toBe('简体中文');
        expect(languageLabel('xx')).toBe('xx');
    });
});
