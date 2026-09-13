import { create } from 'zustand';
import { useCollectionNavigationStore } from '../../stores/useCollectionNavigationStore';

// src/components/collectionOpenMorph/collectionMorphStore.ts
// Shared-element「移形换影」transition source. A document-level capture click
// listener records the clicked home card's on-screen rectangles — the card
// frame, its cover artwork and its title line — plus the visual payload,
// without touching Grid3DSlider's own code. The payload only survives when a
// collection detail actually opens within a short observation window; a click
// that merely centers the slider discards it. The overlay then morphs every
// captured element into the counterpart on the centered hero song card, and
// hands GridView a morphPlan so the remaining song cards fly in from outside
// the viewport in sequence.

export interface CollectionMorphRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Navigation state captured when a click gesture began. */
export interface CollectionMorphNavSnapshot {
    /** Whether a collection snapshot existed when the gesture began. */
    wasOpen: boolean;
    /** Navigation stack depth when the gesture began. */
    depth: number;
}

export interface CollectionMorphPending {
    /** The whole card frame (border box) at click time. */
    frame: CollectionMorphRect;
    /** The cover <img> rectangle at click time. */
    cover: CollectionMorphRect;
    coverUrl: string | null;
    /** The title line rectangle; null when the clicked card has no title line. */
    title: CollectionMorphRect | null;
    titleText: string;
    /**
     * Stable DOM handle of the clicked card (`grid3d:<index>` for home slider
     * cards, `item:<id>` for detail grid cards). On back-out the home card is
     * re-measured through it, so the reverse flight always lands on the card's
     * CURRENT position even if the home surface re-laid-out while hidden.
     */
    sourceKey: string | null;
    /**
     * Navigation state when this click's gesture began — the pointerdown
     * signature when one preceded the click (a click-driven open changes the
     * nav store only AFTER the click; comparing against the gesture START
     * covers both orderings). The overlay launches a flight only when the
     * CURRENT navigation shows an open this gesture caused; a card click that
     * merely plays/centers never changes the signature and never morphs.
     */
    navAtGestureStart: CollectionMorphNavSnapshot;
    capturedAt: number;
}

export interface CollectionMorphHeroMeasured {
    frame: CollectionMorphRect;
    cover: CollectionMorphRect;
    coverUrl: string | null;
    title: CollectionMorphRect;
    titleText: string;
    /**
     * False while the hero's cover <img> is still in flight (network/blob
     * decode). The overlay holds its composite over the hero until the cover
     * finished — loaded OR failed — so the reveal never uncovers an empty
     * frame; that wait is what makes the morph a load cover.
     */
    coverReady: boolean;
    /**
     * True when this measurement came from the artist page's circular avatar
     * (see probeArtistIntroTargets): the overlay animates its flying cover's
     * border radius toward a circle for these landings.
     */
    round?: boolean;
}

/** Plan handed to GridView: hero stays put while other cards fly in. */
export interface CollectionMorphPlan {
    /** Hero card index inside the opened detail grid (usually 0 = center). */
    heroIndex: number;
}

/** A single surrounding card snapshot for the reverse flight's scatter. */
export interface CollectionMorphSquadGhost {
    rect: CollectionMorphRect;
    coverUrl: string | null;
    titleText: string;
}

/** Reverse-flight payload: hero → home card, armed right before backing out. */
export interface CollectionMorphExit {
    /** Live measurement of the detail hero card the overlay currently covers. */
    from: CollectionMorphHeroMeasured;
    /** The original home card rectangles to morph back onto; null for a nested
     * back (album → playlist), where the hero simply shrinks into nothing
     * instead of flying onto a nonexistent home card. */
    to: CollectionMorphPending | null;
    /** Every other visible card with its cover + title, captured the instant
     * back is pressed — replayed as real-looking ghost cards that scatter
     * outward, the reverse of the fly-in. */
    squad: CollectionMorphSquadGhost[];
    /** True when this back returns to the previous collection instead of home. */
    nested: boolean;
    /**
     * For nested backs: the sourceKey (`item:<id>`) of the card this level was
     * pushed FROM. The previous grid remounts underneath only AFTER back is
     * pressed, so the destination cannot be measured at arm time — the overlay
     * polls for this card and retargets the hero onto it once it renders.
     * Null when no trustworthy source exists (async push whose capture was
     * discarded): the hero falls back to the in-place shrink.
     */
    sourceKey: string | null;
    armedAt: number;
}

