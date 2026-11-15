import { Repeat, Repeat1, RepeatOff, Shuffle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { StageLoopMode } from '../../types';
// src/components/shared/loopModeDisplay.ts
// How the repeat button shows each repeat mode: its icon and the name of its label. Used by the
// side panel's song actions, the player bar's slot and the remote window.

export const loopModeIcon = (loopMode: StageLoopMode): LucideIcon => {
    if (loopMode === 'off') return RepeatOff;
    if (loopMode === 'one') return Repeat1;
    // 随机播放：图标是交叉箭头，和三种循环各自区得开。
    if (loopMode === 'shuffle') return Shuffle;
    return Repeat;
};

/** The last part of the label's i18n key: the main window's labels are `player.<name>`, the remote window's `remote.<name>`. */
export const loopModeLabelName = (loopMode: StageLoopMode): 'loopOff' | 'loopOne' | 'loopAll' | 'loopShuffle' => {
    if (loopMode === 'off') return 'loopOff';
    if (loopMode === 'one') return 'loopOne';
    if (loopMode === 'shuffle') return 'loopShuffle';
    return 'loopAll';
};
