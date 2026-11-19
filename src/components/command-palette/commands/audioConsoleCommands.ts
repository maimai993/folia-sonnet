import { defineCommand } from '../commandFactories';
import { useAudioConsoleStore } from '../../../stores/useAudioConsoleStore';
import { canUseNativeConsole } from '../../../services/playbackEngine/nativeConsoleAvailability';

// Each command uses the same setter and native route gate as the corresponding control.
type ConsoleStore = ReturnType<typeof useAudioConsoleStore.getState>;
const toggle = (id: string, title: string, change: (state: ConsoleStore) => void, requiresNormalization = false) => {
    const available = () => canUseNativeConsole() && (!requiresNormalization || useAudioConsoleStore.getState().settings.mastering.studio.normalize.enabled);
    return defineCommand({
        id: `audio-console-${id}`, group: 'playback', platform: ['capacitor-android'],
        title, description: 'Toggle this effect in the audio console.', keywords: ['dsp', '调音台'],
        isAvailable: available,
        execute: () => {
            if (!available()) return false;
            change(useAudioConsoleStore.getState());
            return true;
        },
    });
};

export const audioConsoleCommands = [
    toggle('compensation', 'Toggle Loss compensation', s => s.setCompensation({ enabled: !s.settings.mastering.compensation.enabled })),
    toggle('gate', 'Toggle Noise gate', s => s.setNoiseGate({ enabled: !s.settings.mastering.noiseGate.enabled })),
    toggle('deesser', 'Toggle De-esser', s => s.setDeEsser({ enabled: !s.settings.mastering.deEsser.enabled })),
    toggle('deplosive', 'Toggle De-plosive', s => s.setDePlosive({ enabled: !s.settings.mastering.dePlosive.enabled })),
    toggle('bass', 'Toggle Bass boost', s => s.setBassBoost({ enabled: !s.settings.mastering.bassBoost.enabled })),
    toggle('exciter', 'Toggle Harmonic exciter', s => s.setExciter({ enabled: !s.settings.mastering.exciter.enabled })),
    toggle('transient', 'Toggle Transient', s => s.setTransient({ enabled: !s.settings.mastering.transient.enabled })),
    toggle('loudness', 'Toggle Equal loudness', s => s.setLoudness({ enabled: !s.settings.mastering.loudness.enabled })),
    toggle('balance', 'Toggle Balance', s => s.setBalance({ enabled: !s.settings.mastering.balance.enabled })),
    toggle('normalize', 'Toggle RMS normalization', s => s.setNormalize({ enabled: !s.settings.mastering.studio.normalize.enabled })),
    toggle('headroom', 'Toggle Lower RMS target by 1 dB', s => s.setNormalize({ truePeak: !s.settings.mastering.studio.normalize.truePeak }), true),
    toggle('declick', 'Toggle De-click', s => s.setRestore({ declick: !s.settings.mastering.studio.restore.declick })),
    toggle('hum', 'Toggle De-hum (50/60Hz)', s => s.setRestore({ hum: !s.settings.mastering.studio.restore.hum })),
    toggle('denoise', 'Toggle Denoise', s => s.setRestore({ denoise: !s.settings.mastering.studio.restore.denoise })),
    toggle('dynamic-eq', 'Toggle Dynamic EQ', s => s.setAdvanced({ dynamicEq: !s.settings.mastering.studio.advanced.dynamicEq })),
    toggle('compare', 'Toggle A/B compare', s => s.setScene({ compare: !s.settings.mastering.studio.scene.compare })),
    toggle('stereo', 'Toggle Stereo width', s => s.setStereo({ enabled: !s.settings.stereo.enabled })),
];
