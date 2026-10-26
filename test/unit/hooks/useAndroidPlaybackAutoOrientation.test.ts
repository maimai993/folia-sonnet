// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { resolvePlaybackAutoOrientationOverride } from '../../../src/hooks/useAndroidPlaybackAutoOrientation';

// test/unit/hooks/useAndroidPlaybackAutoOrientation.test.ts
// 「进入可视化自动横屏」什么时候真的转屏。这几条一起决定，少一条都不动 —— 而它们在界面上
// 是几处不同的设置，拼错一条的表现是「开了没反应」，看界面很难说出是哪一条不对。
//
// ⚠️ 曾经还有一条「落盘方向必须是竖屏」，把「改过强制横屏的人」整个挡在外面：
// 打开开关毫无反应（用户报「没有用」）。强制横屏是全程横屏，自动横屏是只在播放页横屏，
// 两者不冲突，这条已经删掉。下面第三条钉的就是它不再挡人。

const base = {
    autoEnabled: true,
    storedOrientation: 'portrait' as const,
    playbackEntryView: 'player' as const,
    view: 'player' as const,
};

describe('playback auto-landscape override', () => {
    it('locks landscape on the player and lets go everywhere else', () => {
        expect(resolvePlaybackAutoOrientationOverride(base)).toBe('landscape');
        // 离开播放页是把覆盖撤掉（回到用户自己选的方向），不是强推竖屏 ——
        // 否则同时开了强制横屏的人退出播放页会被转回竖的。
        expect(resolvePlaybackAutoOrientationOverride({ ...base, view: 'home' })).toBeNull();
        expect(resolvePlaybackAutoOrientationOverride({ ...base, view: 'lattice' })).toBeNull();
    });

    it('does nothing while the switch is off', () => {
        expect(resolvePlaybackAutoOrientationOverride({ ...base, autoEnabled: false })).toBeNull();
    });

    // 强制横屏是全程横屏，自动横屏是只在播放页横屏：两者不冲突，选了强制横屏的人
    // 开这个开关也该生效（这正是原来「没有用」的原因）。
    it('still applies to someone who chose force landscape', () => {
        expect(resolvePlaybackAutoOrientationOverride({
            ...base,
            storedOrientation: 'landscape',
        })).toBe('landscape');
    });

    // 选了 Lattice 或「留在原处」的人点播放不会去播放页，跟着转屏只会把人转懵。
    it.each(['lattice', 'stay'] as const)('does nothing when playback opens in %s', playbackEntryView => {
        expect(resolvePlaybackAutoOrientationOverride({ ...base, playbackEntryView })).toBeNull();
    });
});
