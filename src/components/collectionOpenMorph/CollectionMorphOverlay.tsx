import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCollectionNavigationStore } from '../../stores/useCollectionNavigationStore';
import MorphExitLayer from './MorphExitLayer';
import MorphFlightLayer, { CROSSFADE_SECONDS, type MorphFastForwardStart } from './MorphFlightLayer';
import { reportMorphCapture, useCollectionMorphStore } from './collectionMorphStore';
import {
    COLLECTION_MORPH_Z_INDEX,
    estimateCenterTarget,
    isMorphTargetSettled,
    type CollectionMorphExit,
    type CollectionMorphGeometry,
    type CollectionMorphHeroMeasured,
    type CollectionMorphPending,
    type CollectionMorphTarget,
} from './morphGeometry';
import { attachMorphCapture, findMorphCard, probeArtistIntroTargets, probeHeroTargets } from './morphProbes';

// src/components/collectionOpenMorph/CollectionMorphOverlay.tsx
// The match-cut both ways of the「移形换影」transition. Rendered via portal:
//
// Forward (open): the clicked home card's frame, cover artwork and title line
// each morph from their captured rectangles onto the detail grid's centered
// hero song card, carrying a motion blur that sharpens as they land; the title
// and cover crossfade into the song's content mid-flight, then the composite
// fades out over the positioned hero for a seamless cut.
//
// Reverse (back): the hero card's elements fly back onto the original home
// card rectangles with the same blur/crossfade language, while the backdrop
// fades the home surface in underneath. Symmetric easing makes the two halves
// read as one continuous gesture.
//
// This file owns the LIFECYCLE only (stages, timers, polling, store wiring);
// the two composites live in MorphFlightLayer / MorphExitLayer and the geometry
// and probes live in morphGeometry.ts / morphProbes.ts.
//
// Timing contract (kept snappy and self-terminating): springs fly fast toward
// live hero measurements polled on a throttled schedule; if the hero never
// renders the lifecycle still runs to consume — the poll's deadline always hands
// over to the fade, so a missing hero can never leave the composite parked over
// an already-revealed grid — and a hard watchdog guarantees the morph plan can
// never leave the detail grid stuck with its hero hidden.

type MorphStage = 'idle' | 'flying' | 'settling' | 'fading' | 'exiting';

const SETTLE_AFTER_TARGET_MS = 180;
const FAST_FORWARD_FLIGHT_MS = 260;
// …and the whole accelerated lifecycle ends on this hard timer so the input
// blockade never outlives it.
const FAST_FORWARD_FINISH_MS = 140;
const HERO_POLL_INTERVAL_MS = 120;
// The probe only ever measures the ACTIVE grid (see morphProbes.activeGridRoot),
// so the outgoing grid's cards can no longer be mistaken for the hero. What is
// left is the incoming grid's own restore pan: on its first frames the cards are
// still sliding, so a target is accepted only once two consecutive polls measure
// the SAME card at (nearly) the same rectangles. That gate — not a fixed delay —
// is what keeps the flight from retargeting onto a moving card; the warmup below
// only skips the first tick or two, before the grid has rendered at all.
const HERO_POLL_WARMUP_MS = 90;
const HERO_POLL_MAX_MS = 2400;
// A candidate counts as settled when the same card repeats within this tolerance.
const HERO_STABLE_TOLERANCE_PX = 1.5;
// Absolute watchdog: beyond this the store is consumed whatever happens.
const WATCHDOG_MS = 3000;

interface CollectionMorphOverlayProps {
    /**
     * 是否允许播放转场。由宿主读「降低动态效果」的 collectionMorph 面得出，为 false 时
     * 既不挂捕获监听也不领任何计划 —— 转场是纯装饰，降级时应当完全不出现，而不是缩短。
     */
    enabled?: boolean;
}

