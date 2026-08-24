import { describe, expect, it } from 'vitest';
import { COMMAND_PALETTE_COMMANDS } from '../../../src/components/command-palette/commandRegistry';
import en from '../../../src/i18n/locales/en';
import zhCN from '../../../src/i18n/locales/zh-CN';
import id from '../../../src/i18n/locales/in';

// test/unit/command-palette/commandRegistryContract.test.ts
// Guards the registry invariants a refactor must not silently break: id set, landing-list
// order, and per-command translation coverage across every shipped locale.

const LOCALES = { en, 'zh-CN': zhCN, in: id } as const;

// Static commands resolve their text through commandPalette.commands.<id>. Runtime commands
// (queue songs) carry song metadata and must never be treated as translation keys; hidden
// commands (mode carriers such as execute mode) are never listed, so they need neither.
const staticCommands = COMMAND_PALETTE_COMMANDS.filter(
    command => command.textSource !== 'runtime' && !command.hidden,
);

const readCommandText = (locale: (typeof LOCALES)[keyof typeof LOCALES], commandId: string) => {
    const commands = (locale as any).commandPalette?.commands as Record<string, { title?: string; description?: string }> | undefined;
    return commands?.[commandId];
};

describe('command palette registry contract', () => {
    it('keeps command ids unique', () => {
        const seen = new Map<string, number>();
        COMMAND_PALETTE_COMMANDS.forEach(command => {
            seen.set(command.id, (seen.get(command.id) ?? 0) + 1);
        });

        expect([...seen.entries()].filter(([, count]) => count > 1)).toEqual([]);
    });

    it('keeps the registered command order stable', () => {
        expect(COMMAND_PALETTE_COMMANDS.map(command => command.id)).toMatchSnapshot();
    });

    it.each(Object.keys(LOCALES))('translates every static command in %s', localeName => {
        const locale = LOCALES[localeName as keyof typeof LOCALES];
        const missing = staticCommands
            .filter(command => {
                const text = readCommandText(locale, command.id);
                return !text?.title || !text?.description;
            })
            .map(command => command.id);

        expect(missing).toEqual([]);
    });

    it('keeps execute shortcuts unique and prefix-free', () => {
        const shortcuts = COMMAND_PALETTE_COMMANDS
            .map(command => command.executeShortcut)
            .filter((shortcut): shortcut is string => Boolean(shortcut));

        expect(new Set(shortcuts).size).toBe(shortcuts.length);
        expect(shortcuts.filter(shortcut => shortcuts.some(other => other !== shortcut && other.startsWith(shortcut))))
            .toEqual([]);
    });

    it('withholds execute shortcuts from irreversible commands', () => {
        // Anything here either cannot be undone, spends money or network, or wants a confirmation
        // step; a single keystroke must never be enough to trigger them.
        const guarded = [
            'playback-clear-queue',
            'desktop-toggle-wallpaper-mode',
            'settings-obs-copy-css',
            'sync-now',
            'desktop-toggle-lyric-api',
            'theme-generate-current',
        ];

        const leaked = COMMAND_PALETTE_COMMANDS
            .filter(command => guarded.includes(command.id) && command.executeShortcut)
            .map(command => command.id);

        expect(leaked).toEqual([]);
    });

    it('gives every static command an English, a CJK, and a pinyin-style keyword', () => {
        const hasCjk = (value: string) => /[一-鿿]/.test(value);
        const hasLatin = (value: string) => /^[a-z0-9][a-z0-9 .+-]*$/.test(value);

        const incomplete = staticCommands
            .filter(command => !command.keywords.some(hasCjk) || !command.keywords.some(hasLatin))
            .map(command => command.id);

        expect(incomplete).toEqual([]);
    });
});
