import React from 'react';
import { motion } from 'framer-motion';

// src/components/collectionOpenMorph/MorphFlightLayer.tsx
// 正向飞行的合成层：卡片外框、封面、标题三件套各自从点击时的矩形形变到详情页 hero 的
// 对应矩形。纯展示组件，不知道生命周期阶段，只接收「现在是否在淡出 / 是否处于快进」。
//
// 拆出来的原因只有一个：overlay 原来的生命周期（定时器、轮询、store 读写）和这三层
// 视觉曾经挤在同一个 1000 行文件里，调时序时必须同时在几百行 JSX 里找坐标。

import {
    COLLECTION_MORPH_Z_INDEX,
    flipFromRect,
    flipTo,
    type CollectionMorphPending,
    type CollectionMorphRect,
    type CollectionMorphTarget,
} from './morphGeometry';

// Springy-but-controlled: a visible overshoot (~2-4%) on arrival that breathes
// back flat, without any extra oscillation tail. Stiffer/faster than before:
// the morph now doubles as a load cover, so the flight must feel snappy.
export const MORPH_SPRING = { type: 'spring', stiffness: 420, damping: 24, mass: 0.85 } as const;
export const FADE_DURATION_SECONDS = 0.18;
export const CROSSFADE_SECONDS = 0.28;
const FAST_FORWARD_TWEEN = { duration: 0.26, ease: [0.22, 1, 0.36, 1] } as const;
export const FAST_FORWARD_FADE_SECONDS = 0.1;

export type MorphFastForwardStart = {
    frame: CollectionMorphRect;
    cover: CollectionMorphRect;
    title: CollectionMorphRect;
};

interface MorphFlightLayerProps {
    start: CollectionMorphPending;
    target: CollectionMorphTarget;
    /** Fades snap shut instead of dissolving once the user fast-forwarded. */
    fastForwarding: boolean;
    /** On-screen rects at fast-forward time; the replay continues from these. */
    ffStart: MorphFastForwardStart | null;
    /** True while the flight is dissolving (stage 'fading'). */
    fading: boolean;
    /** True once the hero content should replace the card content. */
    showHeroContent: boolean;
    /** 目的地是歌手页的圆形头像：飞行中把圆角收成圆。 */
    artistLanding: boolean;
    frameRef: React.Ref<HTMLDivElement>;
    coverRef: React.Ref<HTMLDivElement>;
    titleRef: React.Ref<HTMLDivElement>;
    /** 点击封锁层 = 跳过转场（不然第一次点击只会被无声吞掉）。 */
    onSkip: () => void;
    onFrameAnimationComplete: () => void;
}

