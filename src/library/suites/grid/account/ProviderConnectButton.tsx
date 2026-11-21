import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { useReducedMotionFor } from '../../../../hooks/useReducedMotionFor';
import { pillChromeClassesFor as gridChromeClassesFor } from '../../../../components/shared/pillChrome';
import { hasPlatformIcon } from '../../../../components/shared/platformIcons/registry';
import { PlatformIcon } from '../../../../components/shared/platformIcons/PlatformIcon';
import type { ProviderAccountSummary } from '../../../../types/onlineMusic';

// src/library/suites/grid/account/ProviderConnectButton.tsx
// 与 GridViewTabs 同款的胶囊切换：所有平台常驻为徽章，只有选中的一个展开显示操作文案。
// 悬停和点击都能切换展开项；点击已展开的平台才执行登录/切换，所以鼠标是“悬停 + 一次点击”，触屏是两次点按。
// 胶囊宽度一变，其余徽章会滑到静止的指针下：悬停只认真实的指针移动（pointermove），
// 并在每次切换后锁定一小段时间等布局动画落定，避免徽章滑过指针时来回抖动。

type Props = {
    providers: ProviderAccountSummary[];
    isDaylight: boolean;
    getActionLabel: (provider: ProviderAccountSummary) => string;
    onSelect: (provider: ProviderAccountSummary) => void;
};

// 有自绘图形的平台（components/shared/platformIcons 登记过的那几家）直接亮图形；Mod 音源等
// 没登记的回落名称首字的纯色圆形徽章，与切换器的做法一致。
const fallbackBadge = (provider: ProviderAccountSummary, isDaylight: boolean): [string, string] => ([
    Array.from(provider.shortName || provider.displayName)[0] || '?',
    isDaylight ? 'bg-zinc-500' : 'bg-zinc-600',
]);

const SPRING = { type: 'spring', stiffness: 460, damping: 36, mass: 0.9 } as const;
// 与 SPRING 的落定时间大致对齐；锁定期间的悬停不切换展开项。
const HOVER_SWITCH_LOCK_MS = 220;

export default function ProviderConnectButton({ providers, isDaylight, getActionLabel, onSelect }: Props) {
    const { t } = useTranslation();
    const highlightId = useId();
    const calm = useReducedMotionFor('uiMicroMotion');
    const transition = calm ? { duration: 0 } : SPRING;
    const chrome = gridChromeClassesFor(isDaylight);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const hoverLockedUntil = useRef(0);
    const visible = providers.filter(provider => provider.availability.reason !== 'runtime-unavailable');
    // 选中项被移除（如 Mod 卸载）时回落到第一个可用平台。
    const selected = visible.find(provider => provider.providerId === selectedId)
        ?? visible.find(provider => provider.availability.configured)
        ?? visible[0];

    return (
        <div
            role="group"
            aria-label={t('home.connectPlatformAccounts')}
            className={`hide-scrollbar flex h-[52px] max-w-full items-center gap-0.5 overflow-x-auto rounded-full p-1.5 backdrop-blur-md ${chrome.pill}`}
        >
            {visible.map(provider => {
                const active = provider.providerId === selected?.providerId;
                const configured = provider.availability.configured;
                const label = getActionLabel(provider);
                const [badge, color] = fallbackBadge(provider, isDaylight);
                const hasArt = hasPlatformIcon(provider.providerId);
                return (
                    <motion.button
                        key={provider.providerId}
                        layout
                        transition={transition}
                        type="button"
                        aria-label={label}
                        aria-current={active ? 'true' : undefined}
                        // 展开项本身已经显示文案，其余徽章需要可悬停查看的名字。
                        title={active ? undefined : label}
                        disabled={active && !configured}
                        onPointerMove={event => {
                            if (active || event.pointerType === 'touch' || performance.now() < hoverLockedUntil.current) return;
                            hoverLockedUntil.current = performance.now() + (calm ? 0 : HOVER_SWITCH_LOCK_MS);
                            setSelectedId(provider.providerId);
                        }}
                        onClick={() => {
                            if (!active) setSelectedId(provider.providerId);
                            else if (configured) onSelect(provider);
                        }}
                        className={`relative flex h-10 shrink-0 cursor-pointer items-center gap-2.5 rounded-full text-[15px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-current disabled:cursor-not-allowed ${
                            active ? `pl-1.5 pr-5 ${chrome.strongText}` : `w-10 justify-center ${chrome.softText}`
                        }`}
                    >
                        {active && (
                            <motion.span
                                layoutId={highlightId}
                                transition={transition}
                                className={`absolute inset-0 rounded-full ${chrome.activePill}`}
                            />
                        )}
                        {hasArt ? (
                            /*
                             * 自绘图形直接铺满徽章位（圆形裁切），不必再套彩色圆底：
                             * 图形自己就带着识别色的底板。
                             */
                            <span
                                aria-hidden="true"
                                className={`relative h-7 w-7 shrink-0 overflow-hidden rounded-full transition-opacity ${
                                    !configured ? 'opacity-35 grayscale' : active ? '' : 'opacity-90'
                                }`}
                            >
                                <PlatformIcon platformId={provider.providerId} size={28} round className="h-full w-full" />
                            </span>
                        ) : (
                            <span
                                aria-hidden="true"
                                className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold leading-none text-white transition-opacity ${color} ${
                                    !configured ? 'opacity-35 grayscale' : active ? '' : 'opacity-75'
                                }`}
                            >{badge}</span>
                        )}
                        {active && (
                            <motion.span
                                key={provider.providerId}
                                initial={calm ? false : { opacity: 0 }}
                                animate={{ opacity: configured ? 1 : 0.4 }}
                                transition={{ duration: calm ? 0 : 0.18, delay: calm ? 0 : 0.06 }}
                                aria-live="polite"
                                className="relative whitespace-nowrap"
                            >{label}</motion.span>
                        )}
                    </motion.button>
                );
            })}
        </div>
    );
}
