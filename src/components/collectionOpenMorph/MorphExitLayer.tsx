import React from 'react';
import { motion } from 'framer-motion';

// src/components/collectionOpenMorph/MorphExitLayer.tsx
// 反向飞行的合成层：hero 的三件套飞回来源卡片，其余卡片作为「幽灵」沿各自径向四散。
// 纯展示组件 —— 它只知道「飞回哪里」「要不要原地等待落点」，不知道导航和定时器。

import {
    COLLECTION_MORPH_Z_INDEX,
    collectionMorphReach,
    collectionMorphRectSeed,
    flipTo,
    MORPH_CARD_COVER_RADIUS,
    MORPH_CARD_FRAME_RADIUS,
    MORPH_CIRCLE_RADIUS,
    type CollectionMorphExit,
    type CollectionMorphGeometry,
    type CollectionMorphRect,
} from './morphGeometry';

// Exit spring: just past critical (ζ ≈ 0.85) so the launch keeps the small
// rebound the exit is supposed to have, while the two scale axes still converge
// together instead of wobbling against each other (they travel different
// distances, so any real bounce shows up as the box breathing in aspect ratio).
const EXIT_SPRING = { type: 'spring', stiffness: 380, damping: 30, mass: 0.85 } as const;
// Apple-style exit curve for dissolves (opacity/backdrop still breathe on this).
const EXIT_EASE = [0.32, 0.72, 0, 1] as const;
const EXIT_DURATION_SECONDS = 0.5;
const EXIT_BACKDROP_SECONDS = 0.62;

interface MorphExitLayerProps {
    exit: CollectionMorphExit;
    /**
     * Where the hero lands: the original home card, or (nested back) the card
     * this level was pushed from. Null while a nested back still waits for that
     * card to render, or when no trustworthy source exists. Its `title` may be
     * null (a click capture with no title line): the title layer then holds the
     * hero's own title rect instead of flying to a box it never occupied.
     */
    landing: CollectionMorphGeometry | null;
    /** Nested back that has not found its landing card yet: hold in place. */
    holding: boolean;
    /** No landing at all: the hero shrinks away in place. */
    isNested: boolean;
    /** 点击封锁层 = 跳过转场（不然第一次点击只会被无声吞掉）。 */
    onSkip: () => void;
    onExitComplete: () => void;
}

