import React from 'react';
import { useTranslation } from 'react-i18next';
import { Group, Reveal, Row, Segmented, Toggle, type SettingsGroupDef } from '../../modal/settings/kit';
import { useChosenScene } from '../registry';
import { isAndroidAppShell } from '../../../platform/runtime';
import { useSoundTracingStore, type SoundTracingOutput } from './useSoundTracingStore';

// src/components/scenes/settings/SoundTracingGroup.tsx
// 场景窗口「声线追踪」标签里的一组（标签就是它的标题）：总开关，开着时下面是耳机/音箱。所有场景共用；
// 没选场景或选的场景不放音乐（清单 sound.music 不是 'speakers'）时开关不能点。
//
// 桌面与安卓用的是两条不同的实现，但**开关是同一个**：
//   · 桌面：Steam Audio 算真 IR（射线追踪 + 卷积）。
//   · 安卓：从场景几何估出 RT60 / 阻尼 / 预延迟 / 干湿比，交给原生 DSP 的 ReverbStage。
//     听感是「在那个厅里」，但丢掉了方位信息（听不出「左后方那面墙」）。
// 所以这里不再标 desktopOnly —— 之前那样标着，安卓用户看到的是一个点了没反应的开关，
// 而实际上手机上能听见，只是实现不一样。

const OUTPUTS: readonly SoundTracingOutput[] = ['headphones', 'speakers'];

const SOUND: SettingsGroupDef = { id: 'soundTracing', titleKey: 'ui.soundTracing' };

const SoundTracingGroup: React.FC = () => {
    const { t } = useTranslation();
    const supported = useChosenScene()?.manifest.sound?.music === 'speakers';
    const enabled = useSoundTracingStore(state => state.enabled);
    const output = useSoundTracingStore(state => state.output);
    const setEnabled = useSoundTracingStore(state => state.setEnabled);
    const setOutput = useSoundTracingStore(state => state.setOutput);
    const on = supported && enabled;
    // 两个平台都能用，但做法不同，说明文字跟着换。
    const hint = !supported
        ? t('ui.soundTracingUnsupported')
        : isAndroidAppShell()
            ? t('ui.soundTracingEstimated')
            : undefined;

    return (
        <Group def={SOUND} bare>
            <Row label={t('ui.soundTracing')} hint={hint} disabled={!supported}>
                <Toggle checked={on} onChange={setEnabled} disabled={!supported} />
            </Row>
            <Reveal when={on}>
                <Row sub label={t('ui.soundTracingOutput')}>
                    <Segmented value={output} options={OUTPUTS.map(value => ({ value, label: t(`ui.soundTracingOutput_${value}`) }))} onChange={setOutput} />
                </Row>
            </Reveal>
        </Group>
    );
};

export default SoundTracingGroup;
