import { PlayerState } from '../../../../types';

// src/components/app/playback/bridges/nativeTogglePause.ts
// 原生播放（P1）时「播放 / 暂停」该往哪边走。
//
// 不能只看 React 的 `playerState`：切歌后它有一小段还是 IDLE（或者在追上一首的状态），
// 而原生那边已经接受播放意图、开始出声了。那一小段里按暂停会被当成「开始播放」——
// 表现就是切歌后的前几秒双击暂停没反应。任一说在播，这一下就是暂停。

export const shouldPauseNativePlayback = (playerState: PlayerState, nativePlaying: boolean): boolean => (
    playerState === PlayerState.PLAYING || nativePlaying
);
