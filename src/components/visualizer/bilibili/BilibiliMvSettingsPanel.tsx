import React from 'react';
import type { VisualizerSettingsPanelProps } from '../definition';
import BilibiliAuthCard from './BilibiliAuthCard';
import { Button } from '../../ui/Button';
import { Slider } from '../../ui/Slider';
import { useBilibiliAuthStore } from '../../../stores/useBilibiliAuthStore';
import { useBilibiliMvStore } from '../../../stores/useBilibiliMvStore';

/** 偏移的调节范围，秒。片头再长也长不过十几秒，±15 够用。 */
const OFFSET_RANGE_SEC = 15;

/** 秒 → 滑杆的 0..1。 */
const offsetToUnit = (seconds: number): number => (
    Math.min(1, Math.max(0, (seconds + OFFSET_RANGE_SEC) / (OFFSET_RANGE_SEC * 2)))
);

/** 滑杆的 0..1 → 秒。 */
const unitToOffset = (unit: number): number => unit * OFFSET_RANGE_SEC * 2 - OFFSET_RANGE_SEC;

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
                    {/*
                     * 用 ui/Slider 而不是浏览器原生滑杆控件：原生那种在安卓上长得
                     * 和主题完全挂不上钩，而且是「按下即跳」的 —— 面板要能上下滚，手指蹭到
                     * 滑杆就会把偏移改掉。ui/Slider 先判方向再决定跟不跟手（见它的文件头）。
                     *
                     * 它只认 0..1，所以这里把 -15s..+15s 换算过去。
                     */}
                    <Slider
                        value={offsetToUnit(offset)}
                        label={t('options.bilibiliMvOffset')}
                        valueText={`${offset >= 0 ? '+' : ''}${offset.toFixed(2)}s`}
                        disabled={!currentKey}
                        onPreview={unit => applyOffset(unitToOffset(unit))}
                        onCommit={() => {}}
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
                        <Button
                            variant="bare"
                            onClick={() => applyOffset(0)}
                            disabled={!currentKey}
                            className="rounded-md border border-[var(--border-subtle)] px-3 py-1.5 text-xs disabled:opacity-40"
                        >
                            {t('options.bilibiliMvOffsetReset')}
                        </Button>
                        <Button
                            variant="bare"
                            onClick={rematch}
                            disabled={!currentKey}
                            className="rounded-md border border-[var(--border-subtle)] px-3 py-1.5 text-xs disabled:opacity-40"
                        >
                            {t('options.bilibiliMvRematch')}
                        </Button>
                    </div>
                </div>
            ) : null}
        </>
    );
};

export default BilibiliMvSettingsPanel;
