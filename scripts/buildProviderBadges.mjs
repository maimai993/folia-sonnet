#!/usr/bin/env node
// scripts/buildProviderBadges.mjs
// 从 src/components/shared/platformIcons 的自绘图形，机械生成安卓播放通知栏的角标:
// android/app/src/main/res/drawable/ic_provider_<名字>.xml（VectorDrawable）。
//
// 为什么是纯白剪影：通知栏的 smallIcon 从 Android 5.0 起只认 alpha，彩色图会被整体染成
// 一个没有细节的色块。所以这里只保留「特征笔画」，去掉底板，画成白色笔画的透明底图形。
//
// 几何怎么转：图标是 48 画布上的一套 SVG 原语，剪影收进 24 视口、四周留 BADGE_INSET。
// 每个原语按 platformIconShapes 的 PlatformIconGesture 分两类：
//   outline —— 只描边不填充的外框。剪影里画成「同宽白描边 + 同宽白线盖在里面」：外面那圈把
//              形状往外撑（和 fill 撑开的效果一样），里面那圈把环心填实，于是线稿在纯白的剪影里
//              也是实心的（smallIcon 里没有颜色，中空的环会变成一圈圈看不清的细线）。
//   stroke  —— 实心的一笔。剪影里一律纯白；带了两侧描边的那几笔（细三角）按两倍宽撑一圈。
//
// 用法：
//   node scripts/buildProviderBadges.mjs            # 生成 / 覆盖
//   node scripts/buildProviderBadges.mjs --check    # 只比对，不一样就退 1（门禁与 CI 用）

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const iconDir = join(projectRoot, 'src', 'components', 'shared', 'platformIcons');
const resDir = join(projectRoot, 'android', 'app', 'src', 'main', 'res', 'drawable');

/** 与 src/components/shared/platformIcons/platformIconShapes.ts 的 BADGE_VIEWPORT / BADGE_INSET 一致。 */
const BADGE_VIEWPORT = 24;
const BADGE_INSET = 2;
/** 图标画布边长，与 PLATFORM_ICON_CANVAS 一致。 */
const ICON_CANVAS = 48;

const SCALE = (BADGE_VIEWPORT - BADGE_INSET * 2) / ICON_CANVAS;

/**
 * 把一个 SVG 路径里的每对坐标按剪影的缩放与平移重写（`a` 弧的半径也要跟着乘）。
 *
 * 只支持平台文件里用到的那几条命令：`M`/`L` 绝对、`h`/`v`/`a` 相对、`Z`。认不出的命令直接报错，
 * 免得哪天加了一笔不认识的写法，剪影悄悄画歪。
 */
