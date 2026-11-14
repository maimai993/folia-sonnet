import { describe, expect, it } from 'vitest';
import { resolveWallpaperColors, stepColorTowards } from '../../../src/entries/wallpaperSurfaceTheme';

// test/unit/platform/wallpaperSurfaceTheme.test.ts
// 叠层那四个颜色到底从哪来：这两组用例钉住的是「App 那份没送到时不许退回随机色」，
// 以及平滑不会把颜色改掉（收敛后必须正好等于目标色）。

const skeleton = {
    accentColor: '#33ff88',
    primaryColor: '#111111',
    secondaryColor: '#222222',
    backgroundColor: '#333333',
};

describe('resolveWallpaperColors', () => {
    it('四个颜色都在整包里时一律用整包那份', () => {
        const resolved = resolveWallpaperColors({
            accent: '#ff0000',
            primaryColor: '#00ff00',
            secondaryColor: '#0000ff',
            backgroundColor: '#ffffff',
            theme: { primaryColor: '#123456' } as never,
            skeleton,
            isDaylight: false,
        });

        expect(resolved.accent).toBe('#ff0000');
        expect(resolved.primaryColor).toBe('#00ff00');
        expect(resolved.secondaryColor).toBe('#0000ff');
        expect(resolved.backgroundColor).toBe('#ffffff');
        expect(resolved.sources).toEqual({
            accent: 'payload',
            primaryColor: 'payload',
            secondaryColor: 'payload',
            backgroundColor: 'payload',
        });
    });

    it('整包缺三个主题色时改用整份主题里的，不碰内置主题', () => {
        const resolved = resolveWallpaperColors({
            accent: '#ff0000',
            theme: {
                primaryColor: '#abcdef',
                secondaryColor: '#fedcba',
                backgroundColor: '#010203',
            } as never,
            skeleton,
            isDaylight: false,
        });

        expect(resolved.primaryColor).toBe('#abcdef');
        expect(resolved.secondaryColor).toBe('#fedcba');
        expect(resolved.backgroundColor).toBe('#010203');
        expect(resolved.primaryColor).not.toBe(skeleton.primaryColor);
        expect(resolved.sources.primaryColor).toBe('theme');
        expect(resolved.sources.secondaryColor).toBe('theme');
        expect(resolved.sources.backgroundColor).toBe('theme');
    });

    it('只剩高亮色时由它派生其余三个（旧行为），不落回内置主题', () => {
        const resolved = resolveWallpaperColors({
            accent: '#ff8800',
            skeleton,
            isDaylight: false,
        });

        expect(resolved.accent).toBe('#ff8800');
        // 主文本色 = 高亮色（旧行为）。
        expect(resolved.primaryColor).toBe('#ff8800');
        // 次色比主色亮一档，且不相等（未唱到的行要能分辨）。
        expect(resolved.secondaryColor).not.toBe(resolved.primaryColor);
        // 底色同源派生：不再是内置主题那套随机的颜色。
        expect(resolved.backgroundColor).not.toBe(skeleton.backgroundColor);
        expect(resolved.sources).toEqual({
            accent: 'payload',
            primaryColor: 'derived',
            secondaryColor: 'derived',
            backgroundColor: 'derived',
        });
    });

    it('派生出来的颜色是确定的：同一份输入不给随机结果', () => {
        const first = resolveWallpaperColors({ accent: '#2f6fed', skeleton, isDaylight: false });
        const second = resolveWallpaperColors({ accent: '#2f6fed', skeleton, isDaylight: false });

        expect(second).toEqual(first);
    });

    it('什么都没有时才是内置主题兜底', () => {
        const resolved = resolveWallpaperColors({ skeleton, isDaylight: true });

        expect(resolved.accent).toBe(skeleton.accentColor);
        expect(resolved.primaryColor).toBe(skeleton.accentColor);
        expect(resolved.sources.accent).toBe('builtin');
    });

    it('空串 / 空白当成没给，不算「拿到了颜色」', () => {
        const resolved = resolveWallpaperColors({
            accent: '   ',
            primaryColor: '',
            theme: { accentColor: '#00ffff' } as never,
            skeleton,
            isDaylight: false,
        });

        expect(resolved.accent).toBe('#00ffff');
        expect(resolved.sources.accent).toBe('theme');
        expect(resolved.sources.primaryColor).toBe('derived');
    });

    it('白天的派生底色朝亮处走，夜里朝暗处走', () => {
        const dark = resolveWallpaperColors({ accent: '#808080', skeleton, isDaylight: false });
        const light = resolveWallpaperColors({ accent: '#808080', skeleton, isDaylight: true });

        expect(dark.backgroundColor).not.toBe(light.backgroundColor);
    });
});

describe('stepColorTowards', () => {
    it('目标没变时不产生新值', () => {
        expect(stepColorTowards('#112233', '#112233', 16)).toBeUndefined();
    });

    it('目标为空时交回 null（交给主题兜底）', () => {
        expect(stepColorTowards('#112233', undefined, 16)).toBeNull();
        expect(stepColorTowards('#112233', '  ', 16)).toBeNull();
    });

    it('首份颜色直接落位，不从黑色渐变过来', () => {
        expect(stepColorTowards(null, '#445566', 16)).toBe('#445566');
    });

    it('过渡过程中向目标靠近，最终正好等于目标色', () => {
        let current: string | null = '#000000';
        for (let index = 0; index < 100; index += 1) {
            const next = stepColorTowards(current, '#ffffff', 16);
            if (next === undefined) break;
            current = next;
        }
        expect(current).toBe('#ffffff');
    });
});
