import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '../../ui';

// src/components/panelTab/equalizer/EqualizerSection.tsx
// A section of the audio effect window: a small heading over one card, the look of a group in the
// settings. The settings kit's Group is not used: it cannot take the height that is to spare, which
// the band section does.
//
// 标题可点：点一下把这卡片收起/展开（调音台的三级折叠）。这个组件只在调音台这一条路上用
// （console 各 Pane，以及被 EqualizerPane 复用的两个 Grid），所以折叠能力直接内建在这里，
// 不需要 Context / Provider 去分辨场合。状态存在组件自己身上，切页签重挂载后回到展开态。

type EqualizerSectionProps = {
    title: string;
    /** A few quiet words at the right end of the heading's line. */
    hint?: string;
    /** Takes the height its column has to spare, and its card with it. */
    grow?: boolean;
    /**
     * 这一块是均衡器窗口的哪一块。纯标记（落进 data-folia-audio-effects / data-folia-equalizer-bands），
     * 手机适配的 CSS 靠它给这两块单独排版（src/styles/androidPhoneFit.css）。
     */
    marker?: 'audio-effects' | 'equalizer-bands';
    children: React.ReactNode;
};

const EqualizerSection: React.FC<EqualizerSectionProps> = ({ title, hint, grow, marker, children }) => {
    const [open, setOpen] = useState(true);

    return (
        <section className={`mt-5 flex flex-col${grow && open ? ' flex-1' : ''}`}>
            <h3 className="mb-2 min-h-6">
                <Button
                    variant="bare"
                    aria-expanded={open}
                    onClick={() => setOpen(value => !value)}
                    className="flex min-h-6 w-full items-center justify-between gap-3 rounded px-1 text-left transition-colors hover:bg-[var(--st-raise)]"
                >
                    <span className="flex min-w-0 items-center gap-1.5">
                        <ChevronDown
                            size={13}
                            aria-hidden
                            className={`st-t-move shrink-0 text-[color:var(--st-t3)] transition-transform${open ? ' rotate-180' : ''}`}
                        />
                        <span className="truncate text-[13px] font-semibold leading-5 text-[color:var(--st-t2)]">{title}</span>
                    </span>
                    {hint && <span className="min-w-0 max-w-[60%] text-right text-xs leading-[18px] text-[color:var(--st-t3)]">{hint}</span>}
                </Button>
            </h3>
            {open && (
                <div
                    className={`overflow-hidden rounded-xl bg-[var(--st-card)] shadow-[0_0_0_1px_var(--st-line)]${grow ? ' flex flex-1' : ''}`}
                    {...(marker ? { [`data-folia-${marker}`]: 'true' } : {})}
                >
                    {children}
                </div>
            )}
        </section>
    );
};

export default EqualizerSection;
