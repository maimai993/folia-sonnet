import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, type Transition } from 'framer-motion';
import { useCollectionNavigationStore } from '../../stores/useCollectionNavigationStore';
import {
    COLLECTION_MORPH_Z_INDEX,
    probeArtistIntroTargets,
    probeHeroTargets,
    useCollectionMorphStore,
    type CollectionMorphHeroMeasured,
    type CollectionMorphPending,
    type CollectionMorphRect,
    type CollectionMorphSquadGhost,
} from './collectionMorphStore';

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
// Timing contract (kept snappy and self-terminating): springs fly fast toward
// live hero measurements polled on a throttled schedule; if the hero never
// renders the lifecycle still runs to consume, and a hard watchdog guarantees
// the morph plan can never leave the detail grid stuck with its hero hidden.

type MorphStage = 'idle' | 'flying' | 'settling' | 'fading' | 'exiting';

// Springy-but-controlled: a visible overshoot (~2-4%) on arrival that breathes
// back flat, without any extra oscillation tail. Stiffer/faster than before:
// the morph now doubles as a load cover, so the flight must feel snappy.
const MORPH_SPRING = { type: 'spring', stiffness: 420, damping: 24, mass: 0.85 } as const;
// Exit springs breathe the same way on the way OUT: a little rebound at launch
// and a soft settle into the home card.
const EXIT_SPRING = { type: 'spring', stiffness: 420, damping: 22, mass: 0.8 } as const;
// Apple-style exit curve for dissolves (opacity/backdrop still breathe on this).
const EXIT_EASE = [0.32, 0.72, 0, 1] as const;
const EXIT_DURATION_SECONDS = 0.5;
const EXIT_BACKDROP_SECONDS = 0.62;
const FADE_DURATION_SECONDS = 0.18;
const CROSSFADE_SECONDS = 0.28;
const SETTLE_AFTER_TARGET_MS = 180;
// Fast-forwarded flights replay the REMAINING distance on this compressed
// tween — the user sees the morph visibly rush to its landing instead of an
// opacity flash. Sequential: flight → quick fade → finish.
const FAST_FORWARD_TWEEN: Transition = { duration: 0.26, ease: [0.22, 1, 0.36, 1] };
const FAST_FORWARD_FLIGHT_MS = 260;
const FAST_FORWARD_FADE_SECONDS = 0.1;
// …and the whole accelerated lifecycle ends on this hard timer so the input
// blockade never outlives it.
const FAST_FORWARD_FINISH_MS = 140;
const HERO_POLL_INTERVAL_MS = 120;
// The outgoing grid keeps its cards in the DOM while its AnimatePresence exit
// plays. Probing before it unmounts measures the OLD grid's hero, so the morph
// retargets onto the wrong card — only a source card that happened to sit dead
// centre lined up. Wait out the exit window before the first probe.
const HERO_POLL_START_DELAY_MS = 420;
const HERO_POLL_MAX_MS = 2400;
// Absolute watchdog: beyond this the store is consumed whatever happens.
const WATCHDOG_MS = 3000;

// First estimated destination while the track list is still loading: the
// viewport centre sized like the strip's typical centered card.
const estimateCenterTarget = (): CollectionMorphRect => {
    const size = Math.min(Math.max(window.innerWidth * 0.18, 160), 280);
    return {
        x: window.innerWidth / 2 - size / 2,
        y: window.innerHeight / 2 - size * 0.58,
        width: size,
        height: size * 1.16,
    };
};

// FLIP with a center origin: the element renders at its START rect (static
// style) and animates a pure translate+scale onto the destination — a
// compositor-only path, so no frame of the flight forces layout or repaint
// (animating left/top/width/height re-layouts every frame). Center origin
// keeps rotation arcs identical to the pre-FLIP version, and expressing the
// destination as transform VALUES means a mid-flight retarget from the hero
// poll simply hands the springs new numbers to converge on — same curve,
// zero discontinuity.
const flipTo = (start: CollectionMorphRect, target: CollectionMorphRect) => ({
    x: target.x + target.width / 2 - (start.x + start.width / 2),
    y: target.y + target.height / 2 - (start.y + start.height / 2),
    scaleX: start.width > 0 ? target.width / start.width : 1,
    scaleY: start.height > 0 ? target.height / start.height : 1,
});

