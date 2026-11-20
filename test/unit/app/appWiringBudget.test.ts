// test/unit/app/appWiringBudget.test.ts
// 入口复杂度（issue H25）。
//
// `App.tsx` 从几千行降到了 38 行，形式上门禁过了；但入口承担的职责没有消失，而是整体
// 平移进了 `components/app/appWiring/`。于是「入口文件多大」这个唯一可自动检验的结构性
// 指标失效了 —— 它很小，真实复杂度在旁边的目录里，而门禁只看单个文件。
//
// 这里把「入口」重新定义为 **App.tsx + appWiring/ 合计**，给它一个预算。这不是要求一次性
// 把那 3900 行拆掉（它们每个都在 800 行门禁之内，按职责命名，本身没有失控），而是让
// 「入口继续膨胀」这件事从此必须显式改预算，改预算就得在这里写理由。
//
// 同时钉住两件让复杂度**可枚举**的事：每个 hook 的职责从文件名就能看出（不许出现
// useAppPart1 / useAppMisc 这种堆放），且 App.tsx 自己保持纯组装。

import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const APP_WIRING_DIR = path.resolve('src/components/app/appWiring');
const APP_ENTRY = path.resolve('src/App.tsx');

/**
 * 入口预算（内容行，不含末尾换行）。
 *
 * 定在现状之上留一点余量：加一两个 hook 不用改这里，而「又多了一个大功能整块塞进来」
 * 会撞线，那时该做的是给那个功能自己的目录，而不是把预算往上调。
 */
const ENTRY_BUDGET_LINES = 4200;

/**
 * 单个 hook 的上限。
 *
 * 定在 600 而不是 800（全仓的单文件门禁）：现状最大的 `useAppPlaybackBridges` 是 566 行，
 * 一个「接线」hook 到这个体量已经该考虑按职责拆了。600 让它和 `useAppFoundation`（521）
 * 都留在线上，但再涨就撞线 —— 撞线时该拆，而不是把数字往上调。
 */
const PER_HOOK_BUDGET_LINES = 600;

const contentLines = (text: string): number => {
    const lines = text.split('\n');
    /* 与 ci/uiPolicy.ts 的口径一致：文件末尾那个换行不算一行。 */
    return text.endsWith('\n') ? lines.length - 1 : lines.length;
};

const wiringFiles = (): string[] => fs.readdirSync(APP_WIRING_DIR)
    .filter(name => /\.tsx?$/.test(name))
    .sort();

describe('入口复杂度预算（H25）', () => {
    it('App.tsx + appWiring 的合计行数在预算内', () => {
        const total = wiringFiles().reduce(
            (sum, name) => sum + contentLines(fs.readFileSync(path.join(APP_WIRING_DIR, name), 'utf8')),
            contentLines(fs.readFileSync(APP_ENTRY, 'utf8')),
        );
        expect(
            total,
            `入口合计 ${total} 行，超过预算 ${ENTRY_BUDGET_LINES}。新增的大块职责应该进它自己的`
            + '功能目录，而不是继续堆在 appWiring；确实要调预算，请在测试文件里写清理由。',
        ).toBeLessThanOrEqual(ENTRY_BUDGET_LINES);
        /* 预算不能定得离谱地宽 —— 那和没有一样。 */
        expect(total).toBeGreaterThan(1000);
    });

    it('每个接线 hook 都在自己的预算内', () => {
        const over = wiringFiles()
            .map(name => ({ name, lines: contentLines(fs.readFileSync(path.join(APP_WIRING_DIR, name), 'utf8')) }))
            .filter(entry => entry.lines > PER_HOOK_BUDGET_LINES);
        expect(
            over.map(entry => `${entry.name} (${entry.lines} 行)`),
            `这些 hook 超过了 ${PER_HOOK_BUDGET_LINES} 行，该按职责再拆一层`,
        ).toEqual([]);
    });

    /*
     * 职责可枚举：文件名要说出它管什么。禁止的是 useAppPart2、useAppMisc、useAppMore
     * 这类「只是把东西挪到旁边」的名字 —— 那正是 H25 说的「复杂度平移，指标失真」。
     */
    it('每个 hook 的文件名都说得出职责', () => {
        const vague = wiringFiles().filter(name => /(Part\d|Misc|More|Other|Helpers?|Utils?)\.tsx?$/.test(name));
        expect(vague, '这些文件名说不出职责，等于把复杂度藏起来').toEqual([]);
    });

    /*
     * App.tsx 只做组装：调用各 useApp* 并渲染。它自己一旦开始写业务逻辑，
     * 「入口很小」就又变成了假象。
     */
    it('App.tsx 保持纯组装，不直接写业务逻辑', () => {
        const source = fs.readFileSync(APP_ENTRY, 'utf8');
        /* 它是胶水层：应当调用多个 useApp*。 */
        expect(source.match(/useApp[A-Za-z]+\(/g)?.length ?? 0).toBeGreaterThan(3);
        /* 不该直接碰存储、网络或原生桥。 */
        expect(source).not.toMatch(/localStorage\./);
        expect(source).not.toMatch(/\bfetch\(/);
        expect(source).not.toMatch(/Capacitor\./);
    });
});