// zIndex sits above the detail backdrop (z-[49]) so the flying elements ride in
// front of it while the backdrop fades in underneath.
export const COLLECTION_MORPH_Z_INDEX = 50;
export const COLLECTION_MORPH_MIN_RECT_WIDTH = 48;
export const COLLECTION_MORPH_OBSERVATION_WINDOW_MS = 450;
// A fly-in plan auto-expires after the entrance window so a stale plan can
// never re-trigger entrances on later grid mounts. Generous enough to cover a
// remounting previous grid whose data restore takes a moment.
export const COLLECTION_MORPH_PLAN_TTL_MS = 2400;

interface CollectionMorphState {
    pending: CollectionMorphPending | null;
    /** Plan committed once the detail grid's hero card is located. */
    plan: CollectionMorphPlan | null;
    /** Last measured hero targets — the reverse-flight start point on back. */
    hero: CollectionMorphHeroMeasured | null;
    /** The home card this session's forward morph opened from; the reverse
     * flight's destination. Survives consume() of the forward payload. */
    lastHome: CollectionMorphPending | null;
    /** The card the CURRENT nesting level was pushed from (e.g. the song card
     * whose click opened the artist page); the nested back's destination.
     * lastSourceDepth records the stack depth it was captured at so a stale
     * source (async push whose capture was discarded) can never be chased. */
    lastSource: CollectionMorphPending | null;
    lastSourceDepth: number;
    /** Armed by the host right before leaving a collection. */
    exit: CollectionMorphExit | null;
    capture: (payload: CollectionMorphPending) => void;
    /** Clears an already-launched pending so it can never re-launch. */
    ackPending: () => void;
    commitPlan: (plan: CollectionMorphPlan) => void;
    setHero: (hero: CollectionMorphHeroMeasured | null) => void;
    setLastHome: (home: CollectionMorphPending) => void;
    setLastSource: (source: CollectionMorphPending, depth: number) => void;
    armExit: (from: CollectionMorphHeroMeasured, squad: CollectionMorphSquadGhost[]) => void;
    armNestedExit: (from: CollectionMorphHeroMeasured, squad: CollectionMorphSquadGhost[]) => void;
    consume: () => void;
    clear: () => void;
}

let discardTimer: ReturnType<typeof setTimeout> | null = null;
let planTtlTimer: ReturnType<typeof setTimeout> | null = null;

const cancelPlanTtl = () => {
    if (planTtlTimer !== null) {
        clearTimeout(planTtlTimer);
        planTtlTimer = null;
    }
};

const cancelDiscard = () => {
    if (discardTimer !== null) {
        clearTimeout(discardTimer);
        discardTimer = null;
    }
};

const scheduleDiscard = (clear: () => void) => {
    cancelDiscard();
    discardTimer = setTimeout(() => {
        discardTimer = null;
        clear();
    }, COLLECTION_MORPH_OBSERVATION_WINDOW_MS);
};

const resolveCardTextElement = (card: HTMLElement): HTMLElement | null => (
    card
        .querySelector<HTMLElement>('h3, [class*="font-bold"], [class*="title"]')
        ?? null
);

const rectOfElement = (el: Element | null): CollectionMorphRect | null => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: r.left, y: r.top, width: r.width, height: r.height };
};

