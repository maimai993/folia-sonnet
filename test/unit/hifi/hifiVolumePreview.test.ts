import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// test/unit/hifi/hifiVolumePreview.test.ts
// The volume a slider previews while it is dragged reaches mpv on the HiFi route with software volume
// on: the app's handlePreviewVolume hands it to hifiEngine.configure through selectHifiEngineConfig
// (the engine skips a config it already has). Without it the drag was silent on HiFi, and only the
// release changed the level.
//
// 读的是接线层而不是 App.tsx：App 没法在单测里挂载，而 `handlePreviewVolume` 住在
// appWiring/useAppAudioOutput.ts —— App.tsx 是薄壳，音量预览属于音频输出那一步的接线。

const wiring = fs.readFileSync(
    path.resolve(__dirname, '../../../src/components/app/appWiring/useAppAudioOutput.ts'),
    'utf8',
);
const start = wiring.indexOf('const handlePreviewVolume = useCallback(');
// 切片到这段 useCallback 的依赖数组为止：后面紧跟的是下一个控制器，不能把它的代码也算进来。
const preview = wiring.slice(start, wiring.indexOf('\n    }, [', start) + 40);

describe('handlePreviewVolume on the HiFi route', () => {
    it('is found', () => {
        expect(start).toBeGreaterThan(-1);
    });

    it('configures mpv with the previewed volume and the mute, only with software volume on the HiFi route', () => {
        expect(preview).toMatch(/const hifiSettings = useHifiSettingsStore\.getState\(\);/);
        expect(preview).toMatch(/if \(isHifiRoute\(\) && hifiSettings\.softwareVolume\) \{/);
        expect(preview).toMatch(/hifiEngine\.configure\(selectHifiEngineConfig\(hifiSettings, nextVolume, mutedNow\)\)/);
        // The Web engine's gain still follows the drag. 本 fork 在这一帧里重读静音状态：
        // 用户若在上一帧之后点了静音，新的静音意图优先，不能把预览又放出声。
        expect(preview).toMatch(/const mutedNow = useAudioSettingsStore\.getState\(\)\.isMuted;/);
        expect(preview).toMatch(/syncOutputGain\(mutedNow \? 0 : nextVolume, 0\.015\);/);
    });

    it('reads the mute inside the frame, so it stays out of the dependencies', () => {
        expect(preview).toMatch(/\}, \[syncOutputGain\]\);/);
    });

    it('imports what it calls', () => {
        expect(wiring).toMatch(/import \{ hifiEngine \} from '\.\.\/\.\.\/\.\.\/services\/hifi\/hifiEngine';/);
        expect(wiring).toMatch(
            /import \{ selectHifiEngineConfig, useHifiSettingsStore \} from '\.\.\/\.\.\/\.\.\/stores\/useHifiSettingsStore';/,
        );
        expect(wiring).toMatch(/import \{ isHifiRoute \} from '\.\.\/\.\.\/\.\.\/services\/hifi\/hifiPlayback';/);
    });
});
