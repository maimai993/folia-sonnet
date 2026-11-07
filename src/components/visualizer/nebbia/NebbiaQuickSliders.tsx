import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, RotateCcw } from 'lucide-react';
import { ConsoleSlider } from '../../panelTab/console/controls';
import { kitTransition, useKitReducedMotion } from '../../modal/settings/kit/motion';
import { Button } from '../../ui';
import { defaultPosition, distanceFromDefault, groupIcon, groupsFor, isChanged, resetPatch } from './nebbiaQuickGroups';
import { decimalsOf } from './nebbiaSliderSpecs';
import { NEBBIA_LIMITS, type NebbiaNumberKey, type NebbiaTuning } from './types';

// src/components/visualizer/nebbia/NebbiaQuickSliders.tsx
// 播放页控制面板里歌词样式那一行下面的雾笺滑块：画笔粗细、书写、雾和水珠的全部细节，一边看画面一边拖。
// 面板本身可以滚动。滑块分成可折叠的几组：组头有图标和「调过几项」的徽章，右边一个按钮把整组恢复默认；
// 每条滑杆的轨道上画一个小刻度标出默认值，调离默认值的那条左边亮一点强调色的光，离得越远越亮。
// 颜色一律用面板的主题变量（--st-accent、--st-on-accent、--st-fill 等），不写死色值：改主题色、切日夜这里都跟着变。
// 拖动时按画面帧节流着存（画面马上跟着变），松手再存一次；滑块用面板自己的 PanelSlider（ConsoleSlider 包的），和音量条同一个手感。
// 折叠和徽章的动画走设置窗口那套动效词汇，「减少动态」开着就全部瞬间完成。

interface NebbiaQuickSlidersProps {
    tuning: NebbiaTuning;
    onTuningChange: (patch: Partial<NebbiaTuning>) => void;
    t: (key: string) => string;
}

/**
 * 调过的那条左边的光：颜色全取面板的强调色（--st-accent，用户改主题色、切日夜它就跟着变，不写死任何颜色），
 * 只用 color-mix 把它按离默认值的距离淡到透明；距离越远越浓。
 */
const glowStyle = (strength: number): React.CSSProperties => {
    if (strength <= 0) return {};
    const edge = Math.round(30 + 55 * strength);
    const wash = Math.round(6 + 12 * strength);
    return {
        boxShadow: `inset 2px 0 0 color-mix(in srgb, var(--st-accent) ${edge}%, transparent)`,
        background: `linear-gradient(90deg, color-mix(in srgb, var(--st-accent) ${wash}%, transparent), transparent 55%)`,
    };
};

