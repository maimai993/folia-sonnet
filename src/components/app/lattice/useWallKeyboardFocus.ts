// src/components/app/lattice/useWallKeyboardFocus.ts

import {
    useCallback,
    useEffect,
    useRef,
    type Dispatch,
    type KeyboardEvent as ReactKeyboardEvent,
    type FocusEvent,
    type RefObject,
    type SetStateAction,
} from 'react';
import type { QueueInstance, WallMetrics } from '../../wall/layout';
import type { WallLayout } from './wallLayout';
import {
    findNearestInstance,
    pickAdjacentInstance,
    type WallDirection,
} from '../../wall/wallNavigation';
import { hasBlockingWindow } from '../../../utils/keyboardTargets';
import { useLatticePosterSelection } from './useLatticePosterSelection';
import type { LatticeTile } from './latticeModel';
import type { ActiveLatticePoster } from './useLatticePlaybackFocus';

// Keyboard layer for the wall: Escape clears card focus before leaving, while arrows walk the wall.

const ARROW_DIRECTIONS: Record<string, WallDirection> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
};

type WallKeyboardFocusOptions = {
    activePoster: ActiveLatticePoster | null;
    /** How the wall is laid out: where an arrow step may land, and the nearest copy of a tile. */
    layout: WallLayout;
    getViewportCenter: () => { x: number; y: number };
    containerRef: RefObject<HTMLDivElement | null>;
    instances: QueueInstance[];
    metrics: WallMetrics;
    rendered: Map<string, { x: number; y: number; width: number; height: number }>;
    panTo: (rect: { x: number; y: number; width: number; height: number }) => void;
    setActivePoster: Dispatch<SetStateAction<ActiveLatticePoster | null>>;
    tiles: LatticeTile[];
    worldRef: RefObject<HTMLDivElement | null>;
    onBack: () => void;
    /**
     * 墙此刻接不接 window 上的 Esc（安卓返回）：翻牌交接的进场方与稳定态接，出场那一程交给下面的资料库墙
     * ——两面墙同时在场时只有一面该响应一次返回。
     */
    backEnabled?: boolean;
};

