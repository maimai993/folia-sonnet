import React, { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useIsPresent } from 'framer-motion';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../../types';
import { SettingsKitThemeContext, settingsTokens, useSettingsKitTheme } from '../modal/settings/kit/kitTheme';
import { KIT_EASE, KIT_MOTION, kitMotionTokens, kitTransition, useKitReducedMotion } from '../modal/settings/kit/motion';
import { Tooltip } from '../modal/settings/kit';
import { escapeCloses, tabTarget } from './sheetKeys';
import { isNativeBackKey } from '../../utils/keyboardTargets';
import { Button } from '../ui';
import { useGlassSurfaceSettingsStore } from '../../stores/useGlassSurfaceSettingsStore';
import { GlassLayer } from '../modal/settings/kit/GlassLayer';

// src/components/shared/Sheet.tsx
// The frame of every dialog: a title and the close button at the top, the content in the middle,
// a note at the left and the actions at the right of the bottom, in three sizes. It looks like the
// settings window and is drawn outside it, so it sets the settings kit's colour and motion
// variables on itself; parts of the kit work inside it wherever it opens. The accent is the theme's:
// the app shell and the settings window hand the theme down as the kit theme.
//
// It is drawn in a layer of the app shell, not where it is rendered: what surrounds the part that
// opened it does not reach it (a margin between siblings, or a panel with a backdrop filter or a
// transform, which a fixed overlay is measured against instead of the window). React events still
// bubble to that part.
//
// While it is open the keyboard belongs to it: focus goes in, Tab stays in, and Escape closes the
// topmost sheet and nothing under it. Closing gives focus back to what opened it.
//
// Escape reaches it by two roads that must not be confused: a real key press is caught on
// `document` (so parts inside the sheet see it first), while Android's back button arrives as an
// Escape dispatched straight on `window` and needs a listener there. See the two listeners.

/**
 * s: a question or a short notice. m: a dialog with content of its own. l: a work window. xl: a work
 * window with two wide panes.
 * side: a dialog with a column of choices beside its content (`aside`); it is at least 420 high,
 * or as high as the window lets it be: in a lower window its body scrolls, as in the other sizes.
 */
export type SheetSize = 's' | 'm' | 'l' | 'xl' | 'side';

const SIZE_CLASS: Record<SheetSize, string> = {
    s: 'w-[400px]',
    m: 'w-[600px]',
    l: 'h-[720px] w-[880px]',
    xl: 'h-[720px] w-[1160px]',
    side: 'min-h-[min(420px,100%)] w-[772px]',
};

const BODY_CLASS = {
    // st-scroll: the kit's thin scrollbar.
    scroll: 'st-scroll overflow-y-auto overscroll-contain',
    fill: 'flex flex-col overflow-hidden',
    panes: 'flex overflow-hidden',
} as const;

/** What Tab can stop at. */
const TAB_STOP_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]';

export const tabStops = (panel: HTMLElement): HTMLElement[] => (
    Array.from(panel.querySelectorAll<HTMLElement>(TAB_STOP_SELECTOR)).filter(node => (
        node.tabIndex >= 0
        && !node.hasAttribute('disabled')
        && !node.closest('[inert]')
        && node.getClientRects().length > 0
    ))
);

/**
 * Where sheets are drawn: an element the app shell offers, inside its colour variables and over its
 * pages and windows. Null while the shell has not drawn that element yet. Without a shell (a page
 * that is not the app), the document body.
 */
export const SheetLayerContext = createContext<HTMLElement | null | undefined>(undefined);

/** The open sheets, the topmost last. The keyboard belongs to the topmost one. */
const openSheets: symbol[] = [];

/**
 * The variables of the sheet's panel: the settings kit's, and what the kit does not hold: the colour
 * of the text on a red button, and the sheet's shadow. The text colour is the app's, or the
 * overlay's stand-in where the sheet is drawn outside the app shell.
 */