const NebbiaQuickSliders: React.FC<NebbiaQuickSlidersProps> = ({ tuning, onTuningChange, t }) => {
    const reduced = useKitReducedMotion();
    // 正在拖的那几条的值：拖的时候滑块读它，松手后读存好的
    const [draft, setDraft] = useState<Partial<Record<NebbiaNumberKey, number>>>({});
    // 折起来的组：默认全部展开，笔画粗细在第一组最先看到
    const [folded, setFolded] = useState<Record<string, boolean>>({});
    const pending = useRef<Record<string, number>>({});
    const frame = useRef(0);
    const latest = useRef(onTuningChange);
    latest.current = onTuningChange;

    const flush = useCallback(() => {
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        const patch = pending.current;
        if (Object.keys(patch).length === 0) return;
        pending.current = {};
        latest.current(patch as Partial<NebbiaTuning>);
    }, []);
    // 拖到一半面板关了：把试着调的值记下来
    useEffect(() => flush, [flush]);

    const preview = (key: NebbiaNumberKey, value: number) => {
        setDraft(previous => ({ ...previous, [key]: value }));
        pending.current[key] = value;
        if (!frame.current) frame.current = requestAnimationFrame(flush);
    };
    const commit = (key: NebbiaNumberKey) => {
        flush();
        setDraft(({ [key]: _released, ...rest }) => rest);
    };
    const reset = (patch: Partial<NebbiaTuning>) => {
        flush();
        setDraft({});
        onTuningChange(patch);
    };
    const valueOf = (key: NebbiaNumberKey) => draft[key] ?? tuning[key];

    return (
        <div className="mt-1 flex w-full basis-full flex-col gap-2 pb-1 pt-2" data-testid="nebbia-quick-sliders">
            {groupsFor(tuning).map(group => {
                const Icon = groupIcon(group.titleKey);
                const open = !folded[group.titleKey];
                const changed = group.specs.filter(([key, , step]) => isChanged(key, valueOf(key), step)).length;
                return (
                    <section
                        key={group.titleKey}
                        className="overflow-hidden rounded-xl bg-[var(--st-fill)] shadow-[inset_0_0_0_1px_var(--st-line)]"
                    >
                        <div className="flex items-center gap-1 pr-1.5">
                            <Button
                                onClick={() => setFolded(previous => ({ ...previous, [group.titleKey]: open }))}
                                className="st-t-fast st-focus-inside flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-[var(--st-fill2)]"
                                aria-expanded={open}
                                aria-label={t(group.titleKey)}
                            >
                                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[var(--st-raise)] text-[color:var(--st-accent)]">
                                    <Icon size={13} />
                                </span>
                                <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-[color:var(--st-t1)]">{t(group.titleKey)}</span>
                                <AnimatePresence initial={false}>
                                    {changed > 0 && (
                                        <motion.span
                                            key="badge"
                                            initial={reduced ? false : { opacity: 0, scale: 0.6 }}
                                            animate={{ opacity: 1, scale: 1 }}
                                            exit={reduced ? undefined : { opacity: 0, scale: 0.6 }}
                                            transition={kitTransition('fast', reduced)}
                                            className="shrink-0 rounded-full bg-[var(--st-accent)] px-1.5 text-[10.5px] font-medium leading-4 text-[color:var(--st-on-accent)] tabular-nums"
                                        >
                                            {changed}
                                        </motion.span>
                                    )}
                                </AnimatePresence>
                                <ChevronDown
                                    size={14}
                                    className={`st-t-move shrink-0 text-[color:var(--st-t3)] transition-transform ${open ? '' : '-rotate-90'}`}
                                />
                            </Button>
                            <Button
                                onClick={() => reset(resetPatch(group))}
                                disabled={changed === 0}
                                className="st-t-fast st-focus-inside grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[color:var(--st-t3)] transition-[color,background-color,opacity] enabled:hover:bg-[var(--st-fill2)] enabled:hover:text-[color:var(--st-t1)] enabled:active:scale-[0.92] disabled:cursor-default disabled:opacity-25"
                                aria-label={`${t('options.nebbiaGroupReset')}: ${t(group.titleKey)}`}
                                title={t('options.nebbiaGroupReset')}
                            >
                                <RotateCcw size={13} />
                            </Button>
                        </div>
                        <AnimatePresence initial={false}>
                            {open && (
                                <motion.div
                                    key="body"
                                    initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
                                    animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
                                    exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
                                    transition={kitTransition('unfold', reduced)}
                                >
                                    <div className="flex flex-col gap-0.5 px-1 pb-2 pt-0.5">
                                        {group.specs.map(([key, labelKey, step, format]) => {
                                            const { min, max } = NEBBIA_LIMITS[key];
                                            const value = valueOf(key);
                                            const strength = isChanged(key, value, step) ? distanceFromDefault(key, value, min, max) : 0;
                                            return (
                                                <div
                                                    key={key}
                                                    className="relative rounded-lg px-2 py-1.5 transition-[background,box-shadow] duration-300"
                                                    style={glowStyle(strength)}
                                                    data-changed={strength > 0 || undefined}
                                                >
                                                    <ConsoleSlider
                                                        label={t(labelKey)}
                                                        valueText={format(value)}
                                                        value={value}
                                                        min={min}
                                                        max={max}
                                                        decimals={decimalsOf(step)}
                                                        onChange={next => preview(key, next)}
                                                        onCommit={() => commit(key)}
                                                    />
                                                    {/* 默认值刻度：一根细线贴着轨道，位置和滑块的行程一致（两端各让出半个圆点） */}
                                                    <span
                                                        aria-hidden
                                                        className="pointer-events-none absolute bottom-[13px] h-2 w-px rounded-full bg-[var(--st-t3)] opacity-60"
                                                        style={{ left: `calc(0.5rem + 0.5rem + ${defaultPosition(key, min, max)} * (100% - 1rem - 1rem))` }}
                                                    />
                                                </div>
                                            );
                                        })}
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </section>
                );
            })}
        </div>
    );
};

export default NebbiaQuickSliders;