function transformPath(d) {
    // 注意不能带 /i：带 i 时 [a-z] 连 M、L、Z 这些大写命令也一起吃掉，整条路径就被当成了一个命令。
    const tokens = d.match(/[MmLlHhVvAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
    const scaled = value => Number((Number(value) * SCALE + BADGE_INSET).toFixed(3));
    const shifted = value => Number((Number(value) * SCALE).toFixed(3));
    const out = [];
    let index = 0;
    const take = () => {
        if (index >= tokens.length) throw new Error(`这份路径的参数个数不对：${d}`);
        return tokens[index++];
    };
    while (index < tokens.length) {
        const command = take();
        if (!/^[MmLlHhVvAaZz]$/.test(command)) {
            throw new Error(`剪影只认 M/L/h/v/a/Z 这几条路径命令，遇到了「${command}」（整条：${d}）`);
        }
        out.push(command);
        const absolute = command === command.toUpperCase();
        switch (command.toLowerCase()) {
            case 'z':
                break;
            case 'h':
                out.push(absolute ? scaled(take()) : shifted(take()));
                break;
            case 'v':
                out.push(absolute ? scaled(take()) : shifted(take()));
                break;
            case 'a': {
                // rx ry rotation large-arc sweep x y —— 半径按比例缩放，旋转角与两个标记原样。
                const rx = Number(take()) * SCALE;
                const ry = Number(take()) * SCALE;
                const rotation = take();
                const largeArc = take();
                const sweep = take();
                const x = take();
                const y = take();
                out.push(Number(rx.toFixed(3)), Number(ry.toFixed(3)), rotation, largeArc, sweep,
                    absolute ? scaled(x) : shifted(x),
                    absolute ? scaled(y) : shifted(y));
                break;
            }
            default:
                out.push(scaled(take()), scaled(take()));
                break;
        }
    }
    const result = out.join(' ').replace(/\s+/g, ' ').trim();
    if (/NaN|undefined/.test(result)) throw new Error(`这份路径转出来是坏的：${d} → ${result}`);
    return result;
}

/** 一条 <path> 的 XML：剪影里一律纯白。 */
const pathXml = (d, { stroke = null } = {}) => `    <path
        android:pathData="${d}"
        android:fillColor="#FFFFFF"${stroke === null ? '' : `
        android:strokeColor="#FFFFFF"
        android:strokeWidth="${stroke}"
        android:strokeLineCap="round"
        android:strokeLineJoin="round"`} />`;

/**
 * 图标特征 → 剪影的 path 列表。
 *
 * 数据从各 `<平台>Icon.tsx` 里读 `gestures`（TypeScript 源，这里用正则拿出来；生成脚本不跑 tsc），
 * 每一条按 kind 决定怎么画。
 */
/**
 * 图标特征 → 剪影的 path 列表。
 *
 * 数据从各 `<平台>Icon.tsx` 里读 `gestures`（TypeScript 源，这里用正则拿出来；生成脚本不跑 tsc），
 * 每一条按 kind 决定怎么画。
 *
 * 纯白剪影里没有颜色，中空的环会退成一圈圈看不清的细线，所以两种笔画都按「实心」画：
 * outline 先 paint 一遍这块形状本身（`fillColor="#FFFFFF"`），再沿中心线描一圈同色的粗线，
 * 把两端和拐角按圆头补成圆角。描边完全盖住填充、不露出填充的直拐角，所以两次 paint
 * 叠起来是一条干净的实心笔画——纯白的剪影里不存在色调，只存在 alpha 形状。
 */
function silhouettePaths(gestures) {
    const parts = [];
    for (const gesture of gestures) {
        const d = transformPath(gesture.d);
        const width = (3 + (gesture.stroke ? (gesture.stroke.width ?? 0) * 2 : 0)) * SCALE;
        parts.push(pathXml(d, { stroke: width }));
    }
    return parts;
}

/**
 * 从 `<平台>Icon.tsx` 的源码里取出 `gestures` 数组。
 *
 * 只认这个目录里固定的写法：`const gestures: PlatformIconGesture[] = [ { kind: 'outline'|'stroke',
 * d: '…', fill?: '#…', stroke?: { …, width: n } }, … ];`。写法一变就报错，不猜。
 */
function readGestures(file) {
    const source = readFileSync(file, 'utf8');
    const block = source.match(/const gestures: PlatformIconGesture\[\] = \[([\s\S]*?)\n\];/);
    if (!block) throw new Error(`${relative(projectRoot, file)}: 找不到 gestures 数组`);
    // typing 里的 `PlatformIconGesture[]` 本身带着方括号，所以按行扫、只收以 `{ kind:` 开头的行。
    const lines = block[1].split('\n').filter(line => /^\s*\{ kind: '?(outline|stroke)'?/.test(line));
    if (lines.length === 0) throw new Error(`${relative(projectRoot, file)}: gestures 是空的`);
    return lines.map((line) => {
        const kind = line.match(/kind: '?(outline|stroke)'?/)[1];
        // `d:` 必须是一个属性的开头（前面是 `{` 或 `,`）：`boundary: '…'` 之类的键里也有 `d:`。
        const literal = line.match(/[{,]\s*d:\s*'([^']+)'/);
        const dotCall = line.match(/[{,]\s*d:\s*dot\(([^)]*)\)/);
        let path = literal?.[1];
        if (!path) {
            if (!dotCall) throw new Error(`${relative(projectRoot, file)}: 这一笔的 d 既不是字面量也不是 dot()：${line.trim()}`);
            const args = dotCall[1].split(',').map(value => value.trim());
            if (args.length !== 3) throw new Error(`${relative(projectRoot, file)}: dot() 要三个数：${line.trim()}`);
            const [cx, cy, r] = args.map(Number);
            path = `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;
        }
        // 现在只有「细三角那几笔」带两侧描边，写法是 `stroke: { color: W, width: 2 }`。
        const width = line.match(/[{,]\s*stroke:\s*\{\s*color:\s*[^,]+,\s*width:\s*([\d.]+)\s*\}/);
        return { kind, d: path, ...(width ? { stroke: { width: Number(width[1]) } } : {}) };
    });
}

/** 从 registry.ts 取出「哪个平台画哪一颗角标」。 */
function readBadgeTable() {
    const source = readFileSync(join(iconDir, 'registry.ts'), 'utf8');
    const table = new Map();
    const pattern = /\[PLATFORM_IDS\.(\w+)\]: \{[^}]*androidBadge: '([\w-]+)'/g;
    let match;
    while ((match = pattern.exec(source)) !== null) table.set(match[1], match[2]);
    return table;
}

/** 平台 id → 它的图标源文件（`registry.ts` 里 `import <x>Icon from './<x>Icon'`）。 */
function readIconFiles() {
    const source = readFileSync(join(iconDir, 'registry.ts'), 'utf8');
    const files = {};
    for (const match of source.matchAll(/import (\w+) from '\.\/(\w+)'/g)) files[match[1]] = join(iconDir, `${match[2]}.tsx`);
    const platforms = {};
    for (const match of source.matchAll(/\[PLATFORM_IDS\.(\w+)\]: \{ art: (\w+)/g)) platforms[match[1]] = files[match[2]];
    return platforms;
}

/** 一份 VectorDrawable 的 XML。 */
function drawableXml(name, paths) {
    return `<?xml version="1.0" encoding="utf-8"?>
<!--
  ${name}：安卓播放通知栏的角标（smallIcon），**纯白剪影 + 透明底**。
  通知栏从 Android 5.0 起只认 alpha，彩色图会被整体染成一个色块，所以这里只留特征笔画、不留底板。
  图形是自绘的，和前端 <PlatformIcon> 同一份几何数据；这个文件由 npm run build:provider-badges
  从 src/components/shared/platformIcons/ 生成，不要手改。
-->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
${paths.join('\n')}
</vector>
`;
}

function build() {
    const table = readBadgeTable();
    const platforms = readIconFiles();
    const files = new Map();
    for (const [platform, badge] of table) {
        const source = platforms[platform];
        if (!source) throw new Error(`registry.ts 里 ${platform} 没有对应的图标文件`);
        files.set(`ic_provider_${badge}.xml`, drawableXml(`ic_provider_${badge}`, silhouettePaths(readGestures(source))));
    }
    return files;
}

const check = process.argv.includes('--check');
const files = build();
if (check) {
    const stale = [];
    for (const [name, content] of files) {
        let current = '';
        try {
            current = readFileSync(join(resDir, name), 'utf8');
        } catch {
            current = '';
        }
        if (current !== content) stale.push(name);
    }
    if (stale.length > 0) {
        console.error('[build:provider-badges] 这些角标与自绘图形不一致：' + stale.join(', '));
        console.error('[build:provider-badges] 跑 node scripts/buildProviderBadges.mjs 重新生成。');
        process.exit(1);
    }
    console.log(`[build:provider-badges] ${files.size} 个角标都是最新的。`);
} else {
    mkdirSync(resDir, { recursive: true });
    for (const [name, content] of files) writeFileSync(join(resDir, name), content, 'utf8');
    console.log(`[build:provider-badges] 写出 ${files.size} 个角标：${[...files.keys()].join(', ')}`);
}
