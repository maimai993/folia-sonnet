import React, { useEffect, useState } from 'react';
import '../../src/i18n/config';
import i18n from '../../src/i18n/config';
import AudioEqualizerDialog from '../../src/components/panelTab/AudioEqualizerDialog';
import { useAudioSettingsStore } from '../../src/stores/useAudioSettingsStore';
import { useAudioProfilesStore } from '../../src/stores/useAudioProfilesStore';
import type { ProbeDefinition } from './definition';
// dev/probes/audioConsole.probe.tsx

/**
 * 调音台窗口在窄窗（手机竖屏）下的排版。
 *
 * 存在的理由：这扇窗口的头部是 sticky 的（方案条 + 五个页签），而它贴在 Sheet 的
 * 内容区里、靠负 margin 抵掉内边距 —— 这种写法在宽窗上看着没问题，在 360~430px
 * 宽、且把标题副行压到两行时最容易出现「方案条盖住副标题」。
 *
 * 探针把窗口直接打开（isOpen 由 store 置位），并预先造三套方案：
 * 一枚短名、一枚长名、一枚中等，用来看芯片在滚动条两端的裁切与按钮的挤压。
 */
const Harness: React.FC = () => {
    const openAudioEqualizer = useAudioSettingsStore(state => state.openAudioEqualizer);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        void i18n.changeLanguage('zh-CN');
        const profiles = useAudioProfilesStore.getState();
        profiles.renameActive('琉璃max');
        profiles.duplicateActive();
        profiles.renameActive('方案 2');
        profiles.duplicateActive();
        openAudioEqualizer();
        setReady(true);
    }, [openAudioEqualizer]);

    if (!ready) return null;
    return <AudioEqualizerDialog isDaylight={false} />;
};

const probe: ProbeDefinition = {
    id: 'audio-console',
    title: '音频调音台（窄窗）',
    description: '调音台窗口在手机竖屏下的头部与分页，用来核对方案条是否压住副标题。',
    Component: Harness,
};

export default probe;
