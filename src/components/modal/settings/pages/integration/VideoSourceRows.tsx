// src/components/modal/settings/pages/integration/VideoSourceRows.tsx
// 影视组的行：一份配置地址（TVBox 格式，例如饭太硬），保存后影视入口、首页推荐与搜索都从这份
// 配置取片源。地址只存在本机，不进外观配置的导入导出。

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Row, Status, TextField } from '../../kit';
import { useVideoSettingsStore } from '../../../../../stores/useVideoSettingsStore';
import { O } from './options';

export const VideoSourceRows: React.FC = () => {
    const { t } = useTranslation();
    const url = useVideoSettingsStore(state => state.videoSourceUrl);
    const setUrl = useVideoSettingsStore(state => state.setVideoSourceUrl);
    const clearUrl = useVideoSettingsStore(state => state.clearVideoSourceUrl);

    return (
        <>
            <Row option={O.videoSource} hint={t('options.videoSourceUrlDesc')}>
                <TextField
                    type="url"
                    value={url}
                    onChange={setUrl}
                    placeholder={t('options.videoSourceUrlPlaceholder')}
                />
            </Row>
            <Row
                sub
                label={url
                    ? <Status tone="ok">{t('options.videoSourceInUse')}</Status>
                    : <Status>{t('options.videoSourceNotConfigured')}</Status>}
                hint={url || t('options.videoSourceEmptyHint')}
            >
                {url && <Button onClick={clearUrl}>{t('options.videoSourceClear')}</Button>}
            </Row>
        </>
    );
};

export default VideoSourceRows;