const MorphExitLayer: React.FC<MorphExitLayerProps> = ({
    exit,
    landing,
    holding,
    isNested,
    onSkip,
    onExitComplete,
}) => {
    const heroRect = exit.from;
    // Nested backs land on the pushed-from card once the remounted grid renders
    // it (hunted by the overlay's poll) — until then the hero HOLDS in place
    // over the incoming cascade; if the poll gave up it shrinks away in place.
    const homeRect: CollectionMorphRect = landing?.frame ?? heroRect.frame;
    const homeCover: CollectionMorphRect = landing?.cover ?? heroRect.cover;
    const homeTitle: CollectionMorphRect = landing?.title ?? heroRect.title;
    const key = `exit-${exit.armedAt}`;
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const reach = collectionMorphReach(window.innerWidth, window.innerHeight);
    const squadMaxDist = Math.max(
        1,
        ...exit.squad.map((ghost) => Math.hypot(
            ghost.rect.x + ghost.rect.width / 2 - cx,
            ghost.rect.y + ghost.rect.height / 2 - cy,
        )),
    );
    // 圆角保持百分比写法：圆形落点必须是 `50%`（形变层渲染在 hero 的盒子里、再被非等比
    // 缩放，百分比跟着缩放走才落在正圆上；换成 px 会变成被拉长的圆角矩形），飞回卡片时才
    // 换成卡片的角半径。
    const frameRadius = heroRect.round
        ? (isNested ? MORPH_CIRCLE_RADIUS : MORPH_CARD_FRAME_RADIUS)
        : undefined;
    const coverRadius = heroRect.round
        ? (isNested ? MORPH_CIRCLE_RADIUS : MORPH_CARD_COVER_RADIUS)
        : undefined;

    return (
        <>
            {/* Same input blockade as the forward flight — the exit is short, and
                a stray click mid-flight must not re-trigger navigation
                underneath the scattering cards. Hidden from AT: no content. */}
            <div
                data-folia-collection-morph="input-blocker"
                aria-hidden="true"
                className="fixed inset-0"
                style={{ zIndex: COLLECTION_MORPH_Z_INDEX + 10, pointerEvents: 'auto' }}
                onClick={onSkip}            />
            <motion.div
                key={`${key}-backdrop`}
                data-folia-collection-morph="exit-backdrop"
                aria-hidden="true"
                className="fixed inset-0 pointer-events-none"
                style={{ zIndex: COLLECTION_MORPH_Z_INDEX - 1, background: 'var(--bg-color)' }}
                initial={{ opacity: 1 }}
                animate={{ opacity: 0 }}
                transition={{ duration: EXIT_BACKDROP_SECONDS, ease: [...EXIT_EASE] }}
            />
            {/* Surrounding cards scatter outward — the fly-in in reverse,
                replayed as their real covers so the exit reads as the grid
                itself dissolving instead of empty frames. */}
            {exit.squad.map((ghost, index) => {
                const rect = ghost.rect;
                const dX = rect.x + rect.width / 2 - cx;
                const dY = rect.y + rect.height / 2 - cy;
                const distance = Math.hypot(dX, dY);
                const direction = distance > 1
                    ? { x: dX / distance, y: dY / distance }
                    : { x: 0, y: -1 };
                // Deterministic jitter from the rect so the scatter breathes
                // like the entrance instead of sweeping.
                const seed = collectionMorphRectSeed(rect);
                const jitter = ((seed % 1000) / 1000 - 0.5) * 0.08;
                const normalized = Math.min(distance / squadMaxDist, 1);
                // Farther ghosts leave sooner and faster: a depth wave rolls
                // outward from the hero instead of a uniform sweep.
                const duration = 0.46 + normalized * 0.3;
                return (
                    <motion.div
                        key={`${key}-squad-${index}`}
                        data-folia-collection-morph="squad"
                        aria-hidden="true"
                        className="fixed rounded-xl overflow-hidden pointer-events-none"
                        style={{
                            zIndex: COLLECTION_MORPH_Z_INDEX,
                            boxShadow: '0 10px 32px rgba(0,0,0,0.35)',
                            borderRadius: 14,
                            left: rect.x,
                            top: rect.y,
                            width: rect.width,
                            height: rect.height,
                            transformOrigin: '50% 50%',
                            willChange: 'transform, opacity',
                        }}
                        initial={{
                            x: 0,
                            y: 0,
                            rotate: 0,
                            scale: 1,
                            opacity: 1,
                        }}
                        animate={{
                            x: direction.x * reach * 0.5,
                            y: direction.y * reach * 0.5,
                            rotate: (seed % 2 === 0 ? 1 : -1) * (3.5 + (seed % 3) * 1.6),
                            scale: 0.84,
                            opacity: [1, 0.72, 0],
                        }}
                        transition={{
                            duration,
                            ease: [0.22, 1, 0.36, 1],
                            delay: 0.04 + normalized * 0.26 + jitter,
                            opacity: { duration, times: [0, 0.5, 1], ease: 'easeInOut' },
                        }}
                    >
                        {ghost.coverUrl ? (
                            <img
                                src={ghost.coverUrl}
                                alt=""
                                className="absolute inset-0 w-full h-full object-cover"
                                draggable={false}
                            />
                        ) : (
                            <div className="absolute inset-0 bg-zinc-800/40" />
                        )}
                        {/* Scrim + title strip keeps the ghost reading as
                            the real card it stood in for. */}
                        <div
                            className="absolute inset-0"
                            style={{
                                background: 'linear-gradient(180deg, rgba(0,0,0,0) 55%, rgba(0,0,0,0.62) 100%)',
                            }}
                        />
                        <div className="absolute inset-0" style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.14)' }} />
                        {ghost.titleText ? (
                            <div className="absolute inset-x-0 bottom-0 px-2.5 pb-2">
                                <div
                                    className="text-[11px] font-bold text-white truncate"
                                    style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}
                                >
                                    {ghost.titleText}
                                </div>
                            </div>
                        ) : null}
                    </motion.div>
                );
            })}
            {/* Hero frame flies straight back onto the home card. While a nested
                back waits for its landing card, it holds in place (opacity 1)
                over the incoming cascade instead of dissolving before the
                destination exists. */}
            <motion.div
                key={`${key}-frame`}
                data-folia-collection-morph="frame"
                aria-hidden="true"
                className="fixed rounded-2xl border shadow-[0_24px_80px_rgba(0,0,0,0.5)] pointer-events-none overflow-hidden"
                style={{
                    zIndex: COLLECTION_MORPH_Z_INDEX + 1,
                    background: 'var(--bg-color)',
                    left: heroRect.frame.x,
                    top: heroRect.frame.y,
                    width: heroRect.frame.width,
                    height: heroRect.frame.height,
                    willChange: 'transform, opacity',
                }}
                initial={{ x: 0, y: 0, scaleX: 1, scaleY: 1, scale: 1, opacity: 1, borderRadius: heroRect.round ? MORPH_CIRCLE_RADIUS : undefined }}
                animate={holding
                    ? {
                        x: 0,
                        y: 0,
                        scaleX: 1,
                        scaleY: 1,
                        scale: 0.97,
                        borderRadius: heroRect.round ? MORPH_CIRCLE_RADIUS : undefined,
                        opacity: 1,
                    }
                    : {
                        ...flipTo(heroRect.frame, homeRect),
                        scale: isNested ? 0.8 : 0.985,
                        // From the artist's circular avatar: keep the circle
                        // while shrinking away in place, round back into the
                        // landing card's corners when flying onto it.
                        borderRadius: frameRadius,
                        opacity: [1, 1, 0],
                    }}
                transition={{
                    ...EXIT_SPRING,
                    opacity: { duration: EXIT_DURATION_SECONDS, times: [0, 0.72, 1], ease: 'easeOut' },
                }}
                onAnimationComplete={onExitComplete}
            />
            {/* Cover crossfades back into the home artwork mid-flight. */}
            <motion.div
                key={`${key}-cover`}
                data-folia-collection-morph="cover"
                aria-hidden="true"
                className="fixed overflow-hidden rounded-xl pointer-events-none"
                style={{
                    zIndex: COLLECTION_MORPH_Z_INDEX + 2,
                    left: heroRect.cover.x,
                    top: heroRect.cover.y,
                    width: heroRect.cover.width,
                    height: heroRect.cover.height,
                    willChange: 'transform, opacity, filter',
                }}
                initial={{ x: 0, y: 0, scaleX: 1, scaleY: 1, scale: 1, rotate: 0, filter: 'blur(0px)', opacity: 1, borderRadius: heroRect.round ? MORPH_CIRCLE_RADIUS : undefined }}
                animate={holding
                    ? {
                        x: 0,
                        y: 0,
                        scaleX: 1,
                        scaleY: 1,
                        scale: 0.96,
                        rotate: 0,
                        filter: 'blur(0px)',
                        borderRadius: heroRect.round ? MORPH_CIRCLE_RADIUS : undefined,
                        opacity: 1,
                    }
                    : {
                        ...flipTo(heroRect.cover, homeCover),
                        scale: isNested ? 0.78 : 1,
                        rotate: [0, 5, 1.6],
                        // Artist avatar exit: the circle un-rounds back into
                        // the landing card's cover on the way home.
                        borderRadius: coverRadius,
                        filter: ['blur(0px)', 'blur(1px)', 'blur(8px)'],
                        opacity: [1, 1, 0],
                    }}
                transition={{
                    ...EXIT_SPRING,
                    opacity: { duration: EXIT_DURATION_SECONDS, times: [0, 0.72, 1], ease: 'easeOut' },
                }}
            >
                {heroRect.coverUrl ? (
                    <img src={heroRect.coverUrl} alt="" className="absolute inset-0 w-full h-full object-cover" draggable={false} />
                ) : (
                    <div className="absolute inset-0 bg-zinc-800/40" />
                )}
                {landing?.coverUrl && landing.coverUrl !== heroRect.coverUrl ? (
                    <motion.img
                        src={landing.coverUrl}
                        alt=""
                        className="absolute inset-0 w-full h-full object-cover"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: EXIT_DURATION_SECONDS * 0.7, ease: 'easeOut' }}
                        draggable={false}
                    />
                ) : null}
            </motion.div>
            {/* Title glides home while the song title dissolves into the
                playlist title on the same curve. Box animation, not FLIP:
                hero and home title rects have different aspect ratios and
                non-uniform scale would stretch the glyphs. */}
            <motion.div
                key={`${key}-title`}
                data-folia-collection-morph="title"
                aria-hidden="true"
                className="fixed pointer-events-none"
                style={{ zIndex: COLLECTION_MORPH_Z_INDEX + 3, willChange: 'left, top, width, height, opacity, filter' }}
                initial={{
                    left: heroRect.title.x,
                    top: heroRect.title.y,
                    width: heroRect.title.width,
                    height: heroRect.title.height,
                    filter: 'blur(0px)',
                    opacity: [1, 1, 0],
                }}
                animate={holding
                    ? {
                        left: heroRect.title.x,
                        top: heroRect.title.y,
                        width: heroRect.title.width,
                        height: heroRect.title.height,
                        filter: 'blur(0px)',
                        opacity: 1,
                    }
                    : {
                        left: homeTitle.x,
                        top: homeTitle.y,
                        width: homeTitle.width,
                        height: homeTitle.height,
                        filter: ['blur(0px)', 'blur(1px)', 'blur(8px)'],
                        opacity: [1, 1, 0],
                    }}
                transition={{
                    ...EXIT_SPRING,
                    opacity: { duration: EXIT_DURATION_SECONDS, times: [0, 0.72, 1], ease: 'easeOut' },
                }}
            >
                <span
                    className="absolute inset-0 font-bold truncate"
                    style={{
                        color: 'var(--text-primary)',
                        fontSize: 'inherit',
                        opacity: 1,
                        transition: 'none',
                        textShadow: '0 1px 2px rgba(0,0,0,0.55)',
                    }}
                >
                    {heroRect.titleText || ' '}
                </span>
                <motion.span
                    className="absolute inset-0 font-bold truncate"
                    style={{
                        color: 'var(--text-primary)',
                        fontSize: 'inherit',
                        textShadow: '0 1px 2px rgba(0,0,0,0.55)',
                    }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: EXIT_DURATION_SECONDS * 0.7, ease: 'easeOut' }}
                >
                    {landing?.titleText || ' '}
                </motion.span>
            </motion.div>
        </>
    );
};

export default MorphExitLayer;
