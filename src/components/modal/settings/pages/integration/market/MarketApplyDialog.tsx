// src/components/modal/settings/pages/integration/market/MarketApplyDialog.tsx
//
// 「要应用在哪里？」—— 点市场里的条目之后弹这个。
//
// 为什么必须先问：
//   同一个字体能用在歌词、字幕、锁屏壁纸；同一个背景能进桌面壁纸，也能进 App 内的歌词背景。
//   不问就猜一个，用户多半要再翻设置改一次。
//
// 选完之后原地变成下载进度 —— 不再单独开一个进度条，
// 因为用户刚点完按钮，视线就在这儿。

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import ThemedDialog from '../../../../../shared/ThemedDialog';
import { Button } from '../../../../../../components/ui';

export interface ApplyTargetChoice<T extends string> {
    id: T;
    label: string;
    /** 说明这一项到底改哪儿。 */
    hint?: string;
    disabled?: boolean;
    disabledHint?: string;
}

interface MarketApplyDialogProps<T extends string> {
    isOpen: boolean;
    isDaylight: boolean;
    title: string;
    /** 被点的那个条目的名字，让用户确认没点错。 */
    itemName: string;
    choices: ReadonlyArray<ApplyTargetChoice<T>>;
    defaults: ReadonlyArray<T>;
    /** 进度 0..1；null 表示还没开始。 */
    progress: number | null;
    /** 下载中的说明文字。 */
    progressLabel: string;
    error: string | null;
    onCancel: () => void;
    onConfirm: (targets: T[]) => void;
}

const MarketApplyDialog = <T extends string>({
    isOpen,
    isDaylight,
    title,
    itemName,
    choices,
    defaults,
    progress,
    progressLabel,
    error,
    onCancel,
    onConfirm,
}: MarketApplyDialogProps<T>) => {
    const { t } = useTranslation();
    const [picked, setPicked] = useState<T[]>([]);
    const running = progress !== null;

    /**
     * 只在**打开的那一刻**重置一次。
     *
     * 以前依赖里有 `defaults`（父组件每次渲染都给新数组），于是每次重渲染都重置，
     * 用户刚勾上的目标会自己掉回去。
     */
    const wasOpen = useRef(false);
    useEffect(() => {
        if (isOpen && !wasOpen.current) {
            setPicked([...defaults]);
        }
        wasOpen.current = isOpen;
        // defaults 只用于首次填充，不该作为重置触发条件。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    const toggle = (id: T) => {
        if (running) return;
        setPicked((current) => (
            current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
        ));
    };

    const canConfirm = picked.length > 0 && !running;
    const percent = progress === null ? 0 : Math.round(progress * 100);

    return (
        <ThemedDialog
            isOpen={isOpen}
            isDaylight={isDaylight}
            title={title}
            onClose={onCancel}
            closeDisabled={running}
            closeDisabledTitle={progressLabel}
        >
            <div className="space-y-3">
                <div className="truncate text-[13px] text-[var(--st-t2)]">{itemName}</div>

                <div className="text-[13px] font-medium text-[var(--st-t1)]">
                    {t('options.marketApplyWhere')}
                </div>

                <div className="space-y-1.5">
                    {choices.map((choice) => {
                        const active = picked.includes(choice.id);
                        const unavailable = Boolean(choice.disabled);
                        return (
                            <Button
                                key={choice.id}
                                onClick={() => !unavailable && toggle(choice.id)}
                                aria-pressed={active}
                                aria-disabled={unavailable || running}
                                className={[
                                    'flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors',
                                    unavailable
                                        ? 'cursor-not-allowed border-transparent bg-[var(--st-fill)] opacity-45'
                                        : active
                                            ? 'border-[var(--st-accent)] bg-[var(--st-accent)]/15'
                                            : 'border-[var(--st-line,rgba(255,255,255,0.12))] bg-transparent hover:bg-[var(--st-fill)]',
                                ].join(' ')}
                            >
                                <span
                                    className={[
                                        'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border',
                                        active && !unavailable
                                            ? 'border-transparent bg-[var(--st-accent)] text-white'
                                            : 'border-[var(--st-line)]',
                                    ].join(' ')}
                                >
                                    {active && !unavailable && <Check size={11} strokeWidth={3} />}
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block text-[13px] text-[var(--st-t1)]">{choice.label}</span>
                                    {(choice.hint || (unavailable && choice.disabledHint)) && (
                                        <span className="mt-0.5 block text-[11.5px] leading-4 text-[var(--st-t2)]">
                                            {unavailable ? choice.disabledHint : choice.hint}
                                        </span>
                                    )}
                                </span>
                            </Button>
                        );
                    })}
                </div>

                {running && (
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-[11.5px] text-[var(--st-t2)]">
                            <span className="truncate">{progressLabel}</span>
                            <span className="shrink-0 tabular-nums">{percent}%</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-[var(--st-fill)]">
                            <div
                                className="h-full rounded-full bg-[var(--st-accent)] transition-[width] duration-200"
                                style={{ width: `${percent}%` }}
                            />
                        </div>
                    </div>
                )}

                {error && (
                    <div className="rounded-lg bg-[var(--st-fill)] px-3 py-2 text-[12px] text-[var(--st-t2)]">
                        {error}
                    </div>
                )}

                <div className="flex justify-end gap-2 pt-1">
                    <Button onClick={onCancel} disabled={running}>
                        {t('common.cancel')}
                    </Button>
                    <Button onClick={() => onConfirm(picked)} variant="primary" disabled={!canConfirm}>
                        {running ? t('options.marketApplying') : t('options.marketApplyConfirm')}
                    </Button>
                </div>
            </div>
        </ThemedDialog>
    );
};

export default MarketApplyDialog;