export const useWallKeyboardFocus = ({
    activePoster,
    containerRef,
    layout,
    getViewportCenter,
    instances,
    metrics,
    panTo,
    rendered,
    setActivePoster,
    tiles,
    worldRef,
    onBack,
    backEnabled = true,
}: WallKeyboardFocusOptions) => {
    const [selection, setSelection] = useLatticePosterSelection(tiles, layout);
    const focused = selection?.instance ?? null;
    // 展开的海报与退出墙的回调：window 上那一级（安卓返回）在事件里读它们，不能读渲染时的闭包。
    const activePosterRef = useRef<ActiveLatticePoster | null>(activePoster);
    activePosterRef.current = activePoster;
    const onBackRef = useRef(onBack);
    onBackRef.current = onBack;
    // Held arrow keys fire faster than React re-renders, so the next step is computed from a ref;
    // reading state here would recompute the same hop from a value one render behind.
    const focusedRef = useRef<QueueInstance | null>(focused);
    focusedRef.current = focused;
    const pendingFocusRef = useRef(false);
    const focusWithinRef = useRef(false);
    const previousTilesRef = useRef(tiles);
    // Read through a ref: a queue edit must not give this a new identity. It is the root of the
    // per-poster handler chain, and 50+ memoised posters all re-render when that identity moves.
    const tilesRef = useRef(tiles);
    tilesRef.current = tiles;
    const adoptFocus = useCallback((instance: QueueInstance | null) => {
        focusedRef.current = instance;
        const current = tilesRef.current;
        setSelection(selected => selected?.instance === instance ? selected
            : instance && current[instance.queueIndex] ? { instance, tile: current[instance.queueIndex] } : null);
    }, [setSelection]);
    const setFocused = useCallback((instance: QueueInstance | null) => {
        pendingFocusRef.current = Boolean(instance);
        adoptFocus(instance);
    }, [adoptFocus]);

    const handleFocusCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
        focusWithinRef.current = true;
        const node = event.target.closest<HTMLElement>('[data-instance-id]');
        const instance = instances.find(item => item.instanceId === node?.dataset.instanceId);
        if (!instance) return;
        pendingFocusRef.current = false;
        adoptFocus(instance);
    }, [adoptFocus, instances]);

    const handleBlurCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
        focusWithinRef.current = event.currentTarget.contains(event.relatedTarget);
    }, []);

    const moveFocus = useCallback((direction: WallDirection) => {
        const current = focusedRef.current;
        const seed = current ?? findNearestInstance(instances, getViewportCenter());
        if (!seed) return;
        // The first arrow press only adopts what is already on screen; later ones travel.
        const next = current
            ? pickAdjacentInstance(seed, direction, layout.stepCandidates(seed), metrics, rendered)
            : seed;
        if (!next) return;

        setFocused(next);
        panTo(rendered.get(next.instanceId) ?? next);
    }, [getViewportCenter, instances, layout, metrics, panTo, rendered, setFocused]);

    // 一次 Esc：先收起展开的海报与键盘焦点，没有可收的才退出墙。键盘与安卓返回（window 那一级）共用它。
    const handleEscape = useCallback(() => {
        if (activePosterRef.current || focusedRef.current) {
            setActivePoster(null);
            setFocused(null);
            containerRef.current?.focus({ preventScroll: true });
        } else {
            onBackRef.current();
        }
        return true;
    }, [containerRef, setActivePoster, setFocused]);

    // 安卓的返回键与边缘返回手势：原生把它转成一次 Escape 派发到 window（useNativeBackButton），而墙的 Esc
    // 只挂在 .lattice-field 的 React onKeyDown 上 —— 派发到 window 的事件不经过 root container，谁也接不到，
    // 于是返回在墙上等于「没人接管」，App 直接退到后台。这里补上同一级阶梯。真实键盘的 Esc 仍先由
    // onKeyDown 处理（它 preventDefault 过，这里因 defaultPrevented 跳过）。
    useEffect(() => {
        if (!backEnabled) return undefined;
        const handleWindowKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing || event.repeat) return;
            if (event.key !== 'Escape') return;
            if (hasBlockingWindow()) return;
            if (handleEscape()) event.preventDefault();
        };
        window.addEventListener('keydown', handleWindowKeyDown);
        return () => window.removeEventListener('keydown', handleWindowKeyDown);
    }, [backEnabled, handleEscape]);

    const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        // A window opened over the wall has the keyboard, also while the focus stays on the card it was opened
        // from (the lyrics timeline takes none): its keys are not the wall's, as on the library wall and the grid.
        if (hasBlockingWindow()) return;

        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            handleEscape();
            return;
        }

        // Nested playback controls own their arrows (especially the native range input).
        if (event.target instanceof Element && event.target.closest('.lattice-poster-controls')) return;
        const direction = ARROW_DIRECTIONS[event.key];
        if (!direction) return;
        event.preventDefault();
        event.stopPropagation();
        moveFocus(direction);
    }, [containerRef, handleEscape, moveFocus]);

    // Mirrors the focused index onto the DOM so the native ring, Enter/Space and screen readers
    // follow it. Depends on `instances` because culling may not have rendered the target yet.
    //
    // The focus call waits until after this frame has painted. A key repeat commits a dozen new
    // posters, and `focus()` has to resolve style before it can tell whether its target is
    // focusable, so calling it straight from the effect forced a style recalc of the whole wall on
    // every repeat - measured at a fifth of a key's cost. After paint the browser has already done
    // that pass, so the same call finds a clean tree. A frame callback runs before style; the
    // timeout it schedules runs after, which is the earliest point that is known to be clean.
    // The ring itself is a class from the same render, so nothing visible waits on this; a held
    // key cancels each pending focus in favour of the next, and only the last poster takes it.
    useEffect(() => {
        const queueChanged = previousTilesRef.current !== tiles;
        previousTilesRef.current = tiles;
        // A new list may seat the focused card elsewhere, and the focus goes with it. Kept as a
        // pending focus: the cull may change again before the frame below (the camera follows a
        // grown card that was re-seated), and that run of this effect no longer sees a new list.
        if (focused && queueChanged && focusWithinRef.current) pendingFocusRef.current = true;
        if (!focused || !pendingFocusRef.current) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const frame = requestAnimationFrame(() => {
            timer = setTimeout(() => {
                const node = worldRef.current?.querySelector<HTMLElement>(
                    `[data-instance-id="${focused.instanceId}"]`,
                );
                if (!node) return;
                pendingFocusRef.current = false;
                if (!node.contains(document.activeElement)) node.focus({ preventScroll: true });
            }, 0);
        });
        return () => {
            cancelAnimationFrame(frame);
            if (timer !== null) clearTimeout(timer);
        };
    }, [focused, instances, tiles, worldRef]);

    // The field itself has to hold focus, or arrow keys never reach this handler.
    useEffect(() => {
        containerRef.current?.focus({ preventScroll: true });
    }, [containerRef]);

    return { focused, setFocused, handleKeyDown, handleFocusCapture, handleBlurCapture };
};
