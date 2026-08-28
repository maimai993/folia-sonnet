import { Boxes } from 'lucide-react';
import type { CommandPaletteCommand } from '../types';
import { defineCommand } from '../commandFactories';
import { modsSurface } from '../surfaces/modsSurface';

// src/components/command-palette/commands/modsCommands.ts
// The mods command is a surface takeover (not a one-shot action): selecting it opens
// the full mod manager inside the palette body, where there is more room than the side
// panel tab.

export const modsCommands: CommandPaletteCommand[] = [
    defineCommand({
        id: 'mods',
        group: 'panel',
        title: 'Mods (Experimental)',
        description: 'Experimental: manage mods and export transparent lyric videos',
        keywords: ['mods', 'mod', 'mods manager', '模组', '模组管理', 'mokuai', 'mozu', 'mz', '导出透明视频'],
        icon: Boxes,
        requiresInput: true,
        surface: modsSurface,
        execute: () => false,
    }),
];