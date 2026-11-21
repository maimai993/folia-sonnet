import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRhineFrameSrc, buildRhineHostConfig, RHINE_FRAME_PAGE } from '@/library/suites/rhine/rhineHostConfig';

// test/unit/library/rhineHostConfig.test.ts
//
// 「莱茵生命」骨架（res/rhine-theme/）与宿主之间的契约：URL 与 postMessage 两条路必须产生同一份
// 配置，且骨架页面本身必须随仓库走、不依赖资源包（#440）。降级的那一半在 res/rhine-theme 里，
// 这里用纯文本断言锁住它不会在某次迁移里被悄悄改掉。

const ROOT = resolve(__dirname, '../../../res/rhine-theme');
const read = (file: string) => readFileSync(resolve(ROOT, file), 'utf8');

const input = {
    language: 'zh-CN',
    isDaylight: false,
    hasAssetsPackage: false,
    note: '图片素材包还没有下载',
    insets: { top: 12, left: 4 },
};

describe('Rhine frame src', () => {
    it('builds the query from the same config the postMessage path sends', () => {
        const params = new URL(buildRhineFrameSrc(input, './'), 'https://folia.test/').searchParams;
        const config = buildRhineHostConfig(input);
        expect(params.get('lang')).toBe(config.language);
        expect(params.get('theme')).toBe(config.theme);
        expect(params.get('assets')).toBe('0');
        expect(params.get('note')).toBe(config.note);
    });

    it('turns the asset switch on only when the pack is there', () => {
        const params = new URL(buildRhineFrameSrc({ ...input, hasAssetsPackage: true }, './'), 'https://folia.test/').searchParams;
        expect(params.get('assets')).toBe('1');
        expect(buildRhineHostConfig({ ...input, hasAssetsPackage: true }).assets).toBe('downloaded');
    });

    it('keeps the single trailing slash of the deploy base', () => {
        // 测试环境里 BASE_URL 是「/」，所以基址为 '' 时拼出来以 '/' 开头。
        const queryOf = (base: string) => {
            const src = buildRhineFrameSrc(input, base);
            const at = src.indexOf(RHINE_FRAME_PAGE) + RHINE_FRAME_PAGE.length;
            expect(at).toBeGreaterThan(RHINE_FRAME_PAGE.length - 1);
            return src.slice(at);
        };
        const expected = queryOf('');
        expect(expected.startsWith('?')).toBe(true);
        for (const [base, path] of [['', '/'], ['./', './'], ['/', '/'], ['.', './']] as const) {
            // 桌面包与安卓包都是 `./`：少一个斜杠就会解析到 dist 上一级，主题页 404。
            expect(buildRhineFrameSrc(input, base)).toBe(`${path}${RHINE_FRAME_PAGE}${expected}`);
        }
    });

    it('leaves the note out when the host has none to give', () => {
        const params = new URL(buildRhineFrameSrc({ ...input, note: '' }, './'), 'https://folia.test/').searchParams;
        expect(params.has('note')).toBe(false);
    });
});

describe('RhinE skeleton degrades without the asset package', () => {
    /** 页面壳引用的每一份文件：它们必须都在仓库里，而且都不能落在 assets/ 下。 */
    const shellRefs = () => [...read('index.html').matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map(match => match[1]);

    it('ships its own shell that resolves without any downloaded asset', () => {
        const refs = shellRefs();
        expect(refs.length).toBeGreaterThanOrEqual(3);
        for (const ref of refs) {
            expect(ref.startsWith('assets/')).toBe(false);
            expect(() => read(ref)).not.toThrow();
        }
    });

    it('has its palette and safe-area defaults in CSS, never in the asset pack', () => {
        const css = read('adapt/rhineFallback.css');
        // 两套配色都写死在 CSS 里：没有资源包也看得见字和底。
        expect(css).toMatch(/--rhine-bg: #[0-9a-f]{6}/i);
        expect(css).toMatch(/html\[data-rhine-theme='light'\]/);
        // 资源包缺失时给出的说明挂在 data-rhine-assets 上，不是永远显示。
        expect(css).toContain("html[data-rhine-assets='bundled']");
    });

    it('never fetches an asset when the pack is absent', () => {
        for (const file of ['host-entry.js', 'adapt/rhineHostConfig.js']) {
            const source = read(file);
            expect(source).not.toMatch(/\bfetch\s*\(/);
            expect(source).not.toMatch(/XMLHttpRequest/);
            // 也不许把上游的 include()/fb 伪造成「能用」的样子：那会让半残的上游代码跑起来。
            expect(source).not.toMatch(/window\.(fb|plman)\s*=/);
        }
    });

    it('reads the asset switch from the URL, defaulting to "not downloaded"', () => {
        const config = read('adapt/rhineHostConfig.js');
        expect(config).toContain("params.get('assets')");
        expect(config).toMatch(/=== '1'/);
        expect(read('host-entry.js')).toContain('data-rhine-assets');
    });
});
