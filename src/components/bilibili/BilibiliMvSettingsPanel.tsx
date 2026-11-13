import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';
import { Row, Status, Toggle } from '../modal/settings/kit';
import { useBilibiliAuthStore } from '../../stores/useBilibiliAuthStore';
import { useBilibiliMvStore } from '../../stores/useBilibiliMvStore';
import { isAiTargetConfigured } from '../../services/aiCompletion';
import { O } from '../modal/settings/pages/integration/options';

// src/components/bilibili/BilibiliMvSettingsPanel.tsx
// 「连接与集成 → B 站」这块的内容：MV 背景开关 + 登录卡片 + 重新匹配。
//
// 这里**不是歌词样式**：B 站 MV 现在是播放页的一个背景开关，所以它在这里出现，
// 不再跟「流光 / 心象」那些样式列在一起。开关落盘，重启后保持。
//
// 不再有音画偏移：MV 是投稿方自己的剪辑，片头长度各不相同，按歌手调之后
// 每首歌都得重调一次，实际体验比「直接跟歌曲时钟」更差，已经去掉。

const BilibiliMvSettingsPanel: React.FC = () => {
    const { t } = useTranslation();
    const available = useBilibiliAuthStore(state => state.available);
    const signedIn = useBilibiliAuthStore(state => state.signedIn);
    const uid = useBilibiliAuthStore(state => state.uid);
    const hydrateAuth = useBilibiliAuthStore(state => state.hydrate);
    const enabled = useBilibiliMvStore(state => state.enabled);
    const setEnabled = useBilibiliMvStore(state => state.setEnabled);
    const hideLyrics = useBilibiliMvStore(state => state.hideLyrics);
    const setHideLyrics = useBilibiliMvStore(state => state.setHideLyrics);
    const useAiMatch = useBilibiliMvStore(state => state.useAiMatch);
    const setUseAiMatch = useBilibiliMvStore(state => state.setUseAiMatch);
    // 每次渲染读一次：AI 配置在别处改，这页不订阅那份设置。
    const aiReady = isAiTargetConfigured();
    const bySongKey = useBilibiliMvStore(state => state.bySongKey);

    React.useEffect(() => {
        void hydrateAuth();
    }, [hydrateAuth]);

    // 最后解析的那一条就是正在放的那首（播放页开着 MV 时解析过）。
    const currentKey = React.useMemo(() => {
        const keys = Object.keys(bySongKey);
        if (keys.length === 0) return '';
        return keys.reduce((best, key) => (
            (bySongKey[key]?.resolvedAt ?? 0) > (bySongKey[best]?.resolvedAt ?? 0) ? key : best
        ), keys[0]);
    }, [bySongKey]);
    const resolution = currentKey ? bySongKey[currentKey] : undefined;

    const rematch = () => {
        if (!currentKey) return;
        const [title, artist] = currentKey.split('|||');
        void useBilibiliMvStore.getState().resolveForSong(currentKey, title, artist, 0, true);
    };

    return (
        <>
            <Row option={O.bilibiliMv} hint={t('options.bilibiliMvDesc')}>
                <Toggle checked={enabled} onChange={setEnabled} />
            </Row>
            {enabled && (
                <Row option={O.bilibiliMvHideLyrics} hint={t('options.bilibiliMvHideLyricsDesc')}>
                    <Toggle checked={hideLyrics} onChange={setHideLyrics} />
                </Row>
            )}
            {enabled && (
                <Row
                    option={O.bilibiliMvUseAi}
                    // 没配 AI 时说清楚会用打分规则，别让用户以为开关坏了。
                    hint={aiReady
                        ? t('options.bilibiliMvUseAiDesc')
                        : t('options.bilibiliMvUseAiFallback')}
                >
                    <Toggle checked={useAiMatch} onChange={setUseAiMatch} disabled={!aiReady} />
                </Row>
            )}
            {enabled && (
                <Row sub label={t('options.bilibiliMvStatus')}>
                    {resolution?.state === 'ready' && resolution.stream ? (
                        <Status tone="ok">{`BV ${resolution.stream.bvid} · ${resolution.stream.quality}p`}</Status>
                    ) : (
                        <Status>{t('options.bilibiliMvNoMatch')}</Status>
                    )}
                    <Button
                        variant="bare"
                        onClick={rematch}
                        disabled={!currentKey}
                        className="rounded-md border border-[var(--border-subtle)] px-3 py-1.5 text-xs disabled:opacity-40"
                    >
                        {t('options.bilibiliMvRematch')}
                    </Button>
                </Row>
            )}
            {/*
              * 登录不在这里 —— 它在通用登录面板里（首页「登录到 xxx」那颗入口，
              * 平台列末尾单独一条）。这里只说一句状态，点一下过去。
              */}
            <Row
                option={O.bilibiliLogin}
                hint={signedIn ? t('options.bilibiliLoginHintSignedIn') : t('options.bilibiliLoginHint')}
            >
                <Status tone={signedIn ? 'ok' : undefined}>
                    {signedIn
                        ? (uid ? t('options.bilibiliSignedInAs').replace('{uid}', uid) : t('options.bilibiliSignedIn'))
                        : t('options.bilibiliSignedOut')}
                </Status>
            </Row>
            {!available && (
                <Row sub label={<Status>{t('options.bilibiliUnsupported')}</Status>} />
            )}
        </>
    );
};

export default BilibiliMvSettingsPanel;
