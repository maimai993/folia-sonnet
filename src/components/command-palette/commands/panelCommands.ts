import { ListMusic } from 'lucide-react';
import type { CommandPaletteCommand } from '../types';
import { createPanelCommand } from '../commandFactories';

// src/components/command-palette/commands/panelCommands.ts
// Commands in the `panel` group: opening the unified side panel on a given tab.

export const panelCommands: CommandPaletteCommand[] = [
    createPanelCommand('cover', 'Panel: cover', 'Open the cover panel tab', ['panel cover', 'cover panel', '封面', 'fengmian', 'fm'], undefined, { executeShortcut: 'c' }),
    createPanelCommand('controls', 'Panel: controls', 'Open the controls panel tab', ['panel controls', 'controls panel', '控制', 'kongzhi', 'kz']),
    createPanelCommand('queue', 'Panel: queue', 'Open the queue panel tab', ['panel queue', 'queue panel', '队列', 'duilie', 'dl'], ListMusic),
    createPanelCommand('account', 'Panel: account', 'Open the account panel tab', ['panel account', 'account panel', '账号', '账户', 'zhanghao', 'zhanghu', 'zh']),
    createPanelCommand('local', 'Panel: local', 'Open the local panel tab', ['panel local', 'local panel', '本地面板', 'bendimianban', 'bdmb']),
    createPanelCommand('navi', 'Panel: Navidrome', 'Open the Navidrome panel tab', ['panel navi', 'panel navidrome', 'navi panel', 'navidrome 面板', '服务器面板', 'fuwuqimianban', 'fwqmb']),
    createPanelCommand('onlineLyrics', 'Panel: lyrics', 'Open the online lyrics panel tab', ['panel lyrics', 'lyrics panel', '歌词面板', 'gecimianban', 'gcmb']),
];
