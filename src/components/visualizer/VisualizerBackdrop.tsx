import React, { createContext, useMemo, useState } from 'react';
import type { MotionValue } from 'framer-motion';
import type { AudioBands, Theme } from '../../types';
import type { VisualizerRegistryEntry, VisualizerSharedProps } from './definition';
import VisualizerBackgroundRenderer from './backgrounds/VisualizerBackgroundRenderer';
import VideoLayer from './videoLayer/VideoLayer';
import VisualizerBackgroundTransition from './styleTransition/VisualizerBackgroundTransition';
import type { LayerTransition } from './styleTransition/layerTransition';
import { getSizedCoverUrl } from '../../utils/coverUrl';
import { isMainAppSurface } from '../../utils/appSurface';
import { hasFreeCamera } from './backgrounds/freeCameraModes';
import { FoliumStageLayerSlot } from '../../mods/folium/registries/stageLayers';

// src/components/visualizer/VisualizerBackdrop.tsx
// What a lyric style is drawn over: the background, and the video layer above it. VisualizerRenderer
// draws them once around whichever style is on screen, so a style switch keeps them; a new copy
// would start again from its first frame (a WebGL context, an image that fades in, cover colours
// read again). Where no renderer is around a style (the style pictures, the mod export window), the
// style's VisualizerShell draws them itself, the same way. Mod stage layers are drawn here too, above
// and below the style, so a style switch keeps them mounted as well. Where the renderer plays the style
// switch's transition, a change of background plays it too (styleTransition/VisualizerBackgroundTransition).

/**
 * Set inside a VisualizerBackdrop: the shell of the style inside leaves the layers, the stage layers and
 * the opacity to it. The shell's own box lets the pointer through to the stage layers under the style,
 * so it reads the pointer on `pointerArea`, the backdrop's box (null until that is on the page, and
 * for a style that is leaving in a style switch).
 */
export interface VisualizerBackdropFrame {
    pointerArea: HTMLElement | null;
}

export const VisualizerBackdropContext = createContext<VisualizerBackdropFrame | null>(null);

export type VisualizerBackdropSharedProps = Pick<
    VisualizerSharedProps,
    | 'coverUrl'
    | 'isDaylight'
    | 'seed'
    | 'background'
    | 'staticMode'
    | 'backgroundStaticMode'
    | 'paused'
    | 'isPreviewMode'
>;

interface VisualizerBackdropLayersProps {
    theme: Theme;
    audioPower: MotionValue<number>;
    audioBands: AudioBands;
    sharedProps?: VisualizerBackdropSharedProps;
    renderBackground: boolean;
    /** The transition a background change plays; left out or null, the new background shows at once. */
    transition?: LayerTransition | null;
    /** A background change made now waits to start, with the style switch it is made with. */
    waits?: boolean;
}

/** The layers under a style's lyrics, bottom first. */
export const VisualizerBackdropLayers: React.FC<VisualizerBackdropLayersProps> = ({
    theme,
    audioPower,
    audioBands,
    sharedProps,
    renderBackground,
    transition = null,
    waits = false,
}) => {
    const staticMode = sharedProps?.staticMode ?? false;
    const paused = sharedProps?.paused ?? false;

    return (
        <>
            <VisualizerBackgroundTransition
                inputs={{
                    config: sharedProps?.background,
                    theme,
                    isDaylight: sharedProps?.isDaylight ?? false,
                    coverUrl: getSizedCoverUrl(sharedProps?.coverUrl, 1024) || undefined,
                    audioPower,
                    audioBands,
                    seed: sharedProps?.seed,
                    staticMode: staticMode || (sharedProps?.backgroundStaticMode ?? false),
                    paused,
                    blendMs: transition ? (transition.enter.delay ?? 0) + transition.enter.duration : 0,
                    blendProgress: transition?.progress,
                }}
                drawn={renderBackground}
                transition={transition}
                waits={waits}
                render={inputs => <VisualizerBackgroundRenderer {...inputs} />}
            />

            {/* The built-in video layer follows the same rule as stage layers and stays out of the OBS
                sources, which cannot open the main window's local file handle. */}
            {!sharedProps?.isPreviewMode && !staticMode && isMainAppSurface && <VideoLayer paused={paused} />}
        </>
    );
};

