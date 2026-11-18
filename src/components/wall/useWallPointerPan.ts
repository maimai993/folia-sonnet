// src/components/wall/useWallPointerPan.ts

import { animate } from 'framer-motion';
import { useCallback, useEffect, useRef, type MutableRefObject, type PointerEvent, type MouseEvent, type RefObject } from 'react';
import type { Bounds } from './layout';
import type { LatticeCamera } from './useWallCameraPan';
import { createWallWheelClassifier, stepWallWheel, wallWheelDelta, WALL_PAN_INERTIA, WALL_ZOOM_MOTION } from './wallPanMotion';

// Drag and wheel panning, plus pinch and Ctrl-wheel zooming. Camera writes bypass React state; only
// the cull bounds are published.
// 鼠标滚轮平滑、触控板直接跟手（判别与参数见 wallPanMotion.ts）。平滑滚动占用共享的 animationRef，
// 所以 panTo / bravais 的补间、按下拖动、键盘输入一开始就会把它停在原地；降低动效时滚轮也一帧到位。
//
// 缩放（2026-10-12）：两根手指捏合，或 Ctrl / ⌘ + 滚轮（触控板的捏合在浏览器里就是这个事件）。
// 两种手势都锚在手势中心：捏住的那个世界点在整个手势里跟着手指走，不会一放大就飘走。
// 倍率是相对墙面基准档位的（getScale / getBravaisScale 那一档），手势停下来才交回宿主，
// 所以缩放途中不经过 React，只有落定那一次 setState。

const DRAG_THRESHOLD_PX = 7;
// 两下 wheel 之间隔得比这短就算同一次手势（触控板 / 惯性约 16ms 一下；停手再滚是新手势，按光标下面的东西重新算）。
const WHEEL_LATCH_MS = 160;
// 锁定期间光标挪开超过这么多才算换了目标（墙在光标下滑动时浏览器补发的 pointermove 坐标不变）。
const LATCH_MOVE_PX = 4;

/** 缩放的宿主适配：倍率的上下限是基准档位（视口宽度断点）的倍数。 */
export type WallZoomHost = {
    /** 此刻的基准档位。缩放倍率的下限与上限是它的倍数，所以换设备 / 转屏不会失真。 */
    baseScale: () => number;
    minFactor: number;
    maxFactor: number;
    /** 手势停下来之后把倍率交回宿主（写 store 或 React state）。 */
    onZoomEnd: (factor: number) => void;
};

type WallPointerPanOptions = {
    applyCamera: (camera: LatticeCamera, updateBounds?: boolean) => void;
    animationRef: MutableRefObject<{ stop: () => void } | null>;
    stopPan: () => void;
    containerRef: RefObject<HTMLDivElement | null>;
    reducedMotion: boolean | null;
    overscan: number;
    /**
     * 离已裁剪范围的边缘还剩这么多（世界单位）就重新裁剪。必须与宿主自己判「要不要重裁」时用的边上同一个数，
     * 否则拖动这边按一个数提前触发、宿主那边按另一个数推演，边界型的断言会两边对不上（#427）。
     */
    cullEdgeMargin: number;
    /**
     * 宿主要不要钳制相机（比如有限拼贴的边界、性能优先时的行程上限）。拖动 / 滚轮 / 惯性都过这一道，
     * 键盘与播放跟随的补间不走这里 —— 它们要能把任意一张卡带到眼前。
     */
    clampCamera?: (camera: LatticeCamera) => LatticeCamera;
    bounds: Bounds;
    cameraRef: MutableRefObject<LatticeCamera>;
    getWorldBounds: (camera: LatticeCamera, viewport: { width: number; height: number }) => Bounds;
    viewportRef: MutableRefObject<{ width: number; height: number }>;
    /** 给了才接缩放手势（捏合与 Ctrl+滚轮）。 */
    zoom?: WallZoomHost;
};