const MorphFlightLayer: React.FC<MorphFlightLayerProps> = ({
    start,
    target,
    fastForwarding,
    ffStart,
    fading,
    showHeroContent,
    artistLanding,
    frameRef,
    coverRef,
    titleRef,
    onSkip,
    onFrameAnimationComplete,
}) => {
    const fadeSeconds = fastForwarding ? FAST_FORWARD_FADE_SECONDS : FADE_DURATION_SECONDS;
    const spring = fastForwarding ? FAST_FORWARD_TWEEN : MORPH_SPRING;
    const suffix = fastForwarding ? '-ff' : '';
    // 圆角一律用 px：`50%` → `16px` 是混合单位，插值不出来只会跳变。
    const coverCircle = `${Math.min(target.cover.width, target.cover.height) / 2}px`;
    const frameCircle = `${Math.min(target.frame.width, target.frame.height) / 2}px`;

    return (
        <>
            {/* Input blockade for the flight's duration: the morph is a load
                cover, so interaction waits a beat. Scrolling or clicking
                fast-forwards the flight (see the overlay's accelerate), which
                releases this within FAST_FORWARD_FINISH_MS — the delay is
                always short. Hidden from AT: it carries no content. */}
            <div
                data-folia-collection-morph="input-blocker"
                aria-hidden="true"
                className="fixed inset-0"
                style={{ zIndex: COLLECTION_MORPH_Z_INDEX + 10, pointerEvents: 'auto' }}
                onPointerDownCapture={onSkip}
            />
            {/* Card frame: the whole border box glides and resizes onto the hero
                card, lifting slightly (scale) then settling flat. */}
            <motion.div
                key={`morph-frame-${start.capturedAt}${suffix}`}
                ref={frameRef}
                data-folia-collection-morph="frame"
                aria-hidden="true"
                className="fixed rounded-2xl border shadow-[0_24px_80px_rgba(0,0,0,0.5)] pointer-events-none overflow-hidden"
                style={{
                    zIndex: COLLECTION_MORPH_Z_INDEX,
                    background: 'var(--bg-color)',
                    left: start.frame.x,
                    top: start.frame.y,
                    width: start.frame.width,
                    height: start.frame.height,
                    willChange: 'transform, opacity',
                }}
                initial={fastForwarding && ffStart
                    ? { ...flipFromRect(ffStart.frame, start.frame), scale: 1, opacity: 1 }
                    : { x: 0, y: 0, scaleX: 1, scaleY: 1, scale: 0.97, opacity: 1 }}
                animate={{
                    ...flipTo(start.frame, target.frame),
                    scale: 1,
                    borderRadius: artistLanding ? frameCircle : undefined,
                    opacity: fading ? 0 : 1,
                }}
                transition={{
                    ...spring,
                    opacity: { duration: fadeSeconds, ease: 'easeOut' },
                }}
                onAnimationComplete={onFrameAnimationComplete}
            />
            {/* Cover: the same <img> the user clicked gliding onto the hero cover
                with a whisper of rotation; motion blur sharpens to zero as it
                lands, then the song artwork crossfades in. */}
            <motion.div
                key={`morph-cover-${start.capturedAt}${suffix}`}
                ref={coverRef}
                data-folia-collection-morph="cover"
                aria-hidden="true"
                className="fixed overflow-hidden rounded-xl pointer-events-none"
                style={{
                    zIndex: COLLECTION_MORPH_Z_INDEX + 1,
                    left: start.cover.x,
                    top: start.cover.y,
                    width: start.cover.width,
                    height: start.cover.height,
                    willChange: 'transform, opacity, filter',
                }}
                initial={fastForwarding && ffStart
                    ? { ...flipFromRect(ffStart.cover, start.cover), scale: 1, rotate: 0, filter: 'blur(3px)', opacity: 1 }
                    : { x: 0, y: 0, scaleX: 1, scaleY: 1, scale: 0.96, rotate: 2.4, filter: 'blur(6px)', opacity: 1 }}
                animate={{
                    ...flipTo(start.cover, target.cover),
                    scale: 1,
                    rotate: 0,
                    borderRadius: artistLanding ? coverCircle : undefined,
                    filter: 'blur(0px)',
                    opacity: fading ? 0 : 1,
                }}
                transition={{
                    ...spring,
                    opacity: { duration: fadeSeconds, ease: 'easeOut' },
                }}
            >
                {start.coverUrl ? (
                    <img src={start.coverUrl} alt="" className="absolute inset-0 w-full h-full object-cover" draggable={false} />
                ) : (
                    <div className="absolute inset-0 bg-zinc-800/40" />
                )}
                {target.coverUrl ? (
                    <img
                        src={target.coverUrl}
                        alt=""
                        className="absolute inset-0 w-full h-full object-cover"
                        style={{ opacity: showHeroContent ? 1 : 0, transition: `opacity ${CROSSFADE_SECONDS}s ease` }}
                        draggable={false}
                    />
                ) : null}
            </motion.div>
            {/* Title: label glides to the hero title slot; text swaps to the song
                title mid-flight via crossfade. Both spans stack on the same spot
                so the swap is a pure fade, never a layout shift.
                NOTE: deliberately NOT FLIP — the start (home card title line)
                and target (hero title slot) rects have different aspect ratios,
                and non-uniform scaleX/scaleY permanently stretches the glyphs
                ("一大坨"). Animating the box keeps the font fixed and the
                landing pixel-exact; a single small text element is cheap. */}
            <motion.div
                key={`morph-title-${start.capturedAt}${suffix}`}
                ref={titleRef}
                data-folia-collection-morph="title"
                aria-hidden="true"
                className="fixed pointer-events-none"
                style={{ zIndex: COLLECTION_MORPH_Z_INDEX + 2, willChange: 'left, top, width, height, opacity, filter' }}
                initial={fastForwarding && ffStart
                    ? {
                        left: ffStart.title.x,
                        top: ffStart.title.y,
                        width: ffStart.title.width,
                        height: ffStart.title.height,
                        filter: 'blur(2px)',
                        opacity: 1,
                    }
                    : {
                        left: (start.title ?? start.frame).x,
                        top: (start.title ?? start.frame).y,
                        width: (start.title ?? start.frame).width,
                        height: (start.title ?? start.frame).height,
                        filter: 'blur(5px)',
                        opacity: 1,
                    }}
                animate={{
                    left: target.title.x,
                    top: target.title.y,
                    width: target.title.width,
                    height: target.title.height,
                    filter: 'blur(0px)',
                    opacity: fading ? 0 : 1,
                }}
                transition={{
                    ...spring,
                    opacity: { duration: fadeSeconds, ease: 'easeOut' },
                }}
            >
                <span
                    className="absolute inset-0 font-bold truncate"
                    style={{
                        color: 'var(--text-primary)',
                        fontSize: 'inherit',
                        opacity: showHeroContent ? 0 : 1,
                        transition: `opacity ${CROSSFADE_SECONDS}s ease`,
                        textShadow: '0 1px 2px rgba(0,0,0,0.55)',
                    }}
                >
                    {start.titleText || ' '}
                </span>
                <span
                    className="absolute inset-0 font-bold truncate"
                    style={{
                        color: 'var(--text-primary)',
                        fontSize: 'inherit',
                        opacity: showHeroContent ? 1 : 0,
                        transition: `opacity ${CROSSFADE_SECONDS}s ease`,
                        textShadow: '0 1px 2px rgba(0,0,0,0.55)',
                    }}
                >
                    {target.titleText || ' '}
                </span>
            </motion.div>
        </>
    );
};

export default MorphFlightLayer;
