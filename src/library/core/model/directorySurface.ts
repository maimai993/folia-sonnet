import type {
    LibraryDirectoryBatchCapabilities,
    LibraryDirectoryBatchContext,
    LibraryDirectorySurfaceActionId,
} from '../contracts/directory';
import { canRunDirectoryBatchAction } from './directoryBatch';

// src/library/core/model/directorySurface.ts
// 目录的命令面板 surface 此刻提供哪些动作。批量动作与面板按钮同源（resolveDirectoryBatchCapabilities）：
// 面板按钮不可点的时候，命令也不出现。「管理隐藏」只在没有批量的目录里有（两者在 GridMap 侧面板里互斥）。

const SCOPE_COMMANDS: Array<[LibraryDirectorySurfaceActionId, 'play' | 'enqueue' | 'create-playlist' | 'remove']> = [
    ['play-selection', 'play'],
    ['enqueue-selection', 'enqueue'],
    ['create-playlist', 'create-playlist'],
    ['remove-selection', 'remove'],
];

/** 目录 surface 的可用动作（固定顺序）。 */
export const resolveDirectorySurfaceActions = ({
    capabilities,
    context,
    displayItemCount,
    selectedItemCount,
    hasHideableItems,
}: {
    /** 批量能力；目录没有批量（在线、Navidrome、本地歌单）时为 null。 */
    capabilities: LibraryDirectoryBatchCapabilities | null;
    /** 当前批量范围（筛选后选中的条目与歌）。 */
    context: Pick<LibraryDirectoryBatchContext, 'items'>;
    /** 筛选之后显示的条目数。 */
    displayItemCount: number;
    /** 会话里选中的条目数（含被筛掉的）。 */
    selectedItemCount: number;
    hasHideableItems: boolean;
}): LibraryDirectorySurfaceActionId[] => {
    if (!capabilities) return hasHideableItems ? ['manage-hidden'] : [];
    const actions: LibraryDirectorySurfaceActionId[] = SCOPE_COMMANDS
        .filter(([, batchAction]) => canRunDirectoryBatchAction(capabilities, batchAction))
        .map(([command]) => command);
    if (displayItemCount > 0 && context.items.length < displayItemCount) actions.push('select-all');
    if (selectedItemCount > 0) actions.push('clear-selection');
    return actions;
};