const panelTokens = (isDaylight: boolean, theme: Theme | undefined, reduced: boolean, glass = false): CSSProperties => ({
    '--text-primary': 'var(--sheet-ink)',
    ...settingsTokens(isDaylight, theme, glass),
    ...kitMotionTokens(reduced),
    '--st-on-err': isDaylight ? '#ffffff' : '#1b1012',
    '--sheet-shadow': isDaylight ? '0 36px 90px rgba(0, 0, 0, 0.26)' : '0 36px 90px rgba(0, 0, 0, 0.6)',
} as CSSProperties);

/**
 * The dim layer, and the text colour for a sheet drawn outside the app shell, where its
 * --text-primary does not reach: the theme's own, or a plain one where there is no theme either.
 */
const overlayTokens = (isDaylight: boolean, theme: Theme | undefined): CSSProperties => ({
    '--sheet-scrim': isDaylight ? 'rgba(24, 18, 12, 0.36)' : 'rgba(0, 0, 0, 0.52)',
    '--sheet-ink': `var(--text-primary, ${theme?.primaryColor ?? (isDaylight ? '#18181b' : '#f4f4f5')})`,
} as CSSProperties);

/**
 * 跑在 Capacitor 安卓 App 里吗（只认安卓：这一层只在那一端的合成器上值得加，见下）。
 */
