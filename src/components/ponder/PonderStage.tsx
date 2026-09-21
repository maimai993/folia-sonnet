import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePonderStore } from '../../stores/usePonderStore';
import { usePonderSessionKeys } from '../../hooks/usePonderSessionKeys';
import { compilePonderScene } from '../../utils/ponder/compilePonderTimeline';
import { keyframeTicks } from '../../utils/ponder/ponderKeyframes';
import { resolvePonderAnchors } from '../../utils/ponder/resolvePonderAnchors';
import { findPonderTarget } from './ponderRegistry';
import { createPonderStageNodes } from './ponderStageNodes';
import { usePonderTimeline } from './usePonderTimeline';
import PonderActors from './PonderActors';
import PonderChrome from './PonderChrome';
import PonderSkeletonLayer from './PonderSkeletonLayer';
import PonderNextChapterCue from './PonderNextChapterCue';
import type { PonderRect } from '../../types/ponder';
import type { Theme } from '../../types';

// src/components/ponder/PonderStage.tsx
// 教程层本体。这是懒加载 chunk 的根 —— animejs 只经由 usePonderTimeline 进到这条链里。
//
// 矩形在进入瞬间采一次就定住，不订阅任何东西：底栏基线是 React 之外的 MotionValue、
// Lattice 相机也绕过 React，订阅既拿不到正确值也违反 guardrails。窗口尺寸变了才重采一次。

/** resize 后等这么久再重采，避免拖动窗口时连续重建时间线。 */
const RESAMPLE_DEBOUNCE_MS = 250;

type PonderStageProps = {
    theme?: Theme;
    isDaylight: boolean;
};

const readRect = (selector: string): PonderRect | null => {
    const element = document.querySelector(selector);
    if (!element) {
        return null;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) {
        return null;
    }
    // 圆角照量：真实界面里是圆按钮，骨架就该是圆的。
    const radius = window.getComputedStyle(element).borderRadius;
    return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        ...(radius && radius !== '0px' ? { radius } : {}),
    };
};

const PonderStage: React.FC<PonderStageProps> = ({ theme, isDaylight }) => {
    const { t } = useTranslation();
    const session = usePonderStore(state => state.session);
    const isPaused = usePonderStore(state => state.isPaused);
    const closePonder = usePonderStore(state => state.closePonder);
    const stepScene = usePonderStore(state => state.stepScene);
    const setPaused = usePonderStore(state => state.setPaused);

    const target = session ? findPonderTarget(session.targetId) : null;
    const scene = target?.scenes[session?.sceneIndex ?? 0] ?? null;

    const nodesRef = useRef(createPonderStageNodes());
    const [rects, setRects] = useState<Record<string, PonderRect>>({});
    const [sampleToken, setSampleToken] = useState(0);

    // 换场景或换目标时，节点表必须先清空 —— 上一场景的字幕节点已经卸载，留着会让
    // 时间线对着 detached 节点写属性。
    useLayoutEffect(() => {
        nodesRef.current = createPonderStageNodes();
    }, [session?.targetId, session?.sceneIndex]);

    useLayoutEffect(() => {
        if (!scene) {
            return;
        }
        setRects(resolvePonderAnchors(scene.anchors, {
            readRect,
            viewport: { width: window.innerWidth, height: window.innerHeight },
        }));
    }, [scene, sampleToken]);

    useEffect(() => {
        if (!scene) {
            return;
        }
        let timer: number | null = null;
        const handleResize = () => {
            if (timer !== null) window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                timer = null;
                setSampleToken(token => token + 1);
            }, RESAMPLE_DEBOUNCE_MS);
        };
        window.addEventListener('resize', handleResize);
        return () => {
            window.removeEventListener('resize', handleResize);
            if (timer !== null) window.clearTimeout(timer);
        };
    }, [scene]);

    const plan = useMemo(() => (scene ? compilePonderScene(scene) : null), [scene]);
    const ticks = useMemo(() => (plan ? keyframeTicks(plan) : []), [plan]);

    // 一章播完停下，由卡片接手。isFinished 是离散事实，可以进 state。
    const [isFinished, setIsFinished] = useState(false);
    useLayoutEffect(() => {
        setIsFinished(false);
    }, [session?.targetId, session?.sceneIndex]);
    const handleComplete = useCallback(() => setIsFinished(true), []);

    const emptyPlan = useMemo(() => ({ totalMs: 0, entries: [], keyframes: [] }), []);
    const controlsRef = usePonderTimeline({
        plan: plan ?? emptyPlan,
        rects,
        nodesRef,
        onComplete: handleComplete,
    });

    usePonderSessionKeys({
        isActive: Boolean(session),
        sceneCount: target?.scenes.length ?? 0,
        controlsRef,
    });

    if (!session || !target || !scene || !plan) {
        return null;
    }

    return (
        <div
            // 接管键盘：底下那些全局热键靠这个属性让路，这也是 G 不会在教程里再次触发的原因。
            data-folia-keyboard-window="true"
            data-testid="ponder-stage"
            // z-[220]：压过状态 toast（210），教程是全屏接管，不该被任何东西盖住。
            // backdrop-blur 让底下的真实界面退成一团轮廓而不是仍然可读的文字：
            // 保留「这是同一个地方」的空间感，又不至于和骨架抢注意力。
            className="fixed inset-0 z-[220] overflow-hidden backdrop-blur-md"
            style={{ backgroundColor: isDaylight ? 'rgba(250, 250, 250, 0.94)' : 'rgba(9, 9, 11, 0.94)' }}
            role="dialog"
            aria-modal="true"
            aria-label={t(target.titleKey)}
        >
            <PonderSkeletonLayer
                rects={rects}
                anchors={scene.anchors}
                nodes={nodesRef.current}
                theme={theme}
                isDaylight={isDaylight}
            />
            <PonderActors plan={plan} rects={rects} nodes={nodesRef.current} theme={theme} isDaylight={isDaylight} />
            <PonderChrome
                title={t(target.titleKey)}
                sceneTitle={t(scene.titleKey)}
                sceneIndex={session.sceneIndex}
                sceneCount={target.scenes.length}
                isPaused={isPaused}
                ticks={ticks}
                nodes={nodesRef.current}
                onPrevScene={() => stepScene(-1, target.scenes.length)}
                onNextScene={() => stepScene(1, target.scenes.length)}
                onTogglePlay={() => {
                    const controls = controlsRef.current;
                    if (controls) setPaused(controls.toggle());
                }}
                onRestart={() => controlsRef.current?.restart()}
                onSeekToTick={index => controlsRef.current?.seekToTick(index)}
                theme={theme}
                isDaylight={isDaylight}
            />
            {isFinished && (
                <PonderNextChapterCue
                    nextSceneTitle={target.scenes[session.sceneIndex + 1]
                        ? t(target.scenes[session.sceneIndex + 1].titleKey)
                        : null}
                    onNextScene={() => stepScene(1, target.scenes.length)}
                    theme={theme}
                    isDaylight={isDaylight}
                />
            )}

            <button
                type="button"
                onClick={closePonder}
                className={`absolute right-5 top-5 rounded-full px-3 py-1.5 text-xs transition-colors ${
                    isDaylight ? 'hover:bg-black/10' : 'hover:bg-white/10'
                }`}
                style={{ color: isDaylight ? 'rgba(24, 24, 27, 0.55)' : 'rgba(255, 255, 255, 0.55)' }}
            >
                {t('ponder.exit')}
            </button>
        </div>
    );
};

export default PonderStage;
