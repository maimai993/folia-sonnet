import React from 'react';
import type { VisualizerSettingsPanelProps } from '../definition';
import BilibiliAuthCard from './BilibiliAuthCard';
import { useBilibiliAuthStore } from '../../../stores/useBilibiliAuthStore';
import { useBilibiliMvStore } from '../../../stores/useBilibiliMvStore';

// src/components/visualizer/bilibili/BilibiliMvSettingsPanel.tsx
// 「B 站 MV」的设置面板：登录卡片 + 音画偏移 + 重新匹配。
//
// 偏移为什么要给用户调：MV 的片头长度各不相同，有的投稿前面挂十几秒黑屏或台标，
// 直接按「歌曲第 0 秒 = 视频第 0 秒」放会一直差那么多。自动对齐只能做到差不多，
// 真正准不准得看着画面拖。
//
// 偏移是**按歌存**的，所以这里得知道「现在放的是哪首」。设置面板的 props 里没有歌名，
// 于是从 MV store 里取「最近一次解析出来的那首」—— 播放页在放什么，它就是什么。

interface BilibiliMvSettingsPanelProps extends VisualizerSettingsPanelProps {
    /** 当前播放的歌名（面板打开时那一首）。 */
    songTitle?: string;
}

const BilibiliMvSettingsPanel: React.FC<BilibiliMvSettingsPanelProps> = ({ t }) => {
    const available = useBilibiliAuthStore(state => state.available);
    const hydrateAuth = useBilibiliAuthStore(state => state.hydrate);

    React.useEffect(() => {
        void hydrateAuth();
    }, [hydrateAuth]);

    // 最近解析的那首就是正在放的那首（背景在播时解析过）。
    const bySongKey = useBilibiliMvStore(state => state.bySongKey);
    const offsets = useBilibiliMvStore(state => state.offsets);
    const setOffset = useBilibiliMvStore(state => state.setOffset);

    const currentKey = React.useMemo(() => {
        const keys = Object.keys(bySongKey);
        if (keys.length === 0) return '';
        // resolvedAt 最大的那条是最后解析的。
        return keys.reduce((best, key) => (
            (bySongKey[key]?.resolvedAt ?? 0) > (bySongKey[best]?.resolvedAt ?? 0) ? key : best
        ), keys[0]);
    }, [bySongKey]);

    const offset = currentKey ? (offsets[currentKey] ?? 0) : 0;
    const resolution = currentKey ? bySongKey[currentKey] : undefined;

    const applyOffset = (next: number) => {
        if (!currentKey) return;
        setOffset(currentKey, Math.round(next * 100) / 100);
    };

    const rematch = () => {
        if (!currentKey) return;
        const [title, artist] = currentKey.split('|||');
        void useBilibiliMvStore.getState().resolveForSong(currentKey, title, artist, 0, true);
    };

    return (
        <>
            <BilibiliAuthCard t={t} />
            {available ? (
                <div className="flex flex-col gap-2 px-1 py-2">
                    <div className="flex items-center justify-between gap-3 text-sm">
                        <span>{t('options.bilibiliMvOffset')}</span>
                        <span className="font-mono text-xs text-[var(--text-secondary)]">
                            {offset >= 0 ? '+' : ''}{offset.toFixed(2)}s
                        </span>
                    </div>
                    <input
                        type="range"
                        min={-15}
                        max={15}
                        step={0.05}
                        value={offset}
                        disabled={!currentKey}
                        onChange={event => applyOffset(Number(event.target.value))}
                        className="w-full"
                    />
                    <p className="text-xs text-[var(--text-secondary)]">
                        {t('options.bilibiliMvOffsetHint')}
                    </p>
                    {resolution ? (
                        <p className="truncate text-xs text-[var(--text-secondary)]">
                            {resolution.state === 'ready' && resolution.stream
                                ? `BV ${resolution.stream.bvid} · ${resolution.stream.quality}p`
                                : t('options.bilibiliMvNoMatch')}
                        </p>
                    ) : null}
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => applyOffset(0)}
                            disabled={!currentKey}
                            className="rounded-md border border-[var(--border-subtle)] px-3 py-1.5 text-xs disabled:opacity-40"
                        >
                            {t('options.bilibiliMvOffsetReset')}
                        </button>
                        <button
                            type="button"
                            onClick={rematch}
                            disabled={!currentKey}
                            className="rounded-md border border-[var(--border-subtle)] px-3 py-1.5 text-xs disabled:opacity-40"
                        >
                            {t('options.bilibiliMvRematch')}
                        </button>
                    </div>
                </div>
            ) : null}
        </>
    );
};

export default BilibiliMvSettingsPanel;