const isAndroidApp = (): boolean => (
    typeof window !== 'undefined'
    && (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() === 'android'
);

/**
 * 安卓上，遮罩这一层要从画出来第一帧就自己占一个合成层（恒等 translate3d，几何与定位都不变）。
 *
 * 为什么：原来这一层是不被提升的 —— 被提升的是它里面的遮罩（opacity 动画）和面板（framer-motion
 * 每帧改内联 transform），而且**面板的图层在进场动画收尾时会被撤掉**（framer 把 transform 抹成 none）。
 * 安卓 WebView 上这一撤要把内容重栅格化回父层，弱 GPU 上会漏出一帧旧的合成结果：身后那层背景
 * （首页墙后的 player-visual-surface，挂着 24px 的滤镜模糊、本身就是 render surface）正好在弹层的位置上
 * 闪一下。桌面 GPU 快，看不到这一帧。容器自己先有图层，遮罩和面板的图层生灭就都落在它上面。
 *
 * 为什么只在安卓加：被提升的图层拿不到 LCD 次像素抗锯齿（图层底是透明的，Chromium 判它
 * is_suitable_for_lcd = false）—— 弹层里的字会变成灰度抗锯齿，桌面上看得出来，截图基线也会跟着变。
 *
 * 唯一的副作用：带 transform 的元素是自己 fixed 后代的包含块 —— 而这个容器本来就是整个视口，
 * 里面的 fixed 内容位置一个像素都不会动。
 */
const COMPOSITED: CSSProperties = Object.freeze({ transform: 'translate3d(0, 0, 0)' });
const NO_LAYER: CSSProperties = Object.freeze({});
const overlayLayer = (): CSSProperties => (isAndroidApp() ? COMPOSITED : NO_LAYER);

type SheetProps = {
    isOpen: boolean;
    onClose: () => void;
    size?: SheetSize;
    title: string;
    /** One line under the title. */
    subtitle?: React.ReactNode;
    /** Beside the title, before the close button. */
    headerActions?: React.ReactNode;
    children: React.ReactNode;
    /** The actions, at the right of the bottom. */
    footer?: React.ReactNode;
    /** A note or a state, at the left of the bottom. */
    footerNote?: React.ReactNode;
    /**
     * Who scrolls. 'scroll', the default: the body, inside the sheet's padding. 'fill': the body is a
     * padded column that does not scroll; the content fills it and scrolls a part of itself.
     * 'panes': as fill, without the padding and side by side, with a line under the header: for a
     * work window that lays out its own panes.
     */
    body?: 'scroll' | 'fill' | 'panes';
    /** Light or dark. Left out, it is the app's, or the settings window's inside that window. */
    isDaylight?: boolean;
    /** Blocks the X, a click outside and Escape, while a close would leave work half done. */
    closeDisabled?: boolean;
    /** Shown on the dimmed X: what has to finish before the sheet can close. */
    closeDisabledTip?: string;
    /** Shown on the X while it can close. */
    closeTip?: string;
    /** Before the title, on its line: a mark of what the sheet is for. */
    titleLead?: React.ReactNode;
    /** A column at the left, over the whole height of the sheet, beside the header too. */
    aside?: React.ReactNode;
    /** Drawn on the sheet's surface, behind everything else in it: a tint. It takes no pointer. */
    underlay?: React.ReactNode;
    /**
     * The height the sheet has at rest. Its top edge stays where a sheet of that height sits when
     * centred, so content that unfolds makes it taller downwards only.
     */
    restHeight?: number;
    /** Drawn over everything in the sheet but the close button: a picture the sheet ends on. It takes no pointer. */
    overlay?: React.ReactNode;
    /** The title fades out: the sheet is about to show something over itself. The close button stays. */
    quiet?: boolean;
    /** How the sheet leaves. 'through': it grows a little and fades, as if passed through. */
    leave?: 'through';
    /** Where the sheet comes from, as an offset in px from where it rests: it arrives from that side. */
    from?: { x: number; y: number } | null;
    /** The lesson marker of the sheet, for Ponder: on the whole panel, its column and title row too. */
    ponderId?: string;
    /**
     * 这个弹层是哪一种。纯标记（落进 data-folia-themed-dialog-kind）：手机适配的 CSS
     * 靠它给个别的弹层单独排版（比如播放列表选择要压高度）。ThemedDialog 的 panelKind 传到这里。
     */
    kind?: string;
};

type SheetFrameProps = Omit<SheetProps, 'isOpen'>;

/** With a column: the column at the left and the rest beside it. Without one: the rest as it is. */
const withAside = (aside: React.ReactNode, rest: React.ReactNode): React.ReactNode => (
    aside
        ? (
            <div className="relative z-10 flex min-h-0 flex-1">
                {aside}
                <div className="flex min-w-0 flex-1 flex-col">{rest}</div>
            </div>
        )
        // relative + z-10：玻璃层是 z-0 的绝对定位元素，不等上来就会被它整片盖住。
        : <div className="relative z-10 flex min-h-0 flex-1 flex-col">{rest}</div>
);

const SheetFrame: React.FC<SheetFrameProps> = ({
    onClose,
    size = 'm',
    title,
    subtitle,
    headerActions,
    children,
    footer,
    footerNote,
    body = 'scroll',
    isDaylight: isDaylightProp,
    closeDisabled = false,
    closeDisabledTip,
    closeTip,
    titleLead,
    aside,
    underlay,
    restHeight,
    overlay,
    quiet = false,
    leave,
    from,
    ponderId,
    kind,
}) => {
    const { t } = useTranslation();
    const kitTheme = useSettingsKitTheme();
    const isDaylight = isDaylightProp ?? kitTheme.isDaylight;
    const theme = kitTheme.theme;
    const reduced = useKitReducedMotion();
    // 液态玻璃开着时弹层面板转半透明（settingsTokens 的 glass 参数），折射滤镜才有画面可折射。
    const glassOn = useGlassSurfaceSettingsStore(state => state.liquidGlassEnabled);
    // False from the moment the sheet starts to leave: it lets go of the keyboard and the pointer
    // then, not when its exit has finished.
    const isPresent = useIsPresent();
    const titleId = useId();
    const panelRef = useRef<HTMLDivElement>(null);
    const isMouseDownOnOverlayRef = useRef(false);
    // What had focus before the sheet took it: read while rendering, before anything inside mounts.
    const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
    const childTheme = useMemo(() => ({ isDaylight, theme }), [isDaylight, theme]);

    const requestClose = () => {
        if (!closeDisabled) onClose();
    };
    const requestCloseRef = useRef(requestClose);
    requestCloseRef.current = requestClose;
    const closeDisabledRef = useRef(closeDisabled);
    closeDisabledRef.current = closeDisabled;

    useEffect(() => {
        const panel = panelRef.current;
        if (!isPresent || !panel) {
            return undefined;
        }

        const token = Symbol('sheet');
        openSheets.push(token);
        if (!panel.contains(document.activeElement)) {
            (panel.querySelector<HTMLElement>('[data-autofocus]') ?? panel).focus({ preventScroll: true });
        }

        // On the document, so the parts inside the sheet see a key first (an open pick list closes
        // on Escape and stops the key) and the windows listening on `window` never see it.
        const handleKeyDown = (event: KeyboardEvent) => {
            if (openSheets[openSheets.length - 1] !== token) {
                return;
            }
            if (event.key === 'Escape') {
                event.stopPropagation();
                const closes = escapeCloses({
                    taken: event.defaultPrevented,
                    held: event.repeat,
                    composing: event.isComposing,
                    popupOpen: panel.querySelector('[aria-haspopup][aria-expanded="true"]') !== null,
                    closeDisabled: closeDisabledRef.current,
                });
                if (closes) {
                    event.preventDefault();
                    requestCloseRef.current();
                }
                return;
            }
            if (event.key === 'Tab') {
                // Focus is in another window that has the keyboard (the Ponder stage, opened over the sheet): Tab is that window's.
                const owner = document.activeElement?.closest('[data-folia-keyboard-window="true"]');
                if (owner && !owner.contains(panel)) {
                    return;
                }
                const stops = tabStops(panel);
                const target = tabTarget(stops.length, stops.indexOf(document.activeElement as HTMLElement), event.shiftKey);
                if (stops.length === 0 || target !== null) {
                    event.preventDefault();
                    (target === null ? panel : stops[target]).focus();
                }
            }
        };

        document.addEventListener('keydown', handleKeyDown);

        // Android's back button and its edge swipe: the native side turns one into an Escape
        // **dispatched on `window`** (useNativeBackButton). Its target is the window itself, so
        // `document` is not in the propagation path and the listener above never sees it — every
        // sheet here (the sign-in window among them) looked dead to the back gesture, and with
        // nothing calling preventDefault the whole app went to the background instead.
        //
        // Only the marked key is taken here: a real Escape still belongs to the document listener
        // above, which stops it before it could reach this one.
        const handleNativeBack = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || !isNativeBackKey(event)) {
                return;
            }
            if (openSheets[openSheets.length - 1] !== token) {
                return;
            }
            const closes = escapeCloses({
                taken: event.defaultPrevented,
                held: event.repeat,
                composing: event.isComposing,
                popupOpen: panel.querySelector('[aria-haspopup][aria-expanded="true"]') !== null,
                closeDisabled: closeDisabledRef.current,
            });
            if (closes) {
                // Tells useNativeBackButton this one was handled: without it the app goes to the
                // background on the very key that just closed a window.
                event.preventDefault();
                requestCloseRef.current();
            }
        };
        window.addEventListener('keydown', handleNativeBack);

        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keydown', handleNativeBack);
            openSheets.splice(openSheets.indexOf(token), 1);
            // Back to what opened the sheet, unless focus has since been put somewhere else.
            const active = document.activeElement;
            if (opener?.isConnected && (!active || active === document.body || panel.contains(active))) {
                opener.focus({ preventScroll: true });
            }
        };
    }, [isPresent, opener]);

    // Where the panel comes from and goes back to: a little lower and a little smaller.
    const away = { opacity: 0, x: 0, y: 12, scale: 0.985 };
    // Read once, when the sheet arrives: a change of `from` afterwards moves nothing.
    const [cameFrom] = useState(() => (from ? { opacity: 0, x: from.x, y: from.y, scale: 0.9 } : away));
    const exit = leave === 'through'
        ? { opacity: 0, scale: 1.08, transition: { duration: reduced ? 0 : KIT_MOTION.unfold, ease: KIT_EASE.standard } }
        : { ...away, transition: kitTransition('move', reduced) };

    return (
        <div
            data-folia-keyboard-window={isPresent ? 'true' : undefined}
            // What hasOpenSheet (utils/keyboardTargets) looks for.
            data-folia-sheet={isPresent ? 'true' : undefined}
            // 手机适配的 CSS 与「已经有个弹层开着吗」的查询都认这两个标记
            // （styles/androidPhoneFit.css、hooks/useStartupUpdatePrompt.ts）。
            data-folia-themed-overlay={isPresent ? 'true' : undefined}
            inert={!isPresent}
            className={`fixed inset-0 z-[200] flex justify-center p-4 ${restHeight ? 'items-start' : 'items-center'}`}
            style={restHeight
                ? { ...overlayLayer(), ...overlayTokens(isDaylight, theme), paddingTop: `max(16px, calc(50vh - ${restHeight / 2}px))` }
                : { ...overlayLayer(), ...overlayTokens(isDaylight, theme) }}
            onMouseDown={(event) => {
                isMouseDownOnOverlayRef.current = event.target === event.currentTarget;
            }}
            onClick={(event) => {
                if (event.target === event.currentTarget && isMouseDownOnOverlayRef.current) requestClose();
            }}
        >
            <motion.div
                aria-hidden
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={kitTransition('move', reduced)}
                className="pointer-events-none absolute inset-0 bg-[var(--sheet-scrim)]"
            />
            <motion.div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                data-ponder={ponderId}
                data-folia-themed-dialog="true"
                data-folia-themed-dialog-kind={kind}
                tabIndex={-1}
                initial={cameFrom}
                animate={{ opacity: 1, x: 0, y: 0, scale: 1, transition: kitTransition('unfold', reduced) }}
                exit={exit}
                className={`st-window relative isolate flex max-h-[min(720px,100%)] max-w-full flex-col overflow-hidden rounded-2xl text-[color:var(--st-t1)] shadow-[var(--sheet-shadow),0_0_0_1px_var(--st-line2)] ${SIZE_CLASS[size]}`}
                /*
                 * 背景模糊不写在这块面板上，交给下面那层 span。
                 *
                 * 为什么不写在面板上：backdrop-filter 由浏览器单独合成，**同一元素上的
                 * border-radius 不会收掉它的角**，overflow-hidden 也管不到（模糊层不是子节点）。
                 * 所以设置窗口和每一个 Sheet 弹层，圆角处一直露着四个直角，
                 * 玻璃像贴歪了一张方纸（issue #279）。
                 *
                 * 拆成一层同样带 rounded-2xl 的绝对定位 span 后，模糊发生在那一层自己的
                 * 圆角范围里，合成时被自己的圆角裁掉，看起来才是「一块圆角玻璃」。
                 * 这层必须 z-0（别用负 z）：负值会把它推出堆叠上下文，既脱离圆角裁剪，
                 * 又会掉到面板背景后面，直角照样露出来。
                 */
                // The panel holds focus without a mark of its own.
                //
                // isolate 一直挂着，不再等 underlay 出现：underlay 要等选中哪个平台定下来（窗口打开之后
                // 的一次 effect），原来它一出现面板就凭空多出一个层叠上下文，正好落在进场动画中间。
                // 没有 underlay 的弹层本来也没有负 z 的子层，这一句对它们是空操作。
                //
                // 面板自己不写 will-change：它是固定的包含块会连带影响里面 fixed 的内容，而容器
                // （见 COMPOSITED）已经有图层了，面板那几帧的图层生灭落在它上面就够了。
                style={{ outline: 'none', ...panelTokens(isDaylight, theme, reduced, glassOn) }}
            >
                {/*
                 * 玻璃层：面板的圆角背景 + 模糊都在这里，和面板共用一套圆角。
                 *
                 * 颜色从 --st-win 上来 —— 液态玻璃开着时它本身就是半透明的
                 * （settingsTokens 用 color-mix 压到 72%），所以这一层的背景和原来面板上的
                 * bg-[var(--st-win)] 完全等价，只是多了一个「自己裁自己」的圆角。
                 */}
                <GlassLayer radius="rounded-2xl" tint="bg-[var(--st-win)]" />
                <SettingsKitThemeContext.Provider value={childTheme}>
                    {/*
                     * underlay 排在玻璃层之后、内容之前，z-0 同级靠文档顺序压住玻璃层。
                     * 不用 -z-10：负值会跑到面板的堆叠上下文之外（面板有 isolate），
                     * 表现是 underlay 消失或漏到别的层去。
                     */}
                    {underlay && <div aria-hidden className="pointer-events-none absolute inset-0 z-0">{underlay}</div>}
                    {overlay && <div aria-hidden className="pointer-events-none absolute inset-0 z-10">{overlay}</div>}
                    {withAside(aside, <>
                    <header className={`flex shrink-0 items-start gap-3 pl-6 pr-4 pt-4 ${body === 'panes' ? 'border-b border-[var(--st-line)] pb-3' : ''}`}>
                        <div className={`st-t-fast min-w-0 flex-1 transition-opacity ${quiet ? 'opacity-0' : ''}`}>
                            <h2 id={titleId} className={`text-base font-semibold leading-8 ${titleLead ? 'flex items-center gap-2.5' : ''}`}>
                                {titleLead}
                                {titleLead ? <span className="min-w-0 truncate">{title}</span> : title}
                            </h2>
                            {subtitle && (
                                <p className="-mt-0.5 text-xs leading-[18px] text-[color:var(--st-t2)]">{subtitle}</p>
                            )}
                        </div>
                        {headerActions && (
                            <div className="flex min-h-8 shrink-0 items-center gap-2">{headerActions}</div>
                        )}
                        <Tooltip text={closeDisabled ? closeDisabledTip : closeTip} className={`inline-flex shrink-0 ${overlay ? 'relative z-20' : ''}`}>
                            <Button
                                onClick={requestClose}
                                aria-label={t('ui.close')}
                                // Not `disabled`: the dimmed X still takes the pointer and the keyboard, so its tip can show.
                                aria-disabled={closeDisabled || undefined}
                                className={`st-t-fast grid h-8 w-8 place-items-center rounded-lg text-[color:var(--st-t2)] transition-[background-color,color,opacity] ${closeDisabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-[var(--st-fill)] hover:text-[color:var(--st-t1)]'}`}
                            >
                                <X size={16} />
                            </Button>
                        </Tooltip>
                    </header>

                    <div className={`min-h-0 flex-1 ${BODY_CLASS[body]} ${body === 'panes' ? '' : `px-6 ${size === 's' ? 'pb-4 pt-1' : 'pb-5 pt-3'}`}`}>
                        {children}
                    </div>

                    {(footer || footerNote) && (
                        <footer className={`flex shrink-0 flex-wrap items-center justify-end gap-2 px-4 ${size === 's' ? 'pb-4 pt-1' : 'border-t border-[var(--st-line)] py-3'}`}>
                            {footerNote && (
                                <div className="mr-auto min-w-0 flex-1 text-xs leading-[18px] text-[color:var(--st-t2)]">{footerNote}</div>
                            )}
                            {footer}
                        </footer>
                    )}
                    </>)}
                </SettingsKitThemeContext.Provider>
            </motion.div>
        </div>
    );
};

