import { describe, expect, it } from 'vitest';
import { shouldPauseNativePlayback } from '../../../src/components/app/playback/bridges/nativeTogglePause';
import { PlayerState } from '../../../src/types';

// test/unit/playback/nativeTogglePause.test.ts
// 原生播放时切歌后的那段状态空窗：React 的 playerState 还是 IDLE，
// 但原生已经记下播放意图并出声。这时按暂停必须走暂停，不能再「开始播放」。

describe('shouldPauseNativePlayback', () => {
    it('状态机说在播：暂停', () => {
        expect(shouldPauseNativePlayback(PlayerState.PLAYING, false)).toBe(true);
    });

    it('状态机还没追上、原生说在播：仍然暂停', () => {
        expect(shouldPauseNativePlayback(PlayerState.IDLE, true)).toBe(true);
    });

    it('状态机说暂停、原生也停了：开始播放', () => {
        expect(shouldPauseNativePlayback(PlayerState.PAUSED, false)).toBe(false);
    });

    it('状态机空闲、原生也停了：开始播放', () => {
        expect(shouldPauseNativePlayback(PlayerState.IDLE, false)).toBe(false);
    });
});
