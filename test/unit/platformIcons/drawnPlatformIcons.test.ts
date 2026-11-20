// test/unit/platformIcons/drawnPlatformIcons.test.ts
// 平台图标是自绘的（issue #451）：前端没有任何平台位图，安卓通知栏的角标是从同一份几何
// 生成出来的纯白剪影。这里钉住四件事 ——
//   1. 登记过的平台都有图形，没登记的回落得到（不出现空洞）；
//   2. 每一笔都画在内容框里，且只用量得准的路径命令；
//   3. res/drawable 里的 ic_provider_*.xml 与生成器算出来的完全一致（改了图形忘了重新生成会红）；
//   4. 仓库里不再有任何第三方平台的位图。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    BADGE_INSET,
    BADGE_VIEWPORT,
    PLATFORM_ICON_CANVAS,
    PLATFORM_ICON_INSET,
    platformIconPaths,
} from '@/components/shared/platformIcons/platformIconShapes';
import { findPlatformIcon, hasPlatformIcon, PLATFORM_ICONS } from '@/components/shared/platformIcons/registry';
import { PLATFORM_IDS } from '@/components/shared/platformIcons/platformIds';

const root = process.cwd();
const resDir = join(root, 'android', 'app', 'src', 'main', 'res');

/**
 * 把一条路径走一遍，返回它经过的所有**点**（相对命令也按当前点算出来）。
 *
 * 只看数字是不够的：`l3.4 3.4` 的 3.4 是偏移量，不是坐标。所以这里按命令累加，
 * 量的是「画在画布上的哪儿」。
 */
