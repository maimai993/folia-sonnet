import { BarChart3 } from 'lucide-react';
import { createToggleCommand } from '../commandFactories';
import { useListeningArchiveStore } from '../../app/listeningArchive/listeningArchiveStore';
import type { CommandPaletteCommand } from '../types';

// src/components/command-palette/commands/archiveCommands.ts
// 听歌档案的入口：一条「打开听歌档案」。档案是个全屏数据页，从任何页面都能看，
// 所以没有 surface / scope 门控，也不占 executeShortcut（一次按键就接管整屏太重了）。

export const OPEN_LISTENING_ARCHIVE_COMMAND_ID = 'open-listening-archive';

export const archiveCommands: CommandPaletteCommand[] = [
    createToggleCommand(
        OPEN_LISTENING_ARCHIVE_COMMAND_ID,
        'navigation',
        'Open the listening archive',
        'See how long you have listened, what you played most, and when you listen',
        [
            'listening archive',
            'archive',
            'listening history',
            'play history',
            'stats',
            'statistics',
            '听歌档案',
            '听歌统计',
            '听歌记录',
            '档案',
        ],
        () => useListeningArchiveStore.getState().open(),
        { icon: BarChart3 },
    ),
];
