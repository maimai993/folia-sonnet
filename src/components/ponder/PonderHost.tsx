import React, { Suspense, lazy, useRef } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { countRender } from '../../dev/renderCount';
import { usePonderStore } from '../../stores/usePonderStore';
import { usePonderHoverProbe } from '../../hooks/usePonderHoverProbe';
import { usePonderHoldToEnter } from '../../hooks/usePonderHoldToEnter';
import { usePagePonderShortcut } from '../../hooks/usePagePonderShortcut';
import { findPonderTarget } from './ponderRegistry';
import PonderHintCapsule from './PonderHintCapsule';
import PagePonderTouchButton from './PagePonderTouchButton';
import type { Theme } from '../../types';

// src/components/ponder/PonderHost.tsx
// 思索功能的唯一挂载点：常驻的悬停探测 + 提示胶囊，以及按需懒加载的教程层。
//
// 教程层单独走 React.lazy，理由和 App.tsx:22 对 AutomixTransitionAnimation 的处理一样：
// animejs 约 38KB gz，只有真的要看教程时才该下载它。

const PonderStage = lazy(() => import('./PonderStage'));

type PonderHostProps = {
    theme?: Theme;
    isDaylight: boolean;
};

const PonderHost: React.FC<PonderHostProps> = ({ theme, isDaylight }) => {
    // 光标跟随必须一次重渲染都不产生，这个计数是那条约束唯一可验证的出口。
    countRender('PonderHost');
    const { t } = useTranslation();
    const hoveredTargetId = usePonderStore(state => state.hoveredTargetId);
    const hasSession = usePonderStore(state => state.session !== null);

    const wipeRef = useRef<HTMLDivElement | null>(null);
    const labelRef = useRef<HTMLSpanElement | null>(null);
    const holdLabelRef = useRef<HTMLSpanElement | null>(null);

    const hoveredElementRef = usePonderHoverProbe();
    usePonderHoldToEnter({ hoveredElementRef, wipeRef, labelRef, holdLabelRef });
    usePagePonderShortcut();

    const target = hoveredTargetId ? findPonderTarget(hoveredTargetId) : null;

    return (
        <>
            <AnimatePresence>
                {/* 教程开着时不再显示胶囊 —— 它已经被 openPonder 清掉了，这里是第二道保险。 */}
                {target && !hasSession && (
                    <PonderHintCapsule
                        key={target.id}
                        label={t('ponder.hintCapsule')}
                        theme={theme}
                        isDaylight={isDaylight}
                        wipeRef={wipeRef}
                        labelRef={labelRef}
                        holdLabelRef={holdLabelRef}
                    />
                )}
            </AnimatePresence>

            <PagePonderTouchButton
                accent={theme?.accentColor || (isDaylight ? '#27272a' : '#fafafa')}
                isDaylight={isDaylight}
            />

            {hasSession && (
                <Suspense fallback={null}>
                    <PonderStage theme={theme} isDaylight={isDaylight} />
                </Suspense>
            )}
        </>
    );
};

export default PonderHost;
