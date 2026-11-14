import { useEffect, useRef } from 'react';

// src/library/suites/rhine/useRhineGestures.ts
// 把网页层的触摸转成渲染器认识的场景命令。
//
// 列结构（`columns`）是二维的：每列一个歌单，列内是该歌单的曲目。手势也分成二维：
//   · 左右滑 → 换歌单（`axis: 'lane'`）
//   · 上下滑 → 换列内的歌（`axis: 'row'`）
//   · 横向拖动 → 旋转盒体（scene-drag）
//   · 点按     → 交给渲染器做命中（scene-pick）
//
// **只用 touch 事件**，pointer 只作兜底：
// 这一层如果让浏览器接管滚动，Chromium 会在滑动中途发 `pointercancel` 而不是
// `pointerup`（实测 down:1 / move:2 / up:0），滑动判定永远走不到。
// 真正的解法是容器上 `touch-action: none` + 直接读 touch 序列。

type Gesture = { id: number; x: number; y: number; time: number };

const SWIPE_MIN_PX = 40;
const SWIPE_MAX_MS = 900;
const TAP_MAX_PX = 14;

export const useRhineGestures = (
    enabled: boolean,
    columns: readonly (readonly string[])[],
    stage: React.RefObject<HTMLElement | null>,
    send: (command: Record<string, unknown>) => void,
): void => {
    const sendRef = useRef(send);
    sendRef.current = send;
    const columnsRef = useRef(columns);
    columnsRef.current = columns;

    useEffect(() => {
        if (!enabled) return undefined;
        const target = stage.current;
        if (!target) return undefined;

        let gesture: Gesture | null = null;
        let rotation = 0;
        let dragFrame = 0;
        let lane = 0;
        let row = 0;
        let handled = false;

        const emit = (command: Record<string, unknown>): void => { sendRef.current(command); };

        const selectedId = (nextLane: number, nextRow: number): string | null => {
            const board = columnsRef.current;
            const laneIds = board[nextLane];
            if (!laneIds?.length) return null;
            return laneIds[Math.min(nextRow, laneIds.length - 1)] ?? null;
        };

        const begin = (id: number, x: number, y: number): void => {
            if (gesture) return;
            handled = false;
            gesture = { id, x, y, time: performance.now() };
        };

        const move = (id: number, x: number, y: number): void => {
            if (!gesture || gesture.id !== id) return;
            if (Math.abs(x - gesture.x) < 10) return;
            rotation = Math.max(-1.1, Math.min(1.1, (x - gesture.x) * 0.005));
            if (!dragFrame) {
                dragFrame = requestAnimationFrame(() => {
                    dragFrame = 0;
                    emit({ type: 'scene-drag', rotation });
                });
            }
        };

        const finish = (id: number, x: number, y: number): void => {
            const startPoint = gesture;
            if (!startPoint || startPoint.id !== id) return;
            gesture = null;
            if (dragFrame) { cancelAnimationFrame(dragFrame); dragFrame = 0; }
            if (handled) return;
            handled = true;

            const dx = x - startPoint.x;
            const dy = y - startPoint.y;
            const elapsed = performance.now() - startPoint.time;
            const distance = Math.hypot(dx, dy);

            if (distance < TAP_MAX_PX) {
                /*
                 * 单击直接命中。
                 *
                 * **不要**用 `#root` 的 getBoundingClientRect 算比例：这个外壳的高度是 0
                 * （实测 `{ w: 480, h: 0 }`），除出来是 Infinity，`<= 1` 永远不成立，
                 * 于是 scene-pick 一次都发不出去 —— 表现就是「点了完全没反应」。
                 */
                const px = x / Math.max(1, window.innerWidth);
                const py = y / Math.max(1, window.innerHeight);
                if (px >= 0 && px <= 1 && py >= 0 && py <= 1) {
                    console.info('[rhine] tap -> scene-pick', { x: Number(px.toFixed(3)), y: Number(py.toFixed(3)) });
                    emit({ type: 'scene-pick', x: px, y: py });
                }
                return;
            }
            if (elapsed > SWIPE_MAX_MS) return;

            const board = columnsRef.current;
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) >= SWIPE_MIN_PX) {
                const filled = board.map((ids, index) => (ids.length ? index : -1)).filter(index => index >= 0);
                if (!filled.length) return;
                const currentFilled = Math.max(0, filled.indexOf(lane));
                const direction = dx < 0 ? 1 : -1;
                const nextFilled = currentFilled + direction;
                if (nextFilled < 0 || nextFilled >= filled.length) return;
                lane = filled[nextFilled];
                row = 0;
                const id2 = selectedId(lane, row);
                if (id2) emit({ type: 'scene-select', albumId: id2, axis: 'lane', direction });
            } else if (Math.abs(dy) >= SWIPE_MIN_PX) {
                const laneIds = board[lane] ?? [];
                if (laneIds.length <= 1) return;
                const direction = dy < 0 ? 1 : -1;
                const nextRow = row + direction;
                if (nextRow < 0 || nextRow >= laneIds.length) return;
                row = nextRow;
                const id2 = selectedId(lane, row);
                if (id2) emit({ type: 'scene-select', albumId: id2, axis: 'row', direction });
            }
        };

        const cancel = (): void => {
            gesture = null;
            if (dragFrame) { cancelAnimationFrame(dragFrame); dragFrame = 0; }
        };

        // ---- touch：主路径 ----
        const onTouchStart = (event: TouchEvent): void => {
            const touch = event.changedTouches[0];
            if (!touch) return;
            begin(touch.identifier, touch.clientX, touch.clientY);
        };
        const onTouchMove = (event: TouchEvent): void => {
            const touch = event.changedTouches[0];
            if (!touch) return;
            move(touch.identifier, touch.clientX, touch.clientY);
        };
        const onTouchEnd = (event: TouchEvent): void => {
            const touch = event.changedTouches[0];
            if (!touch) return;
            finish(touch.identifier, touch.clientX, touch.clientY);
        };

        // ---- pointer：兜底（某些输入法只派发 pointer） ----
        const onPointerDown = (event: PointerEvent): void => {
            if (!event.isPrimary) return;
            begin(event.pointerId, event.clientX, event.clientY);
        };
        const onPointerMove = (event: PointerEvent): void => { move(event.pointerId, event.clientX, event.clientY); };
        const onPointerUp = (event: PointerEvent): void => { finish(event.pointerId, event.clientX, event.clientY); };

        target.addEventListener('touchstart', onTouchStart, { passive: true });
        target.addEventListener('touchmove', onTouchMove, { passive: true });
        target.addEventListener('touchend', onTouchEnd, { passive: true });
        target.addEventListener('touchcancel', cancel, { passive: true });
        target.addEventListener('pointerdown', onPointerDown);
        target.addEventListener('pointermove', onPointerMove);
        target.addEventListener('pointerup', onPointerUp);
        target.addEventListener('pointercancel', cancel);
        return () => {
            target.removeEventListener('touchstart', onTouchStart);
            target.removeEventListener('touchmove', onTouchMove);
            target.removeEventListener('touchend', onTouchEnd);
            target.removeEventListener('touchcancel', cancel);
            target.removeEventListener('pointerdown', onPointerDown);
            target.removeEventListener('pointermove', onPointerMove);
            target.removeEventListener('pointerup', onPointerUp);
            target.removeEventListener('pointercancel', cancel);
            cancel();
        };
    }, [enabled, stage]);
};