// Locates the detail grid's hero card — the visible card closest to the
// viewport centre, which GridView puts at focusedIndex on open — and measures
// its cover image and title line, the counterparts the home card morphs into.
// Shared by the overlay (flight target) and the host (reverse-flight source).
export const probeHeroTargets = (): CollectionMorphHeroMeasured | null => {
    const wrappers = Array.from(
        document.querySelectorAll<HTMLElement>('[data-folia-grid-item-id]'),
    ).filter((el) => el.getBoundingClientRect().width > 1);
    if (wrappers.length === 0) {
        return null;
    }
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    let hero: HTMLElement | null = null;
    let bestDistSq = Infinity;
    for (const el of wrappers) {
        const r = el.getBoundingClientRect();
        const dX = r.left + r.width / 2 - cx;
        const dY = r.top + r.height / 2 - cy;
        const distSq = dX * dX + dY * dY;
        if (distSq < bestDistSq) {
            bestDistSq = distSq;
            hero = el;
        }
    }
    if (!hero) {
        return null;
    }
    const frame = rectOfElement(hero);
    const heroImg = hero.querySelector<HTMLImageElement>('img');
    const cover = rectOfElement(heroImg) ?? frame;
    const coverUrl = heroImg?.getAttribute('src') ?? null;
    const titleEl = hero.querySelector('[class*="font-bold"], [class*="line-clamp"]');
    const title = rectOfElement(titleEl) ?? frame;
    const titleText = (titleEl?.textContent ?? '').trim();
    if (!frame || !cover || !title) {
        return null;
    }
    return { frame, cover, coverUrl, title, titleText, coverReady: !heroImg || heroImg.complete };
};

// Probes the artist page's intro cluster — the circular avatar (the hero the
// clicked song card morphs onto) and the bio card's big title line. Used when
// the navigation's ACTIVE collection is an artist detail: the generic hero
// probe would instead latch onto a random song/album card somewhere off-centre.
// `round: true` tells the overlay to animate its cover's border radius toward
// a circle for this landing.
export const probeArtistIntroTargets = (): CollectionMorphHeroMeasured | null => {
    const avatarEl = document.querySelector<HTMLElement>('[data-artist-avatar]');
    if (!avatarEl) {
        return null;
    }
    const avatarImg = avatarEl.querySelector<HTMLImageElement>('img');
    const frame = rectOfElement(avatarEl);
    const cover = rectOfElement(avatarImg) ?? frame;
    const coverUrl = avatarImg?.getAttribute('src') ?? null;
    const titleEl = document.querySelector<HTMLElement>('[data-artist-bio-title]');
    const title = rectOfElement(titleEl) ?? frame;
    const titleText = (titleEl?.textContent ?? '').trim();
    if (!frame || !cover || !title) {
        return null;
    }
    return {
        frame,
        cover,
        coverUrl,
        title,
        titleText,
        coverReady: !avatarImg || avatarImg.complete,
        round: true,
    };
};

// Snapshots the nearest visible cards (except the centered hero) — with cover
// url and title — the instant the user backs out. The detail grid unmounts
// right after, so these ghosts are what the exit animation scatters outward.
// Capped at SQUAD_GHOST_LIMIT nearest cards and sorted by distance: blurred
// scatter layers are the reason exits jank, so fewer, cheaper ghosts keep the
// dissolve smooth while the backdrop handles the rest.
export const SQUAD_GHOST_LIMIT = 16;

export const probeGridSquadRects = (): CollectionMorphSquadGhost[] => {
    const wrappers = Array.from(
        document.querySelectorAll<HTMLElement>('[data-folia-grid-item-id]'),
    );
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const ghosts: Array<{ ghost: CollectionMorphSquadGhost; distSq: number }> = [];
    for (const el of wrappers) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) {
            continue;
        }
        // Skip the centered hero (distance < 100px): it has its own reverse morph.
        const dX = r.left + r.width / 2 - cx;
        const dY = r.top + r.height / 2 - cy;
        const distSq = dX * dX + dY * dY;
        if (distSq < 10000) {
            continue;
        }
        const cover = el.querySelector('img');
        const titleEl = el.querySelector('[class*="font-bold"], [class*="line-clamp"]');
        ghosts.push({
            distSq,
            ghost: {
                rect: { x: r.left, y: r.top, width: r.width, height: r.height },
                coverUrl: cover?.getAttribute('src') ?? null,
                titleText: (titleEl?.textContent ?? '').trim(),
            },
        });
    }
    return ghosts
        .sort((a, b) => a.distSq - b.distSq)
        .slice(0, SQUAD_GHOST_LIMIT)
        .map((entry) => entry.ghost);
};

