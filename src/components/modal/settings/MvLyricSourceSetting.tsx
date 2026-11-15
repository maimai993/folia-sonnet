import React from 'react';
import { useTranslation } from 'react-i18next';
import { Row, Segmented } from './kit';
import { useLyricSettingsStore, type MvLyricSource } from '../../../stores/useLyricSettingsStore';
import { O } from './pages/appearance/options';

// src/components/modal/settings/MvLyricSourceSetting.tsx
// 给别的平台的歌配 MV 时，歌词用哪一边的。
//
// 默认「原平台歌词」：MV 只是配一个画面，歌词该是听众认得的那份。选「这一站的字幕」
// 时，才把那条投稿自己的字幕换上来 —— 好处是字幕和画面同源、卡点准，代价是那份字幕
// 常常只是「纯音乐欣赏」之类的占位，或者压根没有（没有的时候仍然用原平台歌词）。
//
// 用 `Segmented` 而不是 `Chips`：这是二选一，不是勾选。歌词页其余几项也是这么画的。

const MvLyricSourceSetting: React.FC = () => {
    const { t } = useTranslation();
    const source = useLyricSettingsStore(state => state.mvLyricSource);
    const setSource = useLyricSettingsStore(state => state.handleSetMvLyricSource);

    return (
        <Row option={O.mvLyricSource} note={t('options.mvLyricSourceDesc')}>
            <Segmented<MvLyricSource>
                value={source}
                options={[
                    { value: 'platform', label: t('options.mvLyricSourcePlatform') },
                    { value: 'video', label: t('options.mvLyricSourceVideo') },
                ]}
                onChange={setSource}
            />
        </Row>
    );
};

export default MvLyricSourceSetting;
