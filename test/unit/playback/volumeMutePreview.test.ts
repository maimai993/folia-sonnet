import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// test/unit/playback/volumeMutePreview.test.ts
// Dragging the volume slider previews gain on the next animation frame, and that frame must not write
// the mute value captured by an older render back onto the audio element: a preview that arrives
// while the user is not muted plays, and a mute clicked after the preview was queued still wins.
//
// App.tsx is a thin shell that hands the wiring to appWiring/useAppAudioOutput, which owns
// handlePreviewVolume and syncOutputGain; a hook cannot be mounted in a unit test, so the wiring is
// read from the source the way hifiVolumePreview does.

const app = fs.readFileSync(
    path.resolve(__dirname, '../../../src/components/app/appWiring/useAppAudioOutput.ts'),
    'utf8',
);

const from = (needle: string): string => {
    const start = app.indexOf(needle);
    expect(start).toBeGreaterThan(-1);
    return start === -1 ? '' : app.slice(start, start + 2400);
};

const preview = from('const handlePreviewVolume = useCallback(');
const syncGain = from('const syncOutputGain = useCallback(');

describe('volume preview and mute', () => {
    it('previews on the next frame, coalescing drags into the latest value', () => {
        // 拖动的每一帧只记下最新值；已经排了帧就不再排，一次 requestAnimationFrame 消化掉。
        expect(preview).toMatch(/pendingVolumePreviewRef\.current = val;/);
        expect(preview).toMatch(/if \(volumePreviewFrameRef\.current !== null\) \{\s*return;\s*\}/);
        expect(preview).toMatch(/volumePreviewFrameRef\.current = requestAnimationFrame\(\(\) => \{/);
        expect(preview).toMatch(/const nextVolume = pendingVolumePreviewRef\.current;/);
    });

    it('writes gain only for a queued preview, not for a cleared one', () => {
        expect(preview).toMatch(/if \(nextVolume !== null\) \{/);
        // 静音在帧里读一次就够：下面网页增益与 HiFi 那条路用的是同一份 mutedNow，
        // 不会出现「网页静音了、mpv 还在按未静音播」。
        expect(preview).toMatch(/const mutedNow = useAudioSettingsStore\.getState\(\)\.isMuted;/);
        expect(preview).toMatch(/syncOutputGain\(mutedNow \? 0 : nextVolume, 0\.015\);/);
    });

    it('writes the muted flag it was called with, not one captured by an older render', () => {
        // syncOutputGain 里写 muted 的是当前这一份 isMuted（在 gain 节点那条路上写死 false，
        // 因为节点自己带着音量）；预览帧不另外把这值偷偷改回去。
        expect(syncGain).toMatch(/audioRef\.current\.volume = clampedVolume;/);
        expect(syncGain).toMatch(/audioRef\.current\.muted = useAudioSettingsStore\.getState\(\)\.isMuted;/);
        expect(preview).not.toMatch(/audioRef\.current\.muted\s*=/);
    });

    it('keeps the muted render out of the preview callback dependencies', () => {
        // 静音状态在帧里现读 store，不进依赖：否则下一帧写的还是旧的那一份。
        expect(preview).toMatch(/\}, \[syncOutputGain\]\);/);
        expect(preview).toMatch(/useAudioSettingsStore\.getState\(\)\.isMuted/);
    });

    it('unmutes from the user action, not from the preview frame', () => {
        // 拖动只预览音量；解除静音写在用户操作那一刻，不拖到下一帧。
        expect(preview).toMatch(/if \(val > 0\) useAudioSettingsStore\.getState\(\)\.handleSetMuted\(false\);/);
    });
});