const tracePath = (d: string): Array<[number, number]> => {
    const tokens = d.match(/[MmLlHhVvAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
    const points: Array<[number, number]> = [];
    let x = 0;
    let y = 0;
    let index = 0;
    const take = () => Number(tokens[index++]);
    while (index < tokens.length) {
        const command = tokens[index++];
        const absolute = command === command.toUpperCase();
        switch (command.toLowerCase()) {
            case 'm':
            case 'l': {
                const dx = take();
                const dy = take();
                x = absolute ? dx : x + dx;
                y = absolute ? dy : y + dy;
                points.push([x, y]);
                break;
            }
            case 'h':
                x = absolute ? take() : x + take();
                points.push([x, y]);
                break;
            case 'v':
                y = absolute ? take() : y + take();
                points.push([x, y]);
                break;
            case 'a': {
                // rx ry rotation large-arc sweep x y：端点算到当前点上，弧本身不会跑出端点外。
                take();
                take();
                take();
                take();
                take();
                const dx = take();
                const dy = take();
                x = absolute ? dx : x + dx;
                y = absolute ? dy : y + dy;
                points.push([x, y]);
                break;
            }
            default:
                break;
        }
    }
    return points;
};

/** 每一笔的指令集合（大写，去掉参数）。 */
const pathCommands = (d: string): string[] => (d.match(/[MmLlHhVvAaZz]/g) ?? []).map(command => command.toUpperCase());

describe('the drawn platform icons', () => {
    it('draws an icon for every filed platform id, and answers null for one that is not filed', () => {
        for (const id of Object.values(PLATFORM_IDS)) {
            expect(hasPlatformIcon(id), `no icon filed for ${id}`).toBe(true);
            expect(findPlatformIcon(id), `no icon filed for ${id}`).not.toBeNull();
        }
        // 没登记的 id（mod 加的平台、写错的名字）：回落，调用方改画字 + 颜色。
        expect(hasPlatformIcon('no-such-platform')).toBe(false);
        expect(findPlatformIcon('no-such-platform')).toBeNull();
        expect(hasPlatformIcon('')).toBe(false);
        expect(findPlatformIcon(null)).toBeNull();
    });

    it('builds the drawn content out of the gestures it keeps, so the two can never drift apart', () => {
        for (const entry of PLATFORM_ICONS) {
            expect(entry.art.content, `${entry.id} content is not its gestures`).toBe(platformIconPaths(entry.art.gestures));
            expect(entry.art.content, `${entry.id} draws nothing`).not.toBe('');
        }
    });

    it('keeps every stroke inside the content box, so a round crop never cuts one off', () => {
        const low = PLATFORM_ICON_INSET.x;
        const high = PLATFORM_ICON_CANVAS - PLATFORM_ICON_INSET.x;
        expect(PLATFORM_ICONS.length).toBeGreaterThan(0);
        for (const { id, art } of PLATFORM_ICONS) {
            expect(art.gestures.length, `${id} draws nothing`).toBeGreaterThan(0);
            for (const gesture of art.gestures) {
                /*
                 * 3 像素的圆头描边会探出中心线 1.5 像素，留 2 像素余量。
                 * 圆心还要再让一个半径：弧的圆心最多比端点更靠里，所以半径也一起量。
                 */
                for (const [x, y] of tracePath(gesture.d)) {
                    expect(x, `${id}: ${gesture.d} reaches outside the box`).toBeGreaterThanOrEqual(low - 2);
                    expect(x, `${id}: ${gesture.d} reaches outside the box`).toBeLessThanOrEqual(high + 2);
                    expect(y, `${id}: ${gesture.d} reaches outside the box`).toBeGreaterThanOrEqual(low - 2);
                    expect(y, `${id}: ${gesture.d} reaches outside the box`).toBeLessThanOrEqual(high + 2);
                }
                // 半径不超过内容框的边长：半径再大，圆心算出来就会跑到框外。
                for (const match of gesture.d.matchAll(/[aA]\s*(-?\d*\.?\d+)\s+(-?\d*\.?\d+)/g)) {
                    expect(Math.abs(Number(match[1])), `${id}: ${gesture.d} has a huge radius`).toBeLessThanOrEqual(high - low);
                    expect(Math.abs(Number(match[2])), `${id}: ${gesture.d} has a huge radius`).toBeLessThanOrEqual(high - low);
                }
                // 只用量得准的命令：M / L / H / V / A / Z。C / S / Q / T 在剪影的缩放里没有意义。
                for (const command of pathCommands(gesture.d)) {
                    expect(['M', 'L', 'H', 'V', 'A', 'Z'], `${id}: ${gesture.d} uses ${command}`).toContain(command);
                }
            }
            // 每一组图形都要给出可读的说明（无障碍的 <title>）。
            expect(art.description.length, `${id} has no description`).toBeGreaterThan(0);
            // 底板必须是实色（它就是那颗圆/方的底）。
            expect(art.background, `${id} has no background`).toMatch(/^#[0-9A-Fa-f]{6}$/);
        }
    });
});

describe('the android notification badges', () => {
    const drawableDir = join(resDir, 'drawable');
    const drawables = readdirSync(drawableDir).filter(name => /^ic_provider_.*\.xml$/.test(name));

    it('has one badge per platform that declares one, and no orphan badge', () => {
        const declared = PLATFORM_ICONS
            .filter(entry => entry.androidBadge)
            .map(entry => `ic_provider_${entry.androidBadge ?? ''}.xml`);
        expect(declared.length).toBeGreaterThan(0);
        for (const name of declared) expect(drawables, `${name} is missing`).toContain(name);
        // 反过来：目录里不许有没人认领的角标（删平台时一起删）。
        expect([...drawables].sort()).toEqual([...declared].sort());
    });

    it('draws the badge in pure white on a transparent background, because the shade only reads alpha', () => {
        for (const name of drawables) {
            const xml = readFileSync(join(drawableDir, name), 'utf8');
            // 只有白色：任何非白的描边/填充都会被通知栏压成一个看不出形状的色块。
            const colors = xml.match(/#[0-9A-Fa-f]{3,8}/g) ?? [];
            expect(colors.length, `${name} paints nothing`).toBeGreaterThan(0);
            for (const color of colors) expect(color.toUpperCase(), `${name} uses ${color}`).toBe('#FFFFFF');
            expect(xml).toContain('android:viewportWidth="24"');
            expect(xml).toContain('android:viewportHeight="24"');
            // 圆头线端：剪影靠它把线稿糊成实心的一笔。
            expect(xml).toContain('android:strokeLineCap="round"');
            // 不留底板：没有整块的填充矩形（底板会把剪影糊成一个方块）。
            expect(xml).not.toMatch(/pathData="M ?0 ?0 ?[hH] ?24 ?[vV] ?24 ?[hH]-24 ?[zZ]"/);
        }
    });

    it('is generated from the same geometry the frontend draws (npm run build:provider-badges)', () => {
        // 生成器自己逐字节比对；哪里不一样就退 1。
        const script = join(root, 'scripts', 'buildProviderBadges.mjs');
        expect(existsSync(script)).toBe(true);
        expect(() => execFileSync(process.execPath, [script, '--check'], { cwd: root, stdio: 'pipe' })).not.toThrow();
    });

    it('keeps the badge inset so the shade does not clip the strokes', () => {
        // 视口 24、留边 2，图形按 48 画布等比缩到 20：前端那 3 像素的描边正好变成 1.25dp。
        expect(BADGE_VIEWPORT).toBe(24);
        expect(BADGE_INSET).toBeGreaterThan(0);
        expect(BADGE_INSET).toBeLessThan(BADGE_VIEWPORT / 2);
    });
});

describe('the platform bitmaps', () => {
    it('ships none of them, for the shade or for the window', () => {
        const nodpi = join(resDir, 'drawable-nodpi');
        if (existsSync(nodpi)) {
            const bitmaps = readdirSync(nodpi).filter(name => /^ic_provider_.*\.(png|webp|jpg|jpeg)$/i.test(name));
            expect(bitmaps, 'the notification badges are VectorDrawables now').toEqual([]);
        }
        // 前端只留 folia 自己的那枚图标；没有任何第三方平台的画。
        const assets = join(root, 'src', 'assets', 'providers');
        expect(readdirSync(assets).sort()).toEqual(['folia.svg']);
    });

    it('does not import one from anywhere else', () => {
        // assets/providers 之外也不许有 png / webp / svg 形状的平台图标表。
        expect(existsSync(join(root, 'src', 'assets', 'providers', 'appIcons.ts'))).toBe(false);
    });
});