export const Sheet: React.FC<SheetProps> = ({ isOpen, ...frame }) => {
    const layer = useContext(SheetLayerContext);
    // Drawn in the body now, the sheet would be mounted again in the shell's layer one render later.
    if (layer === null) {
        return null;
    }

    return createPortal(
        <AnimatePresence>
            {isOpen && <SheetFrame {...frame} />}
        </AnimatePresence>,
        layer ?? document.body,
    );
};

const BUTTON_CLASS = 'st-t-fast inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13px] transition-[background-color,color,opacity,scale] enabled:active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40';

const BUTTON_VARIANT_CLASS = {
    fill: 'bg-[var(--st-fill)] text-[color:var(--st-t1)] enabled:hover:bg-[var(--st-fill2)]',
    primary: 'bg-[var(--st-accent)] text-[color:var(--st-on-accent)] enabled:hover:opacity-90',
    danger: 'bg-[var(--st-err)] text-[color:var(--st-on-err)] enabled:hover:opacity-90',
} as const;

type SheetButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type'> & {
    /** primary: the one action the sheet ends on. danger: that action, when it destroys something. */
    variant?: 'primary' | 'danger';
};

/** A button of a sheet's bottom line: filled by default, as the settings kit's button is. */
export const SheetButton: React.FC<SheetButtonProps> = ({ variant, ...button }) => (
    <Button {...button} className={`${BUTTON_CLASS} ${BUTTON_VARIANT_CLASS[variant ?? 'fill']}`} />
);

export default Sheet;
