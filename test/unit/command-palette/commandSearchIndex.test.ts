import { describe, expect, it } from 'vitest';
import {
    findCommandsByTrigger,
    getCommandPrimaryTerm,
    getCommandSearchIndex,
} from '../../../src/components/command-palette/search/commandSearchIndex';
import { COMMAND_PALETTE_COMMANDS } from '../../../src/components/command-palette/commandRegistry';
import type { CommandPaletteCommand } from '../../../src/components/command-palette/types';

// test/unit/command-palette/commandSearchIndex.test.ts
// 索引的构建与缓存。检索行为本身由 commandRegistry.test.ts 覆盖；这里只管索引的形状、
// 缓存的失效条件，以及 primaryTerm 这条取代 keywords[0] 的回退链。

const commands = COMMAND_PALETTE_COMMANDS;
const entryFor = (id: string, locale = 'en') => getCommandSearchIndex(commands, locale).byId.get(id)!;

describe('command search index', () => {
    it('normalizes, dedupes and length-sorts triggers', () => {
        const entry = entryFor('settings-options');

        expect(entry.triggers.every(trigger => trigger === trigger.trim().toLowerCase())).toBe(true);
        expect(new Set(entry.triggers).size).toBe(entry.triggers.length);
        for (let i = 1; i < entry.triggers.length; i += 1) {
            expect(entry.triggers[i].length).toBeGreaterThanOrEqual(entry.triggers[i - 1].length);
        }
    });

    it('indexes generated pinyin and initials for a CJK synonym', () => {
        const entry = entryFor('settings-options');

        // '设置' 是手写同义词，它的全拼与首字母都来自构建期生成的字典，而不是手写的。
        expect(entry.triggers).toContain('设置');
        expect(entry.triggers).toContain('shezhi');
        expect(entry.initials).toContain('sz');
    });

    it('keeps title words out of the full-strength trigger set', () => {
        // 'Panel: queue' 切出的 queue 只能进扣分档，否则它会和 queue 命令自己的同义词打平，
        // 再由标题字典序决定胜负——输入 queue 排第一的就成了面板。
        const panelQueue = entryFor('panel-queue');

        expect(panelQueue.titleWords).toContain('queue');
        expect(panelQueue.triggers).not.toContain('queue');
    });

    it('indexes the English title regardless of the active locale', () => {
        // 删掉手写英文别名后，中文界面下仍必须能用英文搜到。
        const inChinese = entryFor('playback-shuffle', 'zh-CN');
        expect([...inChinese.triggers, ...inChinese.titleWords]).toContain('shuffle');
    });

    it('adds the active locale title on top of English', () => {
        const inEnglish = entryFor('settings-options', 'en');
        const inChinese = entryFor('settings-options', 'zh-CN');

        expect(inChinese.triggers).toContain('打开选项');
        expect(inEnglish.triggers).not.toContain('打开选项');
    });

    it('keeps pinyin available even when the UI is English', () => {
        // 拼音是一条常开车道，与界面语言无关。
        const inEnglish = entryFor('settings-options', 'en');
        expect(inEnglish.triggers).toContain('shezhi');
    });

    it('separates haystack fields so contains cannot straddle two of them', () => {
        const entry = entryFor('settings-options');
        expect(entry.haystack).toContain(' | ');
    });

    it('resolves a non-empty primary term for every static command', () => {
        const empty = commands
            .filter(command => command.textSource !== 'runtime' && !command.hidden)
            .filter(command => !getCommandPrimaryTerm(commands, command));

        expect(empty.map(command => command.id)).toEqual([]);
    });

    it('falls back through ascii trigger, English title word, then id', () => {
        const withoutText: CommandPaletteCommand = {
            id: 'not-in-any-locale',
            group: 'settings',
            title: 'Nope',
            description: 'Nope',
            keywords: [],
            execute: () => true,
        };

        expect(getCommandPrimaryTerm([withoutText], withoutText)).toBe('not-in-any-locale');
    });

    it('reuses the index for the same array and locale, and rebuilds for another locale', () => {
        const first = getCommandSearchIndex(commands, 'en');
        expect(getCommandSearchIndex(commands, 'en')).toBe(first);
        expect(getCommandSearchIndex(commands, 'zh-CN')).not.toBe(first);

        // 换数组实例就是换缓存条目——WeakMap 会随数组一起回收。
        expect(getCommandSearchIndex([...commands], 'en')).not.toBe(first);
    });

    it('maps a trigger back to its commands in registry order', () => {
        const found = findCommandsByTrigger(commands, 'queue');
        expect(found.map(command => command.id)).toContain('queue');

        const registryOrder = commands.map(command => command.id);
        const positions = found.map(command => registryOrder.indexOf(command.id));
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });

    it('returns an empty list for an unknown trigger instead of throwing', () => {
        expect(findCommandsByTrigger(commands, 'definitely-not-a-trigger')).toEqual([]);
    });
});