export const CollectionMorphOverlay: React.FC<CollectionMorphOverlayProps> = ({ enabled = true }) => {
    const pending = useCollectionMorphStore((state) => state.pending);
    const ackPending = useCollectionMorphStore((state) => state.ackPending);
    const commitPlan = useCollectionMorphStore((state) => state.commitPlan);
    const setHero = useCollectionMorphStore((state) => state.setHero);
    const setLastHome = useCollectionMorphStore((state) => state.setLastHome);
    const setLastSource = useCollectionMorphStore((state) => state.setLastSource);
    const consume = useCollectionMorphStore((state) => state.consume);
    const exit = useCollectionMorphStore((state) => state.exit);
    const navigationOrigin = useCollectionNavigationStore((state) => state.snapshot?.origin);
    const navSnapshot = useCollectionNavigationStore((state) => state.snapshot);

    const [stage, setStage] = useState<MorphStage>('idle');
    const [flown, setFlown] = useState<CollectionMorphPending | null>(null);
    const [targets, setTargets] = useState<CollectionMorphTarget | null>(null);
    const [exitPayload, setExitPayload] = useState<CollectionMorphExit | null>(null);
    // True once a scroll fast-forwarded the flight: fades snap shut and the
    // lifecycle ends on a hard timer so the input blockade is released fast.
    const [fastForwarding, setFastForwarding] = useState(false);
    // On-screen rects of the three flying elements at fast-forward time — the
    // compressed replay starts from these, continuing mid-flight instead of
    // rewinding or flashing away.
    const [ffStart, setFfStart] = useState<MorphFastForwardStart | null>(null);
    const frameFlightRef = useRef<HTMLDivElement | null>(null);
    const coverFlightRef = useRef<HTMLDivElement | null>(null);
    const titleFlightRef = useRef<HTMLDivElement | null>(null);
    // Latches on the first scroll/click intent so repeated events never restart
    // or extend the accelerated flight; reset when the lifecycle ends.
    const acceleratedRef = useRef(false);
    // Nested-back landing: the remounted previous grid's card this level was
    // pushed from (e.g. the song card that opened the artist page). It cannot
    // be measured at arm time — the previous grid remounts only AFTER back is
    // pressed — so a poll hunts it and the exit springs retarget onto it.
    const [nestedLanding, setNestedLanding] = useState<CollectionMorphTarget | null>(null);
    const [nestedGaveUp, setNestedGaveUp] = useState(false);
    const nestedPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const fastForwardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // When the current flight launched — gates the warmup of the first hero probe.
    const flightStartedAtRef = useRef(0);
    // Last polled hero candidate: the stability gate compares against it so a
    // measurement taken while the incoming grid is still panning cannot become
    // the flight target.
    const heroCandidateRef = useRef<CollectionMorphHeroMeasured | null>(null);

    const stopPolling = useCallback(() => {
        if (pollTimerRef.current !== null) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
        }
    }, []);

    const stopNestedPoll = useCallback(() => {
        if (nestedPollRef.current !== null) {
            clearInterval(nestedPollRef.current);
            nestedPollRef.current = null;
        }
    }, []);

    const clearSettleTimer = useCallback(() => {
        if (settleTimerRef.current !== null) {
            clearTimeout(settleTimerRef.current);
            settleTimerRef.current = null;
        }
    }, []);

    const clearWatchdog = useCallback(() => {
        if (watchdogTimerRef.current !== null) {
            clearTimeout(watchdogTimerRef.current);
            watchdogTimerRef.current = null;
        }
    }, []);

    const clearFastForwardTimer = useCallback(() => {
        if (fastForwardTimerRef.current !== null) {
            clearTimeout(fastForwardTimerRef.current);
            fastForwardTimerRef.current = null;
        }
    }, []);

    const finishLifecycle = useCallback(() => {
        stopPolling();
        stopNestedPoll();
        clearSettleTimer();
        clearWatchdog();
        clearFastForwardTimer();
        consume();
        setFlown(null);
        setTargets(null);
        setExitPayload(null);
        setFastForwarding(false);
        setFfStart(null);
        setNestedLanding(null);
        setNestedGaveUp(false);
        acceleratedRef.current = false;
        setStage('idle');
    }, [clearFastForwardTimer, clearSettleTimer, clearWatchdog, consume, stopNestedPoll, stopPolling]);

    // Settle → crossfade text/cover → fade, only after targets are known (or
    // the poll gave up and the estimate stands in).
    const armSettle = useCallback(() => {
        clearSettleTimer();
        settleTimerRef.current = setTimeout(() => {
            settleTimerRef.current = null;
            setStage('settling');
        }, SETTLE_AFTER_TARGET_MS);
    }, [clearSettleTimer]);

    useEffect(() => {
        if (!targets || stage !== 'flying') {
            return;
        }
        armSettle();
    }, [targets, stage, armSettle]);

    useEffect(() => {
        if (stage !== 'settling') {
            return;
        }
        clearSettleTimer();
        settleTimerRef.current = setTimeout(() => {
            settleTimerRef.current = null;
            setStage('fading');
        }, CROSSFADE_SECONDS * 1000 * 1.5);
    }, [stage, clearSettleTimer]);

    // Records which card the user clicked. Attached from an effect (and disposed
    // with it) rather than as a module side effect, so HMR cannot stack a second
    // document listener behind the first.
    useEffect(() => {
        if (!enabled) {
            return;
        }
        return attachMorphCapture(reportMorphCapture);
    }, [enabled]);

    // The setting can be flipped while a flight is in the air: finish it on the
    // store so the grid can never be left with its hero hidden.
    useEffect(() => {
        if (enabled || stage === 'idle') {
            return;
        }
        finishLifecycle();
    }, [enabled, stage, finishLifecycle]);

    // Is this candidate the same card, in the same place, as the previous tick?
    // Only then is it safe to fly to: the incoming grid pans to its restored
    // focus a few frames after mounting, and retargeting onto a card mid-pan is
    // what makes the flight change direction in the air.
    const startPolling = useCallback(() => {
        stopPolling();
        heroCandidateRef.current = null;
        const deadline = Date.now() + HERO_POLL_WARMUP_MS + HERO_POLL_MAX_MS;
        pollTimerRef.current = setInterval(() => {
            if (Date.now() - (flightStartedAtRef.current || Date.now()) < HERO_POLL_WARMUP_MS) {
                return;
            }
            const found = ((): CollectionMorphHeroMeasured | null => {
                // Artist destinations morph onto the page's intro cluster
                // (circular avatar + bio title) instead of a song card —
                // the generic probe would latch onto whatever song/album
                // card happens to sit nearest to centre.
                const stack = useCollectionNavigationStore.getState().snapshot?.stack;
                const activeType = stack?.[stack.length - 1]?.type;
                return activeType === 'artist'
                    ? probeArtistIntroTargets()
                    : probeHeroTargets();
            })();
            // Hold the flight over the hero until its cover finished loading
            // (or failed): the morph is the load cover, so the reveal must
            // never uncover an empty frame. The deadline below still caps the
            // wait for covers that never resolve.
            if (found) {
                const settled = isMorphTargetSettled(heroCandidateRef.current, found, HERO_STABLE_TOLERANCE_PX);
                heroCandidateRef.current = found;
                if (settled && found.coverReady) {
                    setTargets(found);
                    setHero(found);
                    stopPolling();
                    return;
                }
            }
            if (Date.now() > deadline) {
                // Never park the composite: handing over to the fade is
                // unconditional, even when the plan already expired. Otherwise
                // the flight would freeze over an already-revealed grid until
                // the watchdog fired.
                stopPolling();
                armSettle();
            }
        }, HERO_POLL_INTERVAL_MS);
    }, [armSettle, setHero, stopPolling]);

    const launchFlight = useCallback((payload: CollectionMorphPending) => {
        setFlown(payload);
        setTargets(null);
        setExitPayload(null);
        clearSettleTimer();
        clearFastForwardTimer();
        acceleratedRef.current = false;
        setFastForwarding(false);
        setFfStart(null);
        flightStartedAtRef.current = Date.now();
        // Remember the top-level source card: the reverse morph flies back onto
        // exactly this home card when the user backs out later. Nested opens
        // (song card → album/artist) must NOT overwrite it — the eventual
        // top-level back still targets the original home card, not the song
        // card. Instead, the nested push's own source card is remembered for
        // the nested back: the hero then flies back onto THE CARD THAT WAS
        // CLICKED (e.g. the song card that opened the artist page).
        const stackDepth = useCollectionNavigationStore.getState().snapshot?.stack.length ?? 0;
        if (stackDepth <= 1) {
            setLastHome(payload);
        } else if (payload.sourceKey) {
            setLastSource(payload, stackDepth);
        }
        // The composite covers this grid's hero: hide it and reveal it as the
        // composite fades. Contrast with 'cascade', which has nothing covering
        // the hero and must therefore leave it visible.
        commitPlan({ kind: 'morph' });
        setStage('flying');
        startPolling();
    }, [clearFastForwardTimer, clearSettleTimer, commitPlan, setLastHome, setLastSource, startPolling]);

    // Did the CURRENT navigation state move in the opening direction relative
    // to when the captured click's gesture began? A click that opens a
    // collection (home open or nested push) always deepens the nav state after
    // the click; a click that merely plays/centers a card leaves it identical.
    // Comparing snapshots needs no subscription ordering — the launch effects
    // re-run on every pending/nav change and simply do nothing until they
    // diverge in the opening direction.
    const navOpenedByGesture = useCallback((payload: CollectionMorphPending): boolean => {
        const currentWasOpen = Boolean(navSnapshot);
        const currentDepth = navSnapshot?.stack.length ?? 0;
        const { wasOpen, depth } = payload.navAtGestureStart;
        return (!wasOpen && currentWasOpen) || currentDepth > depth;
    }, [navSnapshot]);

    // A brand-new home-origin open starts the flight from its captured rects.
    // Stray card clicks (play/center) never change the nav signature, so the
    // observation window discards them instead of a phantom flight launching.
    useEffect(() => {
        if (
            !enabled
            || navigationOrigin !== 'home'
            || !pending
            || stage !== 'idle'
            || !navOpenedByGesture(pending)
        ) {
            return;
        }
        launchFlight(pending);
        ackPending();
    }, [ackPending, enabled, launchFlight, navOpenedByGesture, navigationOrigin, pending, stage]);

    // A second capture while settling/fading restarts from the new pending
    // (e.g. quick back-out + reopen, or a nested push mid-settle) — but only
    // when that capture's gesture actually deepened the navigation.
    useEffect(() => {
        if (!enabled || !pending || !flown || pending === flown || !navOpenedByGesture(pending)) {
            return;
        }
        launchFlight(pending);
        ackPending();
    }, [ackPending, enabled, flown, launchFlight, navOpenedByGesture, pending]);

    // Reverse flight: armed by the host right before backing out. It displaces
    // any forward-flight remnant and flies the hero elements back home.
    useEffect(() => {
        if (!exit) {
            return;
        }
        setFlown(null);
        setTargets(null);
        setExitPayload(exit);
        setNestedLanding(null);
        setNestedGaveUp(false);
        stopNestedPoll();
        clearSettleTimer();
        clearFastForwardTimer();
        acceleratedRef.current = false;
        setFastForwarding(false);
        setFfStart(null);
        setStage('exiting');
    }, [exit, clearFastForwardTimer, clearSettleTimer, stopNestedPoll]);

    // Nested-back destination poll: the previous grid remounts underneath
    // only after back is pressed, so the card this level was pushed from
    // (exit.sourceKey) cannot be measured at arm time. The hero HOLDS in place
    // over the incoming cascade until this poll finds that card — its wrapper
    // sits at the final grid slot (the fly-in animates the inner motion.div),
    // and two consecutive identical cover rects confirm it has settled — then
    // the exit springs retarget onto it. No trustworthy card by the deadline
    // → give up and fall back to the in-place shrink.
    useEffect(() => {
        if (stage !== 'exiting' || !exitPayload?.nested || !exitPayload.sourceKey) {
            return;
        }
        // Only a detail-grid card (`item:`) can reappear inside the remounted
        // grid; a home-slider handle has nothing to look for here.
        if (!exitPayload.sourceKey.startsWith('item:')) {
            return;
        }
        const startedAt = Date.now();
        const deadline = startedAt + 1800;
        let lastCoverRect: { left: number; top: number } | null = null;
        nestedPollRef.current = setInterval(() => {
            // 只在当前这一层网格里找：正在退出的那一页（例如歌手页）可能带着同一个
            // item id，文档级查询会先命中它，落点就飞到一张正在消失的卡上。
            const el = findMorphCard(exitPayload.sourceKey, 'active-grid');
            if (!el) {
                if (Date.now() > deadline) {
                    stopNestedPoll();
                    setNestedGaveUp(true);
                }
                return;
            }
            const wrapRect = el.getBoundingClientRect();
            if (wrapRect.width < 1) {
                if (Date.now() > deadline) {
                    stopNestedPoll();
                    setNestedGaveUp(true);
                }
                return;
            }
            const coverEl = el.querySelector<HTMLImageElement>('img');
            const coverRect = coverEl?.getBoundingClientRect() ?? null;
            // Wait for the card's own fly-in to settle: two consecutive
            // identical cover positions mean it has landed at its slot.
            const settled = lastCoverRect !== null && coverRect !== null
                && Math.abs(coverRect.left - lastCoverRect.left) < 1
                && Math.abs(coverRect.top - lastCoverRect.top) < 1;
            lastCoverRect = coverRect ? { left: coverRect.left, top: coverRect.top } : null;
            if (!settled) {
                if (Date.now() > deadline) {
                    stopNestedPoll();
                    setNestedGaveUp(true);
                }
                return;
            }
            stopNestedPoll();
            const titleEl = el.querySelector<HTMLElement>('h3, [data-folia-card-title], [class*="font-bold"]');
            const titleRect = titleEl?.getBoundingClientRect() ?? null;
            setNestedLanding({
                frame: { x: wrapRect.left, y: wrapRect.top, width: wrapRect.width, height: wrapRect.height },
                cover: coverRect
                    ? { x: coverRect.left, y: coverRect.top, width: coverRect.width, height: coverRect.height }
                    : { x: wrapRect.left, y: wrapRect.top, width: wrapRect.width, height: wrapRect.height },
                coverUrl: coverEl?.src ?? null,
                title: titleRect
                    ? { x: titleRect.left, y: titleRect.top, width: titleRect.width, height: titleRect.height }
                    : { x: wrapRect.left, y: wrapRect.top, width: wrapRect.width, height: wrapRect.height },
                titleText: titleEl?.textContent?.trim() ?? '',
            });
        }, HERO_POLL_INTERVAL_MS);
        return stopNestedPoll;
    }, [stage, exitPayload, stopNestedPoll]);

    // Leaving the detail view mid-forward-morph (back to home) without the host
    // having armed an exit — e.g. Escape handling — kills the overlay and its
    // plan immediately rather than waiting for the watchdog.
    useEffect(() => {
        if (
            navigationOrigin === null
            && !exit
            && (stage === 'flying' || stage === 'settling' || stage === 'fading')
        ) {
            finishLifecycle();
        }
    }, [navigationOrigin, exit, stage, finishLifecycle]);

    // Exit lifecycle: a single continuous gesture — fly home, crossfade back to the
    // home artwork and title, motion-blur out and fade away, all on the same curve.
    const handleExitComplete = useCallback(() => {
        if (stage !== 'exiting') {
            return;
        }
        // A nested back still HOLDING for its landing card: the hold animation
        // completing is not the end — wait until the poll lands the hero or
        // gives up before the lifecycle may finish.
        if (
            exitPayload?.nested
            && exitPayload.sourceKey
            && !nestedLanding
            && !nestedGaveUp
        ) {
            return;
        }
        finishLifecycle();
    }, [finishLifecycle, stage, exitPayload, nestedLanding, nestedGaveUp]);

    // Hard watchdog: the whole morph must end and consume the plan whatever
    // happens, so the detail grid can never remain in its "hero hidden +
    // staggered entrances" state.
    useEffect(() => {
        if (stage !== 'flying' && stage !== 'settling' && stage !== 'exiting') {
            return;
        }
        clearWatchdog();
        watchdogTimerRef.current = setTimeout(() => {
            watchdogTimerRef.current = null;
            finishLifecycle();
        }, WATCHDOG_MS);
        return clearWatchdog;
    }, [stage, clearWatchdog, finishLifecycle]);

    useEffect(() => {
        return () => {
            stopPolling();
            stopNestedPoll();
            clearSettleTimer();
            clearWatchdog();
            clearFastForwardTimer();
        };
    }, [clearFastForwardTimer, clearSettleTimer, clearWatchdog, stopNestedPoll, stopPolling]);

    const handleFadeComplete = useCallback(() => {
        if (stage !== 'fading') {
            return;
        }
        finishLifecycle();
    }, [finishLifecycle, stage]);

    // Scroll — or a click on the blockade — = fast-forward. The morph doubles as
    // a load cover, so when the user has already moved on the flight must
    // visibly RUSH to its landing, not flash away mid-air. Each flying element's
    // current on-screen rect is snapshotted and the remaining distance replays
    // on a compressed tween (260ms), then a quick fade ends the lifecycle and
    // releases the input blockade (~400ms total).
    const accelerate = useCallback(() => {
        if (acceleratedRef.current) {
            return;
        }
        acceleratedRef.current = true;
        if (stage === 'exiting') {
            fastForwardTimerRef.current = setTimeout(() => finishLifecycle(), 120);
            return;
        }
        if (stage === 'fading') {
            // Already dissolving — just cap the remainder.
            fastForwardTimerRef.current = setTimeout(() => finishLifecycle(), 180);
            return;
        }
        const rectOfFlight = (el: HTMLElement | null) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) return null;
            return { x: r.left, y: r.top, width: r.width, height: r.height };
        };
        const frameRect = rectOfFlight(frameFlightRef.current);
        const coverRect = rectOfFlight(coverFlightRef.current);
        const titleRect = rectOfFlight(titleFlightRef.current);
        if (!frameRect || !coverRect || !titleRect) {
            fastForwardTimerRef.current = setTimeout(() => finishLifecycle(), 120);
            return;
        }
        stopPolling();
        clearSettleTimer();
        setFfStart({ frame: frameRect, cover: coverRect, title: titleRect });
        setFastForwarding(true);
        // The compressed flight lands after FAST_FORWARD_FLIGHT_MS; hand
        // over to the (already fast) fading stage from there.
        fastForwardTimerRef.current = setTimeout(() => setStage('fading'), FAST_FORWARD_FLIGHT_MS);
    }, [stage, finishLifecycle, stopPolling, clearSettleTimer]);

    useEffect(() => {
        if (stage === 'idle') {
            return;
        }
        let dragStart: { x: number; y: number } | null = null;
        const onPointerDown = (event: PointerEvent) => {
            dragStart = { x: event.clientX, y: event.clientY };
        };
        const onPointerMove = (event: PointerEvent) => {
            if (!dragStart || event.buttons === 0) {
                return;
            }
            if (Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) > 12) {
                accelerate();
            }
        };
        const onPointerUp = () => {
            dragStart = null;
        };
        window.addEventListener('wheel', accelerate, { capture: true, passive: true });
        window.addEventListener('touchmove', accelerate, { capture: true, passive: true });
        window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
        window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
        window.addEventListener('pointerup', onPointerUp, { capture: true, passive: true });
        return () => {
            window.removeEventListener('wheel', accelerate, true);
            window.removeEventListener('touchmove', accelerate, true);
            window.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('pointermove', onPointerMove, true);
            window.removeEventListener('pointerup', onPointerUp, true);
        };
    }, [stage, accelerate]);

    // Fast-forwarded fades end on a hard timer instead of waiting for every
    // spring to settle: the composite is invisible by then, but the input
    // blockade must not outlive the accelerated flight.
    useEffect(() => {
        if (stage !== 'fading' || !fastForwarding) {
            return;
        }
        const finishTimer = setTimeout(() => finishLifecycle(), FAST_FORWARD_FINISH_MS);
        return () => clearTimeout(finishTimer);
    }, [stage, fastForwarding, finishLifecycle]);

    if (!enabled || stage === 'idle') {
        return null;
    }

    const portalRoot = typeof document !== 'undefined' ? document.body : null;
    if (!portalRoot) {
        return null;
    }

    // Reverse flight = the entrance played backwards. The hero's frame/cover/title
    // fly home while crossfading back into the home card's content; every other
    // card ghosts outward along its radial, scattering into blur — the fly-in
    // cascade in reverse. All curves share one Apple ease; opacity only
    // dissolves at the very end so the movement itself stays fully visible.
    if (stage === 'exiting' && exitPayload) {
        // Nested backs land on the pushed-from card once the remounted grid
        // renders it (nestedLanding, hunted by the poll effect) — until then
        // the hero HOLDS in place over the incoming cascade; if the poll gave
        // up it shrinks away in place as before.
        const landing: CollectionMorphGeometry | null = exitPayload.to ?? nestedLanding;
        const holding = exitPayload.nested
            && Boolean(exitPayload.sourceKey)
            && !landing
            && !nestedGaveUp;
        return createPortal(
            <MorphExitLayer
                exit={exitPayload}
                landing={landing}
                holding={holding}
                isNested={!landing}
                onSkip={accelerate}
                onExitComplete={handleExitComplete}
            />,
            portalRoot,
        );
    }

    if (!flown) {
        return null;
    }

    const start = flown;
    const estimated = estimateCenterTarget({ width: window.innerWidth, height: window.innerHeight });
    const target: CollectionMorphTarget = targets ?? {
        frame: estimated,
        cover: estimated,
        coverUrl: null,
        title: estimated,
        titleText: '',
    };
    const fading = stage === 'fading';
    // Crossfade the song content in as soon as the springs are settling, not
    // after — keeps the transition feeling like one continuous morph.
    const showHeroContent = stage === 'settling' || fading;
    // Artist destinations land on the circular avatar: the flying frame/cover
    // round themselves into a circle mid-flight instead of staying card-shaped.
    const artistLanding = navSnapshot?.stack[navSnapshot.stack.length - 1]?.type === 'artist';

    return createPortal(
        <MorphFlightLayer
            start={start}
            target={target}
            fastForwarding={fastForwarding}
            ffStart={ffStart}
            fading={fading}
            showHeroContent={showHeroContent}
            artistLanding={artistLanding}
            frameRef={frameFlightRef}
            coverRef={coverFlightRef}
            titleRef={titleFlightRef}
            onSkip={accelerate}
            onFrameAnimationComplete={() => {
                if (fading) handleFadeComplete();
            }}
        />,
        portalRoot,
    );
};

export default CollectionMorphOverlay;
