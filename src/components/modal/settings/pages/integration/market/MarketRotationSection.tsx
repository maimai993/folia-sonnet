// src/components/modal/settings/pages/integration/market/MarketRotationSection.tsx
//
// 背景随机轮换的设置。
//
// 三组选择：
//   1. 用到哪 —— 可视化页面 / 桌面壁纸（多选，至少留一个）
//   2. 用什么 —— 只要视频 / 只要图片 / 两者都要
//   3. 多久换 —— 间隔
//
// 打开开关后立刻跑一轮，否则用户会盯着一个「已开启」却什么都没变的开关以为没生效。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../../../../../components/ui';
import { useTranslation } from 'react-i18next';
import {
    useMarketRotationStore,
    type RotationMediaKind,
    type RotationTarget,
} from '../../../../../../stores/useMarketRotationStore';
import { runRotationStep } from '../../../../../../services/backgroundMarket/rotation';

const TARGETS: Array<{ id: RotationTarget; labelKey: string }> = [
    { id: 'visualizer', labelKey: 'options.marketTargetBackground_app' },
    { id: 'wallpaper', labelKey: 'options.marketTargetBackground_wallpaper' },
];

const KINDS: Array<{ id: RotationMediaKind; labelKey: string }> = [
    { id: 'video', labelKey: 'options.marketRotationVideo' },
    { id: 'image', labelKey: 'options.marketRotationImage' },
    { id: 'both', labelKey: 'options.marketRotationBoth' },
];

const INTERVALS = [300, 600, 1800, 3600];

const MarketRotationSection: React.FC = () => {
    const { t } = useTranslation();
    const enabled = useMarketRotationStore((state) => state.enabled);
    const targets = useMarketRotationStore((state) => state.targets);
    const mediaKind = useMarketRotationStore((state) => state.mediaKind);
    const intervalSeconds = useMarketRotationStore((state) => state.intervalSeconds);
    const setEnabled = useMarketRotationStore((state) => state.setEnabled);
    const toggleTarget = useMarketRotationStore((state) => state.toggleTarget);
    const setMediaKind = useMarketRotationStore((state) => state.setMediaKind);
    const setIntervalSeconds = useMarketRotationStore((state) => state.setIntervalSeconds);

    const [busy, setBusy] = useState(false);
    const [lastResult, setLastResult] = useState<string | null>(null);
    const timerRef = useRef<number | null>(null);

    /** 跑一轮并给出结果反馈。 */
    const step = useCallback(async () => {
        setBusy(true);
        try {
            const result = await runRotationStep();
            if (result.ok && result.item) {
                setLastResult(t('options.marketRotationSwitched', { name: result.item.name }));
            } else if (result.error) {
                setLastResult(result.error);
            }
        } finally {
            setBusy(false);
        }
    }, [t]);

    /*
     * 定时器只在开启时挂着。
     *
     * 用 setInterval 而不是递归 setTimeout：卸载或关闭时清一个 id 就够了，
     * 递归写法容易在「关掉开关的瞬间正好在一次异步下载中」留下野定时器。
     */
    useEffect(() => {
        if (!enabled) {
            if (timerRef.current !== null) {
                window.clearInterval(timerRef.current);
                timerRef.current = null;
            }
            return;
        }
        void step();
        timerRef.current = window.setInterval(() => void step(), Math.max(60, intervalSeconds) * 1000);
        return () => {
            if (timerRef.current !== null) {
                window.clearInterval(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [enabled, intervalSeconds, step]);

    return (
        <div className="space-y-2.5 rounded-xl bg-[var(--glass-highlight)] px-3 py-2.5">
            <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-[var(--text-primary)]">
                    {t('options.marketRotation')}
                </span>
                <Button
                    onClick={() => setEnabled(!enabled)}
                    className={`rounded-full px-3 py-1 text-[12px] ${
                        enabled
                            ? 'bg-[var(--accent)] text-[var(--accent-contrast,white)]'
                            : 'bg-[var(--glass-bg)] text-[var(--text-secondary)]'
                    }`}
                >
                    {t(enabled ? 'options.marketRotationOn' : 'options.marketRotationOff')}
                </Button>
            </div>

            {enabled && (
                <>
                    {/* 用到哪 */}
                    <div>
                        <div className="mb-1 text-[11px] text-[var(--text-secondary)]">
                            {t('options.marketRotationTargets')}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {TARGETS.map((entry) => {
                                const active = targets.includes(entry.id);
                                return (
                                    <Button
                                        key={entry.id}
                                        onClick={() => toggleTarget(entry.id)}
                                        className={`rounded-full px-2.5 py-1 text-[11.5px] ${
                                            active
                                                ? 'bg-[var(--accent)] text-[var(--accent-contrast,white)]'
                                                : 'bg-[var(--glass-bg)] text-[var(--text-secondary)]'
                                        }`}
                                    >
                                        {t(entry.labelKey)}
                                    </Button>
                                );
                            })}
                        </div>
                    </div>

                    {/* 用什么 */}
                    <div>
                        <div className="mb-1 text-[11px] text-[var(--text-secondary)]">
                            {t('options.marketRotationKinds')}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {KINDS.map((entry) => {
                                const active = mediaKind === entry.id;
                                return (
                                    <Button
                                        key={entry.id}
                                        onClick={() => setMediaKind(entry.id)}
                                        className={`rounded-full px-2.5 py-1 text-[11.5px] ${
                                            active
                                                ? 'bg-[var(--accent)] text-[var(--accent-contrast,white)]'
                                                : 'bg-[var(--glass-bg)] text-[var(--text-secondary)]'
                                        }`}
                                    >
                                        {t(entry.labelKey)}
                                    </Button>
                                );
                            })}
                        </div>
                        {mediaKind !== 'image' && (
                            <div className="mt-1 text-[11px] text-[var(--text-secondary)]">
                                {t('options.marketRotationVideoHint')}
                            </div>
                        )}
                    </div>

                    {/* 多久换 */}
                    <div>
                        <div className="mb-1 text-[11px] text-[var(--text-secondary)]">
                            {t('options.marketRotationInterval')}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {INTERVALS.map((seconds) => {
                                const active = intervalSeconds === seconds;
                                return (
                                    <Button
                                        key={seconds}
                                        onClick={() => setIntervalSeconds(seconds)}
                                        className={`rounded-full px-2.5 py-1 text-[11.5px] ${
                                            active
                                                ? 'bg-[var(--accent)] text-[var(--accent-contrast,white)]'
                                                : 'bg-[var(--glass-bg)] text-[var(--text-secondary)]'
                                        }`}
                                    >
                                        {t('options.marketRotationMinutes', { count: Math.round(seconds / 60) })}
                                    </Button>
                                );
                            })}
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <Button
                            disabled={busy}
                            onClick={() => void step()}
                            className="rounded-lg bg-[var(--glass-bg)] px-2.5 py-1 text-[11.5px] disabled:opacity-50"
                        >
                            {busy ? t('options.marketApplying') : t('options.marketRotationSwitchNow')}
                        </Button>
                        {lastResult && (
                            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-secondary)]">
                                {lastResult}
                            </span>
                        )}
                    </div>
                </>
            )}
        </div>
    );
};

export default MarketRotationSection;