// Resolves every morphable element straight off the clicked card's DOM. The
// card is a real element ([data-grid3d-index]) inside Grid3DSlider, so the
// rectangles are exact and the cover url is the same <img> the user was looking
// at — no second network fetch, no layout drift between the two views.
const captureClickedCard = (target: Element): CollectionMorphPending | null => {
    const frameRect = target.getBoundingClientRect();
    if (frameRect.width < COLLECTION_MORPH_MIN_RECT_WIDTH || frameRect.height < 1) {
        return null;
    }
    const cover = target.querySelector<HTMLImageElement>('img');
    const coverRect = cover ? cover.getBoundingClientRect() : frameRect;
    const titleEl = resolveCardTextElement(target as HTMLElement);
    const titleRect = titleEl ? titleEl.getBoundingClientRect() : null;
    const sourceKey = target instanceof HTMLElement
        ? (target.dataset.grid3dIndex !== undefined
            ? `grid3d:${target.dataset.grid3dIndex}`
            : target.dataset.foliaGridItemId !== undefined
                ? `item:${target.dataset.foliaGridItemId}`
                : null)
        : null;
    // The capture listener runs in the capture phase, BEFORE any React onClick
    // handler can update the nav store, so this is the true pre-click gesture
    // signature the overlay compares the (post-click) navigation state against.
    const navSnapshot = useCollectionNavigationStore.getState().snapshot;
    return {
        frame: { x: frameRect.left, y: frameRect.top, width: frameRect.width, height: frameRect.height },
        cover: { x: coverRect.left, y: coverRect.top, width: coverRect.width, height: coverRect.height },
        coverUrl: cover?.src ?? null,
        title: titleRect
            ? { x: titleRect.left, y: titleRect.top, width: titleRect.width, height: titleRect.height }
            : null,
        titleText: titleEl?.textContent?.trim() ?? '',
        sourceKey,
        navAtGestureStart: {
            wasOpen: Boolean(navSnapshot),
            depth: navSnapshot?.stack.length ?? 0,
        },
        capturedAt: Date.now(),
    };
};

// Re-measures the stored home card through its sourceKey. The home surface
// stays mounted (just visibility-hidden) while a collection is open, but its
// layout can still shift (player bar appearing, focus changes, slider
// re-layout) — flying back onto the click-time rectangle then lands visibly
// off (the "drifts to lower-left" symptom). Reading the live rect right before
// the reverse flight keeps the landing pixel-exact.
const refreshLastHomeRects = (): void => {
    const { lastHome } = useCollectionMorphStore.getState();
    if (!lastHome?.sourceKey) {
        return;
    }
    let el: HTMLElement | null = null;
    if (lastHome.sourceKey.startsWith('grid3d:')) {
        el = document.querySelector<HTMLElement>(
            `[data-grid3d-index="${CSS.escape(lastHome.sourceKey.slice('grid3d:'.length))}"]`,
        );
    } else if (lastHome.sourceKey.startsWith('item:')) {
        el = document.querySelector<HTMLElement>(
            `[data-folia-grid-item-id="${CSS.escape(lastHome.sourceKey.slice('item:'.length))}"]`,
        );
    }
    if (!el) {
        return;
    }
    const frameRect = el.getBoundingClientRect();
    if (frameRect.width < COLLECTION_MORPH_MIN_RECT_WIDTH || frameRect.height < 1) {
        return;
    }
    const coverRect = el.querySelector('img')?.getBoundingClientRect() ?? frameRect;
    const titleRect = resolveCardTextElement(el)?.getBoundingClientRect() ?? null;
    useCollectionMorphStore.setState({
        lastHome: {
            ...lastHome,
            frame: { x: frameRect.left, y: frameRect.top, width: frameRect.width, height: frameRect.height },
            cover: { x: coverRect.left, y: coverRect.top, width: coverRect.width, height: coverRect.height },
            title: titleRect
                ? { x: titleRect.left, y: titleRect.top, width: titleRect.width, height: titleRect.height }
                : lastHome.title,
            capturedAt: lastHome.capturedAt,
        },
    });
};