interface VisualizerBackdropProps {
    /** The style on screen: it says which background it is drawn over. */
    entry: VisualizerRegistryEntry;
    props: VisualizerSharedProps;
    /** The transition a background change plays, the style switch's; left out or null to cut. */
    transition?: LayerTransition | null;
    /** The style switch waits for the new style's first frame: a background change made now waits with it. */
    waits?: boolean;
    children: React.ReactNode;
}

/**
 * The style on screen over its layers and between the stage layers, all at the visualizer's opacity.
 * The box is the one the style's shell had (full size, clipped), so the layers sit and paint where they
 * did inside it.
 */
const VisualizerBackdrop: React.FC<VisualizerBackdropProps> = ({ entry, props, transition, waits, children }) => {
    const [pointerArea, setPointerArea] = useState<HTMLDivElement | null>(null);
    const frame = useMemo<VisualizerBackdropFrame>(() => ({ pointerArea }), [pointerArea]);
    // Folium stage layers exist on the real player page only, never in previews.
    const showStageLayers = !props.isPreviewMode && !props.staticMode;
    const stageProps = { theme: props.theme, isDaylight: props.isDaylight ?? false, paused: props.paused ?? false };
    /*
     * 自由相机的 3D 背景（粒子 / 星河 / 安魂 / 音域回响）：内容层必须放行指针。
     *
     * ★ 拖不动视角的根因在这里，不在背景自己。
     *
     * 背景层 z-0、内容层 z-10（见下面的注释 —— 那个 z-10 是为了让粒子能看见，
     * 不能删）。elementFromPoint 证实：屏幕上每一个点命中的都是内容层，
     * OrbitStage 的拖动监听挂在背景宿主上，一次 pointerdown 都收不到。
     *
     * 解法是反过来：内容层 pointer-events-none，让事件穿到背景；
     * 内容里真正要点的控件自己声明 pointer-events-auto（现在大多已经带了，
     * 没带的补上即可）。只对自由相机的背景这么做 —— 别的背景（莫奈的
     * 歌词点按跳转、町景的镜头栏）要收指针，不能一刀切。
     */
    const resolvedSharedProps = entry.background ? { ...props, background: entry.background(props) } : props;
    const backgroundMode = resolvedSharedProps.background?.mode ?? null;
    const freeCamera = hasFreeCamera(backgroundMode);

    return (
        <div ref={setPointerArea} className="relative w-full h-full overflow-hidden" style={{ opacity: props.visualizerOpacity ?? 1 }}>
            <VisualizerBackdropLayers
                theme={props.theme}
                audioPower={props.audioPower}
                audioBands={props.audioBands}
                sharedProps={resolvedSharedProps}
                renderBackground={entry.background !== false}
                transition={transition}
                waits={waits}
            />
            {showStageLayers && <FoliumStageLayerSlot slot="player.stage.back" {...stageProps} />}
            <VisualizerBackdropContext.Provider value={frame}>
                {/*
                 * ★ relative z-10 是必须的。
                 *
                 * 这里和上面的背景层（VisualizerBackdropLayers）都是 absolute inset-0、
                 * 且都没有 z-index。两者在 DOM 里是兄弟，谁在上面只由书写顺序决定：
                 * 背景在前、内容在后，所以内容层正常会盖住背景 —— 对 Sora 这类
                 * 背景没影响（它们在内容层下方本来就该被遮住一部分），
                 * 但对粒子背景是致命的：canvas 完全被这块透明的内容层压住，
                 * 于是「渲染一切正常、屏幕上什么都看不到」。
                 *
                 * 显式给内容层 z-10、让背景层留在 z-0 以下的层级，
                 * 顺序就不再依赖书写位置，也不受各背景自己的 DOM 结构影响。
                 *
                 * 自由相机的背景再加 pointer-events-none：事件穿过去给背景的
                 * 轨道相机（见上面的 freeCamera 注释）。
                 */}
                <div className={`relative z-10 h-full w-full ${freeCamera ? 'pointer-events-none' : ''}`}>{children}</div>
            </VisualizerBackdropContext.Provider>
            {showStageLayers && (
                <FoliumStageLayerSlot slot="player.stage.front" {...stageProps} className="absolute inset-0 pointer-events-none z-20" />
            )}
        </div>
    );
};

export default VisualizerBackdrop;
