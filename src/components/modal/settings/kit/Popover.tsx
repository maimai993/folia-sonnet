import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { POPOVER_GUTTER, placePopover, type PopoverAlign, type PopoverPlace, type PopoverSide } from './popoverPlace';
import { GlassLayer } from './GlassLayer';

// src/components/modal/settings/kit/Popover.tsx
// A layer that opens from a control: a menu, a grid of pictures, a colour picker. It is drawn in
// the window its anchor is in (the nearest ancestor with the class st-window, which must be
// positioned), so no card clips it and it has the kit's variables; it is placed under or over the
// anchor and kept inside that window. Where the window leaves less room than the layer needs, the
// layer scrolls inside itself; a child that can shrink (min-h-0) scrolls in its place.
//
// It closes on Escape, on a press outside it, when focus leaves it, when something its anchor is in
// scrolls, and when the window changes size. Opening moves focus into it; closing gives focus that
// is still inside it back to the anchor. The caller keeps `open`, and marks the anchor with
// aria-haspopup and aria-expanded. The children stay while the layer leaves: do not render them by
// `open`.
//
// Two limits. The anchor must be something that takes focus (a button). A control inside the layer
// that draws a list of its own outside it (the kit's Select) closes the layer when that list is
// pressed: do not put one in here.

/** What takes focus by Tab. */
const TABBABLE = ':is(button, [href], input, select, textarea, [tabindex]):not([tabindex="-1"], :disabled)';

type PopoverProps = {
    /** The control the layer opens from. */
    anchorRef: React.RefObject<HTMLElement | null>;
    open: boolean;
    /** Asked for by everything that closes the layer; the caller sets `open` to false. */
    onClose: () => void;
    /** The side of the anchor to open on; the other one is taken where this one is too short. */
    side?: PopoverSide;
    /** The edge of the anchor the layer lines up with. */
    align?: PopoverAlign;
    /** As wide as the window, less a gutter at both sides. */
    fill?: boolean;
    /** What takes focus on opening; without it, the first part that Tab would reach. */
    focusRef?: React.RefObject<HTMLElement | null>;
    id?: string;
    role?: React.AriaRole;
    'aria-label'?: string;
    /** For the layer itself: its padding, a larger radius. */
    className?: string;
    children: React.ReactNode;
};

