import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import zhCN from '@/i18n/locales/zh-CN';
import en from '@/i18n/locales/en';
import ind from '@/i18n/locales/in';

// test/unit/i18n/visualizerOptionKeys.test.ts
// 歌词样式与背景的「选项」面板里引用的 options.* 键必须三份语系都有。
// 起因：nebbia 的渲染那组引用了 options.lyricRenderSection / lyricRenderScale / lyricRenderFollowGlobal /
// lyricRenderScaleStyleHint / lyricAntialias* 却一个都没写进语系，面板上直接露出原始键名。

const root = path.resolve(__dirname, '../../..');
const SCAN_DIRS = [
    'src/components/visualizer/nebbia',
    'src/components/visualizer/renderQuality',
];
const KEY_PATTERN = /['"`](options\.[A-Za-z0-9_]+)['"`]/g;

const collectKeys = () => {
    const keys = new Set<string>();
    for (const dir of SCAN_DIRS) {
        const full = path.join(root, dir);
        if (!fs.existsSync(full)) continue;
        for (const name of fs.readdirSync(full)) {
            if (!/\.(ts|tsx)$/.test(name)) continue;
            const text = fs.readFileSync(path.join(full, name), 'utf8');
            // 模板拼接的键（options.nebbiaGlass_${glass}）在这里匹配不到，由各自的测试覆盖
            for (const match of text.matchAll(KEY_PATTERN)) keys.add(match[1].replace('options.', ''));
        }
    }
    return [...keys].sort();
};

const options = (locale: unknown) => (locale as { options: Record<string, string> }).options;

describe('visualizer option keys exist in every locale', () => {
    const keys = collectKeys();

    it('finds the option keys it is meant to check', () => {
        expect(keys.length).toBeGreaterThan(10);
        expect(keys).toContain('lyricRenderSection');
        expect(keys).toContain('lyricRenderFollowGlobal');
    });

    it.each([
        ['zh-CN', zhCN],
        ['en', en],
        ['in', ind],
    ])('%s has a non-empty value for each', (_name, locale) => {
        const table = options(locale);
        const missing = keys.filter(key => !table[key]?.trim());
        expect(missing).toEqual([]);
    });
});