// Transform values that pin an element (rendered at its `base` rect) onto the
// on-screen `rect` it occupied at fast-forward time — the compressed replay
// continues from exactly where the spring was, with no rewind to the start.
const flipFromRect = (rect: CollectionMorphRect, base: CollectionMorphRect) => ({
    x: rect.x + rect.width / 2 - (base.x + base.width / 2),
    y: rect.y + rect.height / 2 - (base.y + base.height / 2),
    scaleX: base.width > 0 ? rect.width / base.width : 1,
    scaleY: base.height > 0 ? rect.height / base.height : 1,
});

export const CollectionMorphOverlay: React.FC = () => {
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
    const [targets, setTargets] = useState<{
        frame: CollectionMorphRect;
        cover: CollectionMorphRect;
        coverUrl: string | null;
        title: CollectionMorphRect;
        titleText: string;
    } | null>(null);
    const [exitPayload, setExitPayload] = useState<ReturnType<typeof useCollectionMorphStore.getState>['exit']>(null);
    // True once a scroll fast-forwarded the flight: fades snap shut and the
    // lifecycle ends on a hard timer so the input blockade is released fast.
    const [fastForwarding, setFastForwarding] = useState(false);
    // On-screen rects of the three flying elements at fast-forward time — the
    // compressed replay starts from these, continuing mid-flight instead of
    // rewinding or flashing away.
    const [ffStart, setFfStart] = useState<{
        frame: CollectionMorphRect;
        cover: CollectionMorphRect;
        title: CollectionMorphRect;
    } | null>(null);
    const frameFlightRef = useRef<HTMLDivElement | null>(null);
    const coverFlightRef = useRef<HTMLDivElement | null>(null);
    const titleFlightRef = useRef<HTMLDivElement | null>(null);
    // Latches on the first scroll intent so repeated wheel ticks never restart
    // or extend the accelerated flight; reset when the lifecycle ends.
    const acceleratedRef = useRef(false);
    // Nested-back landing: the remounted previous grid's card this level was
    // pushed from (e.g. the song card that opened the artist page). It cannot
    // be measured at arm time — the previous grid remounts only AFTER back is
    // pressed — so a poll hunts it and the exit springs retarget onto it.
    const [nestedLanding, setNestedLanding] = useState<CollectionMorphPending | null>(null);
    const [nestedGaveUp, setNestedGaveUp] = useState(false);
    const nestedPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // When the current flight launched — gates the first hero probe past the
    // outgoing grid's exit window (see startPolling).
    const flightStartedAtRef = useRef(0);

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

    const finishLifecycle = useCallback(() => {
        stopPolling();
        stopNestedPoll();
        clearSettleTimer();
        clearWatchdog();
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
    }, [clearSettleTimer, clearWatchdog, consume, stopNestedPoll, stopPolling]);

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
        if (!targets || (stage !== 'flying' && stage !== 'settling')) {
            return;
        }
        if (stage === 'flying') {
            armSettle();
        }
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

    const startPolling = useCallback(() => {
        stopPolling();
        // Delay the first probe past the outgoing grid's exit animation: its
        // cards are still in the DOM until then and would be mistaken for the
        // new hero. The flight glides toward the estimated centre meanwhile and
        // the spring retargets once the real hero is measured.
        const deadline = Date.now() + HERO_POLL_START_DELAY_MS + HERO_POLL_MAX_MS;
        pollTimerRef.current = setInterval(() => {
            if (Date.now() - (flightStartedAtRef.current || Date.now()) < HERO_POLL_START_DELAY_MS) {
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
            if (found && found.coverReady) {
                setTargets(found);
                setHero(found);
                stopPolling();
                return;
            }
            if (Date.now() > deadline) {
                // Never hang the lifecycle: fall back to the estimate and let
                // the animation finish + consume so the grid is always usable.
                stopPolling();
                if (!useCollectionMorphStore.getState().plan) {
                    return;
                }
                armSettle();
            }
        }, HERO_POLL_INTERVAL_MS);
    }, [armSettle, setHero, stopPolling]);

    const launchFlight = useCallback((payload: CollectionMorphPending) => {
        setFlown(payload);
        setTargets(null);
        setExitPayload(null);
        clearSettleTimer();
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
        // The hero index in GridView is always the centered first track.
        commitPlan({ heroIndex: 0 });
        setStage('flying');
        startPolling();
    }, [clearSettleTimer, commitPlan, setLastHome, setLastSource, startPolling]);

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
            navigationOrigin !== 'home'
            || !pending
            || stage !== 'idle'
            || !navOpenedByGesture(pending)
        ) {
            return;
        }
        launchFlight(pending);
        ackPending();
    }, [ackPending, launchFlight, navOpenedByGesture, navigationOrigin, pending, stage]);

    // A second capture while settling/fading restarts from the new pending
    // (e.g. quick back-out + reopen, or a nested push mid-settle) — but only
    // when that capture's gesture actually deepened the navigation.
    useEffect(() => {
        if (!pending || !flown || pending === flown || !navOpenedByGesture(pending)) {
            return;
        }
        launchFlight(pending);
        ackPending();
    }, [ackPending, flown, launchFlight, navOpenedByGesture, pending]);

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
        setStage('exiting');
    }, [exit, clearSettleTimer, stopNestedPoll]);

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
        const id = exitPayload.sourceKey.startsWith('item:')
            ? exitPayload.sourceKey.slice('item:'.length)
            : null;
        if (!id) {
            return;
        }
        const startedAt = Date.now();
        const deadline = startedAt + 1800;
        let lastCoverRect: { left: number; top: number } | null = null;
        nestedPollRef.current = setInterval(() => {
            const el = document.querySelector<HTMLElement>(
                `[data-folia-grid-item-id="${CSS.escape(id)}"]`,
            );
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
            const titleEl = el.querySelector<HTMLElement>('h3, [class*="font-bold"], [class*="title"]');
            const titleRect = titleEl?.getBoundingClientRect() ?? null;
            setNestedLanding({
                frame: { x: wrapRect.left, y: wrapRect.top, width: wrapRect.width, height: wrapRect.height },
                cover: coverRect
                    ? { x: coverRect.left, y: coverRect.top, width: coverRect.width, height: coverRect.height }
                    : { x: wrapRect.left, y: wrapRect.top, width: wrapRect.width, height: wrapRect.height },
                coverUrl: coverEl?.src ?? null,
                title: titleRect
                    ? { x: titleRect.left, y: titleRect.top, width: titleRect.width, height: titleRect.height }
                    : null,
                titleText: titleEl?.textContent?.trim() ?? '',
                sourceKey: exitPayload.sourceKey,
                navAtGestureStart: { wasOpen: true, depth: 0 },
                capturedAt: Date.now(),
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
        };
    }, [clearSettleTimer, clearWatchdog, stopNestedPoll, stopPolling]);

    const handleFadeComplete = useCallback(() => {
        if (stage !== 'fading') {
            return;
        }
        finishLifecycle();
    }, [finishLifecycle, stage]);

    // Scroll = fast-forward. The morph doubles as a load cover, so when the
    // user scrolls mid-flight they have already moved on — but the flight
    // must visibly RUSH to its landing, not flash away mid-air. Each flying
    // element's current on-screen rect is snapshotted and the remaining
    // distance replays on a compressed tween (260ms), then a quick fade ends
    // the lifecycle and releases the input blockade (~400ms total).
    useEffect(() => {
        if (stage === 'idle') {
            return;
        }
        let finishTimer: ReturnType<typeof setTimeout> | null = null;
        const accelerate = () => {
            if (acceleratedRef.current) {
                return;
            }
            acceleratedRef.current = true;
            if (stage === 'exiting') {
                finishTimer = setTimeout(() => finishLifecycle(), 120);
                return;
            }
            if (stage === 'fading') {
                // Already dissolving — just cap the remainder.
                finishTimer = setTimeout(() => finishLifecycle(), 180);
                return;
            }
            const rectOfFlight = (el: HTMLElement | null): CollectionMorphRect | null => {
                if (!el) return null;
                const r = el.getBoundingClientRect();
                if (r.width < 1 || r.height < 1) return null;
                return { x: r.left, y: r.top, width: r.width, height: r.height };
            };
            const frameRect = rectOfFlight(frameFlightRef.current);
            const coverRect = rectOfFlight(coverFlightRef.current);
            const titleRect = rectOfFlight(titleFlightRef.current);
            if (!frameRect || !coverRect || !titleRect) {
                finishTimer = setTimeout(() => finishLifecycle(), 120);
                return;
            }
            stopPolling();
            clearSettleTimer();
            setFfStart({ frame: frameRect, cover: coverRect, title: titleRect });
            setFastForwarding(true);
            // The compressed flight lands after FAST_FORWARD_FLIGHT_MS; hand
            // over to the (already fast) fading stage from there.
            finishTimer = setTimeout(() => setStage('fading'), FAST_FORWARD_FLIGHT_MS);
        };
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
            if (finishTimer !== null) {
                clearTimeout(finishTimer);
            }
            window.removeEventListener('wheel', accelerate, true);
            window.removeEventListener('touchmove', accelerate, true);
            window.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('pointermove', onPointerMove, true);
            window.removeEventListener('pointerup', onPointerUp, true);
        };
    }, [stage, finishLifecycle, stopPolling, clearSettleTimer]);

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

    if (stage === 'idle') {
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
        const heroRect = exitPayload.from;
        // Nested backs land on the pushed-from card once the remounted grid
        // renders it (nestedLanding, hunted by the poll effect) — until then
        // the hero HOLDS in place over the incoming cascade; if the poll gave
        // up it shrinks away in place as before.
        const landing = exitPayload.to ?? nestedLanding;
        const holding = exitPayload.nested
            && Boolean(exitPayload.sourceKey)
            && !landing
            && !nestedGaveUp;
        const isNested = !landing;
        // Nested back WITH a landing: fly onto the pushed-from card; top-level
        // back: fly onto the original home card.
        const homeRect: CollectionMorphRect = landing?.frame ?? heroRect.frame;
        const homeCover: CollectionMorphRect = landing?.cover ?? heroRect.cover;
        const homeTitle: CollectionMorphRect = landing?.title ?? heroRect.title;
        const key = `exit-${exitPayload.armedAt}`;
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight / 2;
        const reach = Math.hypot(window.innerWidth, window.innerHeight) * 0.62 + 160;
        const squadMaxDist = Math.max(
            1,
            ...exitPayload.squad.map((ghost) => Math.hypot(
                ghost.rect.x + ghost.rect.width / 2 - cx,
                ghost.rect.y + ghost.rect.height / 2 - cy,
            )),
        );
        return (
            portalRoot && createPortal(
                <>
                    {/* Same input blockade as the forward flight — the exit is
                        short, and a stray click mid-flight must not re-trigger
                        navigation underneath the scattering cards. */}
                    <div
                        data-folia-collection-morph="input-blocker"
                        aria-hidden="true"
                        className="fixed inset-0"
                        style={{ zIndex: COLLECTION_MORPH_Z_INDEX + 10, pointerEvents: 'auto' }}
                    />
                    <motion.div
                        key={`${key}-backdrop`}
                        data-folia-collection-morph="exit-backdrop"
                        className="fixed inset-0 pointer-events-none"
                        style={{ zIndex: COLLECTION_MORPH_Z_INDEX - 1, background: 'var(--bg-color)' }}
                        initial={{ opacity: 1 }}
                        animate={{ opacity: 0 }}
                        transition={{ duration: EXIT_BACKDROP_SECONDS, ease: [...EXIT_EASE] }}
                    />
                    {/* Surrounding cards scatter outward — the fly-in in reverse,
                        replayed as their real covers so the exit reads as the
                        grid itself dissolving instead of empty frames. */}
                    {exitPayload.squad.map((ghost, index) => {
                        const rect = ghost.rect;
                        const dX = rect.x + rect.width / 2 - cx;
                        const dY = rect.y + rect.height / 2 - cy;
                        const distance = Math.hypot(dX, dY);
                        const direction = distance > 1
                            ? { x: dX / distance, y: dY / distance }
                            : { x: 0, y: -1 };
                        // Deterministic jitter from the rect so the scatter
                        // breathes like the entrance instead of sweeping.
                        const seed = ((Math.round(rect.x) * 73856093) ^ (Math.round(rect.y) * 19349663)) >>> 0;
                        const jitter = ((seed % 1000) / 1000 - 0.5) * 0.08;
                        const normalized = Math.min(distance / squadMaxDist, 1);
                        // Farther ghosts leave sooner and faster: a depth wave
                        // rolls outward from the hero instead of a uniform sweep.
                        const duration = 0.46 + normalized * 0.3;
                        return (
                            <motion.div
                                key={`${key}-squad-${index}`}
                                data-folia-collection-morph="squad"
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
                    {/* Hero frame flies straight back onto the home card. While
                        a nested back waits for its landing card, it holds in
                        place (opacity 1) over the incoming cascade instead of
                        dissolving before the destination exists. */}
                    <motion.div
                        key={`${key}-frame`}
                        data-folia-collection-morph="frame"
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
                        initial={{ x: 0, y: 0, scaleX: 1, scaleY: 1, scale: 1, opacity: 1, borderRadius: heroRect.round ? '50%' : undefined }}
                        animate={holding
                            ? {
                                x: 0,
                                y: 0,
                                scaleX: 1,
                                scaleY: 1,
                                scale: 0.97,
                                borderRadius: heroRect.round ? '50%' : undefined,
                                opacity: 1,
                            }
                            : {
                                ...flipTo(heroRect.frame, homeRect),
                                scale: isNested ? 0.8 : 0.985,
                                // From the artist's circular avatar: keep the circle
                                // while shrinking away in place, round back into the
                                // landing card's corners when flying onto it.
                                borderRadius: heroRect.round
                                    ? (isNested ? '50%' : '16px')
                                    : undefined,
                                opacity: [1, 1, 0],
                            }}
                        transition={{
                            ...EXIT_SPRING,
                            opacity: { duration: EXIT_DURATION_SECONDS, times: [0, 0.72, 1], ease: 'easeOut' },
                        }}
                        onAnimationComplete={handleExitComplete}
                    />
                    {/* Cover crossfades back into the home artwork mid-flight. */}
                    <motion.div
                        key={`${key}-cover`}
                        data-folia-collection-morph="cover"
                        className="fixed overflow-hidden rounded-xl pointer-events-none"
                        style={{
                            zIndex: COLLECTION_MORPH_Z_INDEX + 2,
                            left: heroRect.cover.x,
                            top: heroRect.cover.y,
                            width: heroRect.cover.width,
                            height: heroRect.cover.height,
                            willChange: 'transform, opacity, filter',
                        }}
                        initial={{ x: 0, y: 0, scaleX: 1, scaleY: 1, scale: 1, rotate: 0, filter: 'blur(0px)', opacity: 1, borderRadius: heroRect.round ? '50%' : undefined }}
                        animate={holding
                            ? {
                                x: 0,
                                y: 0,
                                scaleX: 1,
                                scaleY: 1,
                                scale: 0.96,
                                rotate: 0,
                                filter: 'blur(0px)',
                                borderRadius: heroRect.round ? '50%' : undefined,
                                opacity: 1,
                            }
                            : {
                                ...flipTo(heroRect.cover, homeCover),
                                scale: isNested ? 0.78 : 1,
                                rotate: [0, 5, 1.6],
                                // Artist avatar exit: the circle un-rounds back into
                                // the landing card's cover on the way home.
                                borderRadius: heroRect.round
                                    ? (isNested ? '50%' : '12px')
                                    : undefined,
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
                </>,
                portalRoot,
            )
        );
    }

    if (!flown) {
        return null;
    }

    const start = flown;
    const target = targets ?? {
        frame: estimateCenterTarget(),
        cover: estimateCenterTarget(),
        coverUrl: null,
        title: estimateCenterTarget(),
        titleText: '',
    };
    const fading = stage === 'fading';
    // Crossfade the song content in as soon as the springs are settling, not
    // after — keeps the transition feeling like one continuous morph.
    const showHeroContent = stage === 'settling' || fading;
    // Fast-forwarded flights snap their fades shut instead of dissolving.
    const fadeSeconds = fastForwarding ? FAST_FORWARD_FADE_SECONDS : FADE_DURATION_SECONDS;
    // Artist destinations land on the circular avatar: the flying frame/cover
    // round themselves into a circle mid-flight instead of staying card-shaped.
    const artistLanding = navSnapshot?.stack[navSnapshot.stack.length - 1]?.type === 'artist';

    return createPortal(
        <>
            {/* Input blockade for the flight's duration: the morph is a load
                cover, so interaction waits a beat. Scrolling fast-forwards the
                flight (see the wheel effect), which releases this within
                FAST_FORWARD_FINISH_MS — the delay is always short. */}
            <div
                data-folia-collection-morph="input-blocker"
                aria-hidden="true"
                className="fixed inset-0"
                style={{ zIndex: COLLECTION_MORPH_Z_INDEX + 10, pointerEvents: 'auto' }}
            />
            {/* Card frame: the whole border box glides and resizes onto the hero
                card, lifting slightly (scale) then settling flat. */}
            <motion.div
                key={`morph-frame-${start.capturedAt}${fastForwarding ? '-ff' : ''}`}
                ref={frameFlightRef}
                data-folia-collection-morph="frame"
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
                    borderRadius: artistLanding ? '50%' : undefined,
                    opacity: fading ? 0 : 1,
                }}
                transition={{
                    ...(fastForwarding ? FAST_FORWARD_TWEEN : MORPH_SPRING),
                    opacity: { duration: fadeSeconds, ease: 'easeOut' },
                }}
                onAnimationComplete={() => {
                    if (fading) handleFadeComplete();
                }}
            />
            {/* Cover: the same <img> the user clicked gliding onto the hero cover
                with a whisper of rotation; motion blur sharpens to zero as it
                lands, then the song artwork crossfades in. */}
            <motion.div
                key={`morph-cover-${start.capturedAt}${fastForwarding ? '-ff' : ''}`}
                ref={coverFlightRef}
                data-folia-collection-morph="cover"
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
                    borderRadius: artistLanding ? '50%' : undefined,
                    filter: 'blur(0px)',
                    opacity: fading ? 0 : 1,
                }}
                transition={{
                    ...(fastForwarding ? FAST_FORWARD_TWEEN : MORPH_SPRING),
                    opacity: { duration: fadeSeconds, ease: 'easeOut' },
                }}
            >
                {start.coverUrl ? (
                    <img src={start.coverUrl} alt="" className="absolute inset-0 w-full h-full object-cover" draggable={false} />
                ) : (
                    <div className="absolute inset-0 bg-zinc-800/40" />
                )}
                {targets?.coverUrl ? (
                    <img
                        src={targets.coverUrl}
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
                key={`morph-title-${start.capturedAt}${fastForwarding ? '-ff' : ''}`}
                ref={titleFlightRef}
                data-folia-collection-morph="title"
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
                    ...(fastForwarding ? FAST_FORWARD_TWEEN : MORPH_SPRING),
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
        </>,
        portalRoot,
    );
};

export default CollectionMorphOverlay;