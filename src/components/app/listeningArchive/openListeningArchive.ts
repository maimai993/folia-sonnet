import { commandsRegistry, runFoliumCommand } from '../../../mods/folium/registries/commands';
import { closeSettings } from '../../../stores/useSettingsModalStore';
import { useListeningArchiveStore } from './listeningArchiveStore';

// src/components/app/listeningArchive/openListeningArchive.ts
// 设置页「听歌档案」那条入口的动作。
//
// 门后是随包模组「听歌档案」的整页（public/mods/builtin/listening-archive，界面以模组那套为准）：
// 模组自己登记了命令 `open`，它走 `folium.ui.openHomeTab`，会先回首页再选中那个页签——所以这里直接
// 跑那条命令，不另写一套导航（在播放页、墙面上点这条也能落到档案页）。命令不在（模组没起来）时
// 退回本仓库自己那套全屏页，点了总归有反应。
//
// 设置窗口要先关掉：档案页画在首页那一层，不关就一直被设置窗口盖着。

const OPEN_COMMAND = 'listening-archive:open';

/** 随包模组的档案页现在能不能打开（命令在就说明模组的客户端已经起来了）。 */
export const isListeningArchiveModPage = (): boolean => commandsRegistry.get(OPEN_COMMAND) !== null;

export const openListeningArchive = (): void => {
    closeSettings();
    const command = commandsRegistry.get(OPEN_COMMAND);
    if (command) {
        void runFoliumCommand(command, {});
        return;
    }
    useListeningArchiveStore.getState().open();
};