export const Popover: React.FC<PopoverProps> = ({
    anchorRef, open, onClose, side = 'under', align = 'start', fill = false, focusRef, className = '', children, ...naming
}) => {
    const layerRef = useRef<HTMLDivElement>(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    // The window the anchor is in: the layer is drawn in it and placed against it.
    const [host, setHost] = useState<HTMLElement | null>(null);
    const [place, setPlace] = useState<PopoverPlace | null>(null);
    // A closed layer stays for as long as it takes to leave.
    const [present, setPresent] = useState(open);
    if (open && !present) {
        setPresent(true);
    }

    useLayoutEffect(() => {
        setHost(anchorRef.current?.closest<HTMLElement>('.st-window') ?? null);
    }, [anchorRef, open]);

    // Opening: the layer is in the window by now and has its own size. Before the paint it is
    // placed, takes focus, and starts to listen for what closes it.
    useLayoutEffect(() => {
        const anchor = anchorRef.current;
        const layer = layerRef.current;
        if (!open || !host || !anchor || !layer) {
            return undefined;
        }
        const frame = host.getBoundingClientRect();
        setPlace(placePopover(
            anchor.getBoundingClientRect(),
            { width: layer.offsetWidth, height: layer.scrollHeight },
            {
                left: frame.left + host.clientLeft,
                top: frame.top + host.clientTop,
                width: host.clientWidth,
                height: host.clientHeight,
                // The control panel's surface scrolls when the app's window is short.
                scrollLeft: host.scrollLeft,
                scrollTop: host.scrollTop,
            },
            { side, align, fill },
        ));
        // A part that cannot take focus (a disabled entry) is passed over.
        const asked = focusRef?.current?.matches(':disabled') ? null : focusRef?.current;
        (asked ?? layer.querySelector<HTMLElement>(TABBABLE) ?? layer).focus({ preventScroll: true });

        const close = () => onCloseRef.current();
        const closeOnPress = (event: PointerEvent) => {
            const target = event.target as Node;
            if (!layer.contains(target) && !anchor.contains(target)) close();
        };
        const closeWhenFocusLeaves = (event: FocusEvent) => {
            const next = event.relatedTarget as Node | null;
            if (!layer.contains(next) && !anchor.contains(next)) close();
        };
        // The layer does not follow its anchor: a scroll that moves the anchor takes it down.
        const closeOnScroll = (event: Event) => {
            if (event.target instanceof Node && event.target.contains(anchor)) close();
        };
        document.addEventListener('pointerdown', closeOnPress, true);
        layer.addEventListener('focusout', closeWhenFocusLeaves);
        anchor.addEventListener('focusout', closeWhenFocusLeaves);
        window.addEventListener('scroll', closeOnScroll, true);
        window.addEventListener('resize', close);
        return () => {
            document.removeEventListener('pointerdown', closeOnPress, true);
            layer.removeEventListener('focusout', closeWhenFocusLeaves);
            anchor.removeEventListener('focusout', closeWhenFocusLeaves);
            window.removeEventListener('scroll', closeOnScroll, true);
            window.removeEventListener('resize', close);
            // Focus that is still in the layer goes back to the anchor.
            if (layer.contains(document.activeElement)) anchor.focus({ preventScroll: true });
        };
    }, [open, host, anchorRef, focusRef, side, align, fill]);

    if (!host || !present) {
        return null;
    }

    const placed = place?.side ?? side;
    const origin = fill || align === 'center' ? 'center' : align === 'end' ? 'right' : 'left';
    // Until it is placed it only has to have its own size.
    const edges = place
        ? { left: place.left, right: place.right, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }
        : fill ? { left: POPOVER_GUTTER, right: POPOVER_GUTTER, top: 0 } : { left: 0, top: 0 };

    return createPortal(
        <div
            ref={layerRef}
            {...naming}
            // A press on what takes no focus inside the layer lands here, so the layer stays open.
            tabIndex={-1}
            // Leaving, it is in nothing's way and nothing reaches it.
            inert={!open}
            data-leaving={open ? undefined : ''}
            onKeyDown={(event) => {
                // Escape is the layer's: the window behind does not close on the same key.
                if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.stopPropagation();
                    onClose();
                }
            }}
            onAnimationEnd={(event) => {
                if (!open && event.target === event.currentTarget) {
                    setPresent(false);
                    setPlace(null);
                }
            }}
            style={{
                ...edges,
                // It grows out of the corner at its anchor.
                transformOrigin: `${origin} ${placed === 'over' ? 'bottom' : 'top'}`,
                ...({ '--st-pop-shift': placed === 'over' ? '4px' : '-4px' } as React.CSSProperties),
                // It holds focus without a mark of its own.
                outline: 'none',
            }}
            // className 里同时出现 relative 和 absolute 会互相覆盖，popover 本来就是绝对定位弹出的，
            // 交给 style 里的定位（edges）说了算，这里只补 isolate —— 玻璃层要独立成叠加上下文。
            /*
             * ★ pointer-events-auto 是必须的，别看它像个多余的一行。
             *
             * 这层被 portal 进 `.st-window`，而 `.st-window` 的祖先链上有一层是
             * `PanelShell` 的 `pointer-events-none`（那是故意的：面板外壳本身不该挡住
             * 底下的播放页，只有里面几个具体控件该接收事件）。
             *
             * pointer-events 是**继承**的：祖先设成 none、这里不显式写回 auto，
             * 这个弹层就整体收不到指针事件 —— 表现是「内容能看，但手指滑不动，
             * 滑不到底」。而脚本里设 scrollTop 是能滚的（脚本不受 pointer-events 影响），
             * 所以只看代码或自动化测试会以为一切正常，只有真手指滑才露出来。
             *
             * 横屏时这个弹层高度被压到 191px、内容 346px，正好必须滚动，于是问题最明显。
             */
            className={`st-pop st-scroll isolate pointer-events-auto absolute z-30 flex flex-col overflow-y-auto overscroll-contain rounded-[10px] text-[color:var(--st-t1)] shadow-[0_14px_36px_rgba(0,0,0,0.34),0_0_0_1px_var(--st-line2)] ${fill ? '' : 'w-max max-w-[calc(100%-16px)] '}${className}`}
        >
            <GlassLayer radius="rounded-[10px]" tint="bg-[var(--st-menu)]" />
            <div className="relative z-10 flex flex-col">
                {children}
            </div>
        </div>,
        host,
    );
};

export default Popover;