const attachCaptureListener = () => {
    if (typeof document === 'undefined') {
        return;
    }
    document.addEventListener(
        'click',
        (event) => {
            const target = event.target;
            if (!(target instanceof Element)) {
                return;
            }
            // Home 3D slider cards AND detail grid cards (nested album/artist
            // navigation) both serve as morph sources. The payload survives the
            // observation window only when a collection actually opens (or a
            // nested push lands) right after the click.
            const card = target.closest<HTMLElement>('[data-grid3d-index], [data-folia-grid-item-id]');
            if (!card) {
                return;
            }
            const payload = captureClickedCard(card);
            if (!payload) {
                return;
            }
            const store = useCollectionMorphStore.getState();
            // capture() resets pending/plan/exit but MUST NOT touch lastHome:
            // every song-card click inside a playlist flows through here (even a
            // plain play/center click), and clear() would wipe the home-card
            // landing target, silently killing the final back-out morph.
            store.capture(payload);
            scheduleDiscard(() => useCollectionMorphStore.getState().consume());
        },
        { capture: true },
    );
};

attachCaptureListener();

export const useCollectionMorphStore = create<CollectionMorphState>((set, get) => ({
    pending: null,
    plan: null,
    hero: null,
    lastHome: null,
    lastSource: null,
    lastSourceDepth: 0,
    exit: null,
    capture: (payload) => set({ pending: payload, plan: null, exit: null }),
    // ackPending only ever runs when a flight actually launched, so it also
    // cancels the observation window — otherwise the discard timer could fire
    // mid-flight and consume the live morph plan.
    ackPending: () => {
        cancelDiscard();
        set({ pending: null });
    },
    commitPlan: (plan) => {
        cancelPlanTtl();
        planTtlTimer = setTimeout(() => {
            planTtlTimer = null;
            if (get().plan) {
                set({ plan: null });
            }
        }, COLLECTION_MORPH_PLAN_TTL_MS);
        set({ plan });
    },
    setHero: (hero) => set({ hero }),
    setLastHome: (home) => set({ lastHome: home }),
    setLastSource: (source, depth) => set({ lastSource: source, lastSourceDepth: depth }),
    armExit: (from, squad) => {
        let to = get().lastHome;
        if (!to) {
            return;
        }
        // Re-measure the home card NOW: it stayed mounted (hidden) while the
        // collection was open and may have shifted; landing on stale
        // click-time rects is what made the flight drift off-target.
        refreshLastHomeRects();
        to = get().lastHome ?? to;
        cancelPlanTtl();
        set({ exit: { from, to, squad, nested: false, sourceKey: null, armedAt: Date.now() }, hero: null, plan: null });
    },
    armNestedExit: (from, squad) => {
        cancelPlanTtl();
        const depth = useCollectionNavigationStore.getState().snapshot?.stack.length ?? 0;
        const { lastSource, lastSourceDepth } = get();
        // Only a source captured for THIS nesting level may be landed on —
        // an async push whose capture was discarded must fall back to the
        // in-place shrink instead of chasing a stale card.
        const sourceKey = lastSource && lastSourceDepth === depth && depth > 1
            ? lastSource.sourceKey
            : null;
        set({ exit: { from, to: null, squad, nested: true, sourceKey, armedAt: Date.now() }, hero: null, plan: null });
    },
    // consume() intentionally keeps lastHome: the forward morph ends long before
    // the user backs out, and the reverse flight needs the original home rects.
    consume: () => {
        cancelDiscard();
        const { pending, exit } = get();
        // A capture that arrived AFTER the exit was armed belongs to the next
        // session (quick back-out + reopen while the exit still plays) — keep it
        // so the overlay launches it once the exit lifecycle finishes.
        const keepPending = pending && exit && pending.capturedAt > exit.armedAt
            ? pending
            : null;
        set({ pending: keepPending, plan: null, hero: null, exit: null });
    },
    clear: () => {
        cancelDiscard();
        set({ pending: null, plan: null, hero: null, lastHome: null, lastSource: null, lastSourceDepth: 0, exit: null });
    },
}));