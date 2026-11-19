import { describe, expect, it } from 'vitest';
import {
    AUDIO_CONSOLE_STORAGE_KEY,
    DEFAULT_AUDIO_CONSOLE_SETTINGS,
    normalizeAudioConsoleSettings,
} from '@/utils/audioConsole';

// 旧调音台 / 耳机方案升级仍用同一存储键；只发送可以处理的整曲 DSP 参数。
describe('调音台的可选 DSP 扩展', () => {
    it('只补上新字段，不改变旧方案的听感', () => {
        expect(AUDIO_CONSOLE_STORAGE_KEY).toBe('folia_audio_console');
        const old = { stereo: { enabled: true, width: 1.3, bassMonoHz: 100 } };
        const settings = normalizeAudioConsoleSettings(old);
        expect(settings.stereo).toEqual({ ...old.stereo, crossfeed: 0, rotation: 0 });
        expect(settings.mastering).toEqual(DEFAULT_AUDIO_CONSOLE_SETTINGS.mastering);
        expect(normalizeAudioConsoleSettings(null)).toEqual(DEFAULT_AUDIO_CONSOLE_SETTINGS);
    });

    it('夹住越界参数，忽略未接入的逐轨配置，可无损往返', () => {
        const settings = normalizeAudioConsoleSettings({
            stereo: { crossfeed: 4, rotation: -300 },
            spatial: { enabled: true, stems: { drums: { audible: false } } },
            mastering: { noiseGate: { thresholdDb: -150 }, studio: { normalize: { enabled: true, targetLufs: -4 } } },
        });
        expect(settings).not.toHaveProperty('spatial');
        expect(settings.stereo).toMatchObject({ crossfeed: 1, rotation: -180 });
        expect(settings.mastering.noiseGate.thresholdDb).toBe(-80);
        expect(settings.mastering.studio.normalize).toEqual({ enabled: true, targetLufs: -9, truePeak: true });
        expect(normalizeAudioConsoleSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
    });

    it('数值字段收到 null、空串或布尔值时回退默认值，不静默转成 0 或 1', () => {
        const settings = normalizeAudioConsoleSettings({
            stereo: { enabled: true, width: null, crossfeed: true, rotation: '' },
            reverb: { enabled: true, rt60: null, mix: false },
            mastering: {
                studio: {
                    normalize: { enabled: true, targetLufs: null, truePeak: true },
                },
            },
        });
        expect(settings.stereo.width).toBe(DEFAULT_AUDIO_CONSOLE_SETTINGS.stereo.width);
        expect(settings.stereo.crossfeed).toBe(DEFAULT_AUDIO_CONSOLE_SETTINGS.stereo.crossfeed);
        expect(settings.stereo.rotation).toBe(DEFAULT_AUDIO_CONSOLE_SETTINGS.stereo.rotation);
        expect(settings.reverb.rt60).toBe(DEFAULT_AUDIO_CONSOLE_SETTINGS.reverb.rt60);
        expect(settings.reverb.mix).toBe(DEFAULT_AUDIO_CONSOLE_SETTINGS.reverb.mix);
        expect(settings.mastering.studio.normalize.targetLufs).toBe(
            DEFAULT_AUDIO_CONSOLE_SETTINGS.mastering.studio.normalize.targetLufs,
        );
    });
});