export const useWallPointerPan = ({
    applyCamera, animationRef, stopPan, containerRef, reducedMotion, overscan, cullEdgeMargin, clampCamera,
    bounds, cameraRef, getWorldBounds, viewportRef, zoom,
}: WallPointerPanOptions) => {
    const boundsRef = useRef(bounds);
    boundsRef.current = bounds;
    // 钳制函数每次渲染可能是新身份，但它只在这里被读，用 ref 接住就不会把 updateCamera 的身份弄脏。
    const clampCameraRef = useRef(clampCamera);
    clampCameraRef.current = clampCamera;
    const zoomRef = useRef(zoom);
    zoomRef.current = zoom;
    const pointerRef = useRef<{
        id: number;
        start: { x: number; y: number };
        camera: { x: number; y: number };
        last: { x: number; y: number; time: number };
        vx: number;
        vy: number;
        dragged: boolean;
    } | null>(null);
    // Read by the poster click handler so a drag that ends on a card does not open it.
    const didDragRef = useRef(false);
    /** 按在墙上的每一根手指（鼠标只有一个）：两根以上才捏合。 */
    const pointersRef = useRef(new Map<number, { x: number; y: number }>());
    const pinchRef = useRef<{ ids: [number, number]; distance: number } | null>(null);
    const zoomCommitRef = useRef<number | null>(null);

    // Republishing bounds is what triggers a re-cull, so only do it near the edge of what is culled.
    const updateCamera = useCallback((x: number, y: number, scale = cameraRef.current.scale) => {
        const requested: LatticeCamera = { x, y, scale };
        const next = clampCameraRef.current ? clampCameraRef.current(requested) : requested;
        const visible = getWorldBounds(next, viewportRef.current);
        const culled = boundsRef.current;
        const padding = overscan - cullEdgeMargin;
        const nearCullEdge = visible.left < culled.left - padding
            || visible.right > culled.right + padding
            || visible.top < culled.top - padding
            || visible.bottom > culled.bottom + padding;
        applyCamera(next, nearCullEdge);
    }, [applyCamera, cameraRef, cullEdgeMargin, getWorldBounds, overscan, viewportRef]);

    const interrupt = useCallback(() => {
        stopPan();
    }, [stopPan]);

    /** 倍率夹到基准档位的上下限之间。 */
    const clampScale = useCallback((scale: number) => {
        const host = zoomRef.current;
        if (!host) return scale;
        const base = Math.max(host.baseScale(), 0.0001);
        return Math.min(base * host.maxFactor, Math.max(base * host.minFactor, scale));
    }, []);

    /**
     * 以 anchor（容器内的屏幕点）为中心改倍率：anchor 压住的那个世界点缩放后仍在 anchor 上。
     * 每帧按当前相机现算，所以夹到边界时（倍率不动）手指带着墙平移的那一份照旧生效。
     */
    const zoomAt = useCallback((factor: number, anchor: { x: number; y: number }) => {
        if (!zoomRef.current) return;
        const camera = cameraRef.current;
        const scale = clampScale(camera.scale * factor);
        if (Math.abs(scale - camera.scale) < 0.0001) return;
        const worldX = (anchor.x - camera.x) / camera.scale;
        const worldY = (anchor.y - camera.y) / camera.scale;
        interrupt();
        updateCamera(anchor.x - worldX * scale, anchor.y - worldY * scale, scale);
    }, [cameraRef, clampScale, interrupt, updateCamera]);

    /** 手势停下来才把倍率交回宿主：缩放途中每一次都交会让整面墙按帧重渲染。 */
    const commitZoom = useCallback(() => {
        if (!zoomRef.current) return;
        if (zoomCommitRef.current !== null) clearTimeout(zoomCommitRef.current);
        zoomCommitRef.current = window.setTimeout(() => {
            zoomCommitRef.current = null;
            const host = zoomRef.current;
            if (!host) return;
            host.onZoomEnd(cameraRef.current.scale / Math.max(host.baseScale(), 0.0001));
        }, WALL_ZOOM_MOTION.settleMs);
    }, [cameraRef]);

    useEffect(() => () => {
        if (zoomCommitRef.current !== null) clearTimeout(zoomCommitRef.current);
    }, []);

    const endPinch = useCallback(() => {
        if (!pinchRef.current) return;
        pinchRef.current = null;
        commitZoom();
    }, [commitZoom]);

    /** 两根手指的中心与距离；少了一根就返回 null。 */
    const pinchMetrics = () => {
        const pinch = pinchRef.current;
        if (!pinch) return null;
        const first = pointersRef.current.get(pinch.ids[0]);
        const second = pointersRef.current.get(pinch.ids[1]);
        if (!first || !second) return null;
        return {
            center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
            distance: Math.hypot(first.x - second.x, first.y - second.y),
        };
    };

    const beginPinch = useCallback(() => {
        // TEMP(#409 诊断)：捏合为什么没开始。
        console.info('[WallGesture] beginPinch zoomHost=' + Boolean(zoomRef.current), 'active=' + Boolean(pinchRef.current), 'pointers=' + pointersRef.current.size);
        if (!zoomRef.current || pinchRef.current) return false;
        // 取最早按下的两根（控件上的也算）：第三根手指参与时不再换锚点，免得中心跳一下。
        const ids = [...pointersRef.current.keys()].slice(0, 2) as [number, number];
        const first = pointersRef.current.get(ids[0]);
        const second = pointersRef.current.get(ids[1]);
        if (!first || !second) return false;
        const distance = Math.hypot(first.x - second.x, first.y - second.y);
        if (distance < WALL_ZOOM_MOTION.minPinchDistancePx) return false;
        pinchRef.current = { ids, distance };
        pointerRef.current = null;
        didDragRef.current = true;
        return true;
    }, []);

    const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
        // TEMP(#409 诊断)：确认双指事件到底有没有到达这里。验证完删掉。
        console.info('[WallGesture] down', event.pointerType, event.pointerId, 'button=' + event.button, 'zoomHost=' + Boolean(zoomRef.current));
        /*
         * 触屏上第二根手指的 button 在某些 WebView 里不是 0（是 -1 或 1）；只认 0 会让
         * 捏合的第二根手指被整条丢掉，表现就是「双指没反应」（#409）。所以触屏一律放行，
         * 鼠标仍只认左键。
         */
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        // Panning stays available while a card is open, but a drag that starts on the open card
        // belongs to its own controls - the progress bar seeks by dragging.
        // Only actual controls are excluded; the cover, title and surrounding space can pan.
        const target = event.target instanceof Element ? event.target : null;
        // 拖着走的控件（进度条）整段手势都归它，完全不认。
        if (target?.closest('[role="slider"]')) return;
        // 点一下就走的控件（按钮、链接、输入位）不拿它起拖，但**要记进手指表**：捏合要两根都在表里，
        // 有一根按在按钮上就永远捏不动 —— 用户报的「有概率无法缩放」就是这一类。
        const onControl = Boolean(target?.closest('button, input, select, textarea, a, [contenteditable="true"]'));
        const pointers = pointersRef.current;
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        // 第二根手指按下：改成捏合（单指拖动让位）。捏不动（没接缩放、距离太近）就当没这根手指。
        if (pointers.size >= 2) {
            interrupt();
            if (beginPinch()) return;
        }
        if (onControl || !event.isPrimary || pointerRef.current) return;
        interrupt();
        didDragRef.current = false;
        pointerRef.current = {
            id: event.pointerId,
            start: { x: event.clientX, y: event.clientY },
            camera: { x: cameraRef.current.x, y: cameraRef.current.y },
            last: { x: event.clientX, y: event.clientY, time: event.timeStamp },
            vx: 0, vy: 0, dragged: false,
        };
    }, [beginPinch, cameraRef, interrupt]);

    const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
        const known = pointersRef.current.get(event.pointerId);
        if (known) {
            known.x = event.clientX;
            known.y = event.clientY;
        }
        // 捏合只在第二根手指按下那一刻试是不够的：放大本来就是从「两指捏在一起」起手的，
        // 那一刻的距离小于 minPinchDistancePx，老逻辑试一次不中就不再试 —— 之后张得再开也不缩放。
        // 所以只要有两根手指按着、又还没在捏，就每次移动再试一次（试中的这一下把当时的距离记成基准，不会跳）。
        if (!pinchRef.current && pointersRef.current.size >= 2) beginPinch();
        // 捏合：按距离的变化改倍率，中心那个世界点跟着手指走。
        const pinch = pinchRef.current;
        if (pinch && (pinch.ids[0] === event.pointerId || pinch.ids[1] === event.pointerId)) {
            const metrics = pinchMetrics();
            if (!metrics || metrics.distance < 1 || pinch.distance < 1) return;
            zoomAt(metrics.distance / pinch.distance, metrics.center);
            pinch.distance = metrics.distance;
            return;
        }
        // 捏不动（距离还不够）时不让单指拖动接手：两根手指按着却还在平移，手指再张开也不会变成捏合。
        if (pointersRef.current.size >= 2) return;
        const pointer = pointerRef.current;
        if (!pointer || pointer.id !== event.pointerId) return;
        const dx = event.clientX - pointer.start.x;
        const dy = event.clientY - pointer.start.y;
        if (!pointer.dragged && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
            pointer.dragged = true;
            didDragRef.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
        }
        const elapsed = event.timeStamp - pointer.last.time;
        if (elapsed > 0) {
            pointer.vx = (event.clientX - pointer.last.x) / elapsed * 1000;
            pointer.vy = (event.clientY - pointer.last.y) / elapsed * 1000;
        }
        pointer.last = { x: event.clientX, y: event.clientY, time: event.timeStamp };
        if (pointer.dragged) updateCamera(pointer.camera.x + dx, pointer.camera.y + dy);
    }, [beginPinch, updateCamera, zoomAt]);

    // Continue along the release velocity; stale samples and cancelled gestures never coast.
    const onPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
        pointersRef.current.delete(event.pointerId);
        // 抬起一根还剩一根：结束捏合，剩下那根接着单指平移（从它此刻的位置重新起算，不再跳一下）。
        if (pinchRef.current) {
            endPinch();
            const remaining = [...pointersRef.current.entries()][0];
            if (remaining) {
                pointerRef.current = {
                    id: remaining[0],
                    start: { x: remaining[1].x, y: remaining[1].y },
                    camera: { x: cameraRef.current.x, y: cameraRef.current.y },
                    last: { x: remaining[1].x, y: remaining[1].y, time: event.timeStamp },
                    vx: 0, vy: 0,
                    // 已经算拖动过了：捏完抬手不该打开海报。
                    dragged: true,
                };
            }
            return;
        }
        const pointer = pointerRef.current;
        if (!pointer || pointer.id !== event.pointerId) return;
        pointerRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (!pointer.dragged || reducedMotion || event.timeStamp - pointer.last.time > WALL_PAN_INERTIA.staleReleaseMs) return;
        const speed = Math.hypot(pointer.vx, pointer.vy);
        if (speed < WALL_PAN_INERTIA.minSpeed) return;
        const from = cameraRef.current;
        const velocity = Math.min(speed, WALL_PAN_INERTIA.maxSpeed);
        animationRef.current = animate(0, velocity * WALL_PAN_INERTIA.power, {
            type: 'inertia', velocity, power: WALL_PAN_INERTIA.power, timeConstant: WALL_PAN_INERTIA.timeConstant,
            restDelta: WALL_PAN_INERTIA.restDelta,
            onUpdate: distance => updateCamera(from.x + distance * pointer.vx / speed, from.y + distance * pointer.vy / speed),
        });
    }, [animationRef, cameraRef, endPinch, reducedMotion, updateCamera]);

    const onPointerCancel = useCallback((event: PointerEvent<HTMLDivElement>) => {
        pointersRef.current.delete(event.pointerId);
        if (pinchRef.current) endPinch();
        if (pointerRef.current?.id !== event.pointerId) return;
        pointerRef.current = null;
        interrupt();
    }, [endPinch, interrupt]);

    const onClickCapture = useCallback((event: MouseEvent<HTMLDivElement>) => {
        if (!didDragRef.current || event.detail === 0) return;
        didDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
    }, []);

    // 平滑滚轮的状态：还没走完的屏幕位移、下一帧、上一帧的时刻。运行时它的 handle 就挂在 animationRef 上。
    const wheelRef = useRef<{
        pending: { x: number; y: number };
        frame: number | null;
        lastTime: number | null;
        handle: { stop: () => void };
    } | null>(null);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const classify = createWallWheelClassifier();
        // 交接（翻牌到另一面墙）期间不接滚轮，正在平滑的也停下：交接要按此刻的相机量磁贴位置。
        const inHandoff = () => Boolean(container.closest('[data-wall-handoff]'));
        const stopWheel = () => {
            const wheel = wheelRef.current;
            if (!wheel) return;
            if (wheel.frame !== null) cancelAnimationFrame(wheel.frame);
            wheelRef.current = null;
            if (animationRef.current === wheel.handle) animationRef.current = null;
        };
        const tick = (now: number) => {
            const wheel = wheelRef.current;
            if (!wheel) return;
            wheel.frame = null;
            if (inHandoff()) {
                stopWheel();
                return;
            }
            const dt = wheel.lastTime === null ? 1000 / 60 : now - wheel.lastTime;
            wheel.lastTime = now;
            const { step, pending } = stepWallWheel(wheel.pending, dt);
            const from = cameraRef.current;
            const requested = { x: from.x + step.x, y: from.y + step.y };
            updateCamera(requested.x, requested.y);
            // 宿主钳制了相机（bravais 有限拼贴的边界）：这个轴上剩下的位移作废，免得反向滚动要先抵掉顶在边上的那段。
            const actual = cameraRef.current;
            wheel.pending = {
                x: Math.abs(actual.x - requested.x) > 0.5 ? 0 : pending.x,
                y: Math.abs(actual.y - requested.y) > 0.5 ? 0 : pending.y,
            };
            if (wheel.pending.x === 0 && wheel.pending.y === 0) {
                stopWheel();
                return;
            }
            wheel.frame = requestAnimationFrame(tick);
        };
        // 一次滚动手势锁定在墙上：触控板双指平移时光标不动、墙在动，叠在墙上的东西（bravais 的海报缝）会滑到光标下面，
        // 之后的 wheel 落到它身上、不再经过墙——上一下 wheel 不久之前还在推墙，就接着算墙的（同浏览器原生滚动的锁定）。
        // 锁定时才在 window 上挂监听（平时不拦整页的 wheel）；隔 WHEEL_LATCH_MS 没有 wheel 或光标真的挪开了就解开——
        // 惯性还没停时把光标移到缝里的列表上再滚，滚的是列表，不是墙。
        let latch: { timer: number; x: number; y: number } | null = null;
        const releaseLatch = () => {
            if (!latch) return;
            window.clearTimeout(latch.timer);
            latch = null;
            window.removeEventListener('wheel', onLatchedWheel, { capture: true });
            window.removeEventListener('pointermove', onLatchMove, true);
        };
        const holdLatch = (event: WheelEvent) => {
            if (!latch) {
                latch = { timer: 0, x: event.clientX, y: event.clientY };
                window.addEventListener('wheel', onLatchedWheel, { passive: false, capture: true });
                window.addEventListener('pointermove', onLatchMove, true);
            }
            window.clearTimeout(latch.timer);
            latch.timer = window.setTimeout(releaseLatch, WHEEL_LATCH_MS);
        };
        const onLatchMove = (event: globalThis.PointerEvent) => {
            if (latch && Math.hypot(event.clientX - latch.x, event.clientY - latch.y) > LATCH_MOVE_PX) releaseLatch();
        };
        const onLatchedWheel = (event: WheelEvent) => {
            if (event.target instanceof Node && container.contains(event.target)) return;
            event.stopPropagation();
            onWheel(event);
        };
        const onWheel = (event: WheelEvent) => {
            // Ctrl / ⌘ + 滚轮是缩放（触控板的捏合在浏览器里就是这个事件），浏览器自己的那套页面缩放要拦掉。
            if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                if (!zoomRef.current || pointerRef.current || pinchRef.current || inHandoff()) return;
                const rect = container.getBoundingClientRect();
                zoomAt(
                    Math.exp(-event.deltaY * WALL_ZOOM_MOTION.wheelFactor),
                    { x: event.clientX - rect.left, y: event.clientY - rect.top },
                );
                commitZoom();
                return;
            }
            event.preventDefault();
            holdLatch(event);
            if (pointerRef.current || pinchRef.current || inHandoff()) return;
            const source = classify(event);
            const { dx, dy } = wallWheelDelta(event, viewportRef.current.height);
            let wheel = wheelRef.current;
            if (source === 'trackpad' || reducedMotion) {
                // 直接跟手：把还没走完的平滑位移一并补上，当帧到位（滚动总量与输入一致）。
                const carry = wheel && animationRef.current === wheel.handle ? wheel.pending : { x: 0, y: 0 };
                const from = cameraRef.current;
                stopPan();
                stopWheel();
                updateCamera(from.x + carry.x - dx, from.y + carry.y - dy);
                return;
            }
            // 鼠标滚轮：位移叠加到剩余里，正在平滑就接着追；否则先停掉别的相机动画（补间、惯性）再起一段。
            if (!wheel || animationRef.current !== wheel.handle) {
                stopPan();
                stopWheel();
                const next = {
                    pending: { x: 0, y: 0 },
                    frame: null,
                    lastTime: null,
                    handle: { stop: () => { if (wheelRef.current === next) stopWheel(); } },
                };
                wheel = next;
                wheelRef.current = next;
                animationRef.current = next.handle;
            }
            wheel.pending = { x: wheel.pending.x - dx, y: wheel.pending.y - dy };
            if (wheel.frame === null) wheel.frame = requestAnimationFrame(tick);
        };
        const cancel = () => {
            pointerRef.current = null;
            pointersRef.current.clear();
            if (pinchRef.current) endPinch();
            interrupt();
        };
        // 只按修饰键（按住 Shift 横向滚动时 Shift 会自动重复 keydown）不算键盘输入，不打断平滑滚动。
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') return;
            cancel();
        };
        const endOutside = (event: globalThis.PointerEvent) => {
            pointersRef.current.delete(event.pointerId);
            if (pinchRef.current
                && (pinchRef.current.ids[0] === event.pointerId || pinchRef.current.ids[1] === event.pointerId)) {
                endPinch();
            }
            if (pointerRef.current?.id === event.pointerId) cancel();
        };
        window.addEventListener('pointerup', endOutside);
        window.addEventListener('pointercancel', endOutside);
        container.addEventListener('wheel', onWheel, { passive: false });
        container.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('blur', cancel);
        return () => {
            container.removeEventListener('wheel', onWheel);
            releaseLatch();
            container.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('blur', cancel);
            window.removeEventListener('pointerup', endOutside);
            window.removeEventListener('pointercancel', endOutside);
            cancel();
            stopWheel();
        };
    }, [animationRef, cameraRef, commitZoom, containerRef, endPinch, interrupt, reducedMotion, stopPan, updateCamera, viewportRef, zoomAt]);

    return { didDragRef, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture };
};
