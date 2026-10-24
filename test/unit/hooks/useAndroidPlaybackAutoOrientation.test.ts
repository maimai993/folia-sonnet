// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { resolvePlaybackAutoOrientationOverride } from '../../../src/hooks/useAndroidPlaybackAutoOrientation';

// test/unit/hooks/useAndroidPlaybackAutoOrientation.test.ts
// 「进入可视化自动横屏」什么时候真的转屏。三条一起决定，少一条都不动 —— 而这三条在界面上
// 是三处不同的设置（外观页的开关与「强制横屏」、播放页的「播放后进入的视图」），
// 拼错一条的表现是「开了没反应」，看界面很难说出是哪一条不对。

const base = {
    autoEnabled: true,
    storedOrientation: 'portrait' as const,
    playbackEntryView: 'player' as const,
    view: 'player' as const,
};

describe('playback auto-landscape override', () => {
    it('locks landscape on the player and portrait everywhere else', () => {
        expect(resolvePlaybackAutoOrientationOverride(base)).toBe('landscape');
        expect(resolvePlaybackAutoOrientationOverride({ ...base, view: 'home' })).toBe('portrait');
        expect(resolvePlaybackAutoOrientationOverride({ ...base, view: 'lattice' })).toBe('portrait');
    });

    it('does nothing while the switch is off', () => {
        expect(resolvePlaybackAutoOrientationOverride({ ...base, autoEnabled: false })).toBeNull();
    });

    it('does nothing for someone who already chose force landscape', () => {
        expect(resolvePlaybackAutoOrientationOverride({
            ...base,
            storedOrientation: 'landscape',
        })).toBeNull();
    });

    // 选了 Lattice 或「留在原处」的人点播放不会去播放页，跟着转屏只会把人转懵。
    it.each(['lattice', 'stay'] as const)('does nothing when playback opens in %s', playbackEntryView => {
        expect(resolvePlaybackAutoOrientationOverride({ ...base, playbackEntryView })).toBeNull();
    });
});
