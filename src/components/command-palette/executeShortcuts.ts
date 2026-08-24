import type { CommandPaletteCommand } from './types';

// src/components/command-palette/executeShortcuts.ts
// Resolution for execute mode's vim-style keys. Shortcuts must be prefix-free so "typed enough
// to be unambiguous" is decidable without a disambiguation timer.

export type ExecuteShortcutIndex = Map<string, CommandPaletteCommand>;

export type ExecuteShortcutResolution =
    | { status: 'exact'; command: CommandPaletteCommand }
    | { status: 'prefix'; candidates: CommandPaletteCommand[] }
    | { status: 'none' };

export const normalizeExecuteShortcut = (value: string) => value.trim().toLowerCase();

/**
 * Validates the whole registry, not just the currently available commands: a key must mean the
 * same thing on every platform, or muscle memory becomes environment-dependent.
 */
export const assertExecuteShortcutsArePrefixFree = (commands: CommandPaletteCommand[]) => {
    const owners = new Map<string, string>();

    commands.forEach(command => {
        if (!command.executeShortcut) {
            return;
        }

        const shortcut = normalizeExecuteShortcut(command.executeShortcut);
        if (!shortcut) {
            throw new Error(`[CommandPalette] Command "${command.id}" declares an empty executeShortcut`);
        }

        const existing = owners.get(shortcut);
        if (existing) {
            throw new Error(`[CommandPalette] Commands "${existing}" and "${command.id}" both use execute shortcut "${shortcut}"`);
        }
        owners.set(shortcut, command.id);
    });

    owners.forEach((ownerId, shortcut) => {
        owners.forEach((otherId, other) => {
            if (other !== shortcut && other.startsWith(shortcut)) {
                throw new Error(`[CommandPalette] Execute shortcut "${shortcut}" (${ownerId}) is a prefix of "${other}" (${otherId})`);
            }
        });
    });

    return commands;
};

export const buildExecuteShortcutIndex = (commands: CommandPaletteCommand[]): ExecuteShortcutIndex => {
    const index: ExecuteShortcutIndex = new Map();
    commands.forEach(command => {
        if (command.executeShortcut) {
            index.set(normalizeExecuteShortcut(command.executeShortcut), command);
        }
    });
    return index;
};

export const resolveExecuteShortcut = (
    index: ExecuteShortcutIndex,
    buffer: string,
): ExecuteShortcutResolution => {
    const normalized = normalizeExecuteShortcut(buffer);
    if (!normalized) {
        return { status: 'prefix', candidates: [...index.values()] };
    }

    const exact = index.get(normalized);
    if (exact) {
        return { status: 'exact', command: exact };
    }

    const candidates = [...index.entries()]
        .filter(([shortcut]) => shortcut.startsWith(normalized))
        .map(([, command]) => command);

    return candidates.length > 0 ? { status: 'prefix', candidates } : { status: 'none' };
};
