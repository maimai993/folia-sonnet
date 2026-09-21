import React from 'react';
import { ChevronRight, Palette, Settings2, Sparkles } from 'lucide-react';
import PonderSurfaceStateLayer, { PonderSurfaceBase, type PonderSurfaceStateRegistrar } from './PonderSurfaceStateLayer';
import type { PonderRelativeRect } from '../../../types/ponder';
import {
    LYRICS_ANIMATION_SETTINGS_GEOMETRY as L,
    THEME_SETTINGS_GEOMETRY as T,
    relativeRectStyle,
} from './ponderSurfaceGeometry';

// src/components/ponder/surfaces/PonderSettingsSectionSurfaces.tsx
// 设置里两组最常被翻的东西：歌词动画、配色主题。
//
// 两个放同一个文件，因为它们是同一类东西 —— 设置面板里的一组卡片，形状简单、结构相近，
// 各拆一个文件只会多两个只有几十行的模块。

type SurfaceProps = {
    accent: string;
    line: string;
    outline: string;
    registerStateNode?: PonderSurfaceStateRegistrar;
};

const ToggleRow: React.FC<{
    rect: PonderRelativeRect;
    line: string;
    outline: string;
    accent: string;
    on?: boolean;
    marker: string;
}> = ({ rect, line, outline, accent, on, marker }) => (
    <div
        {...{ [marker]: true }}
        className="flex items-center gap-[4%] rounded-xl border px-[4%]"
        style={{ ...relativeRectStyle(rect), borderColor: outline }}
    >
        <span className="flex flex-1 flex-col gap-1.5">
            <span className="h-1.5 w-[44%] rounded-full" style={{ backgroundColor: line }} />
            <span className="h-1 w-[68%] rounded-full opacity-55" style={{ backgroundColor: line }} />
        </span>
        <span
            className="relative h-4 w-8 shrink-0 rounded-full"
            style={{ backgroundColor: on ? accent : line, opacity: on ? 0.7 : 1 }}
        >
            <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white ${on ? 'right-0.5' : 'left-0.5'}`} />
        </span>
    </div>
);

/** 歌词动画：一个通往调参台的大入口，加两个开关。 */
export const PonderLyricsAnimationSettingsSurface: React.FC<SurfaceProps> = ({
    accent,
    line,
    outline,
    registerStateNode,
}) => (
    <div className="absolute inset-0 overflow-hidden" data-ponder-lyrics-animation-structure>
        <PonderSurfaceBase registerStateNode={registerStateNode}>
            <div
                data-ponder-lyrics-animation-entry
                className="flex items-center gap-[4%] rounded-xl border-2 px-[4%]"
                style={{ ...relativeRectStyle(L.entry), borderColor: `${accent}66` }}
            >
                <span
                    className="flex aspect-square h-[52%] shrink-0 items-center justify-center rounded-xl border"
                    style={{ borderColor: `${accent}55`, color: accent, backgroundColor: `${accent}18` }}
                >
                    <Settings2 className="h-1/2 w-1/2" />
                </span>
                <span className="flex flex-1 flex-col gap-1.5">
                    <span className="h-2 w-[42%] rounded-full" style={{ backgroundColor: line }} />
                    <span className="h-1 w-[76%] rounded-full opacity-55" style={{ backgroundColor: line }} />
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 opacity-45" />
            </div>

            <ToggleRow marker="data-ponder-lyrics-transparent" rect={L.transparent} line={line} outline={outline} accent={accent} />
            <ToggleRow marker="data-ponder-lyrics-auto-hide" rect={L.autoHide} line={line} outline={outline} accent={accent} on />
        </PonderSurfaceBase>

        {/* 点那个入口打开的是动画调参台：左边一列模式，右边是实时预览。 */}
        <PonderSurfaceStateLayer state="playground-open" registerStateNode={registerStateNode} replaces>
            <div data-ponder-lyrics-playground className="absolute inset-[4%] flex gap-[4%] rounded-xl border bg-zinc-950/95 p-[4%]" style={{ borderColor: outline }}>
                <div className="flex w-[34%] flex-col justify-evenly">
                    {[0, 1, 2, 3].map(index => (
                        <span
                            key={index}
                            className="h-[16%] rounded-lg"
                            style={{ backgroundColor: index === 1 ? accent : line, opacity: index === 1 ? 0.55 : 1 }}
                        />
                    ))}
                </div>
                <div className="flex flex-1 flex-col justify-center gap-[7%] rounded-lg border px-[5%]" style={{ borderColor: outline }}>
                    {[64, 88, 50].map((width, index) => (
                        <span
                            key={width}
                            className="h-2 rounded-full"
                            style={{ width: `${width}%`, backgroundColor: index === 1 ? accent : line, opacity: index === 1 ? 0.8 : 0.5 }}
                        />
                    ))}
                </div>
            </div>
        </PonderSurfaceStateLayer>
    </div>
);

/** 配色主题：Theme Park 入口、两张预设卡、主题生成来源。 */
export const PonderThemeSettingsSurface: React.FC<SurfaceProps> = ({
    accent,
    line,
    outline,
    registerStateNode,
}) => (
    <div className="absolute inset-0 overflow-hidden" data-ponder-theme-settings-structure>
        <PonderSurfaceBase registerStateNode={registerStateNode}>
            <span className="absolute left-[5%] top-[8%] h-2 w-[26%] rounded-full" style={{ backgroundColor: line }} />
            <span
                data-ponder-theme-park
                className="flex items-center justify-center gap-[8%] rounded-full border"
                style={{ ...relativeRectStyle(T.themePark), borderColor: accent, color: accent }}
            >
                <Palette className="h-3.5 w-3.5" />
                <span className="h-1.5 w-[40%] rounded-full" style={{ backgroundColor: accent, opacity: 0.55 }} />
            </span>

            {([
                ['data-ponder-theme-default', T.presetDefault, true],
                ['data-ponder-theme-custom', T.presetCustom, false],
            ] as const).map(([marker, rect, isDefault]) => (
                <div
                    key={marker}
                    {...{ [marker]: true }}
                    className="flex flex-col justify-end gap-2 rounded-xl border p-[4%]"
                    style={{ ...relativeRectStyle(rect), borderColor: isDefault ? accent : outline }}
                >
                    <span className="flex gap-1.5">
                        {[0, 1, 2].map(index => (
                            <span
                                key={index}
                                className="h-3 flex-1 rounded-full"
                                style={{ backgroundColor: isDefault && index === 0 ? accent : line, opacity: isDefault ? 0.85 : 0.6 }}
                            />
                        ))}
                    </span>
                    <span className="h-1.5 w-[52%] rounded-full" style={{ backgroundColor: line }} />
                </div>
            ))}

            <div
                data-ponder-theme-source
                className="flex flex-col justify-center gap-[10%] rounded-xl border px-[4%]"
                style={{ ...relativeRectStyle(T.source), borderColor: outline }}
            >
                <span className="h-1.5 w-[34%] rounded-full" style={{ backgroundColor: line }} />
                <span className="flex gap-[3%]">
                    {[0, 1, 2].map(index => (
                        <span
                            key={index}
                            className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-lg border"
                            style={{ borderColor: index === 0 ? accent : outline, color: index === 0 ? accent : undefined }}
                        >
                            {index === 2 ? <Sparkles className="h-3 w-3 opacity-70" /> : null}
                            <span className="h-1 w-[40%] rounded-full" style={{ backgroundColor: index === 0 ? accent : line }} />
                        </span>
                    ))}
                </span>
            </div>
        </PonderSurfaceBase>

        {/* Theme Park：整屏铺开的配色库。 */}
        <PonderSurfaceStateLayer state="theme-park-open" registerStateNode={registerStateNode} replaces>
            <div data-ponder-theme-park-open className="absolute inset-[4%] grid grid-cols-3 gap-[4%] rounded-xl border bg-zinc-950/95 p-[4%]" style={{ borderColor: outline }}>
                {Array.from({ length: 6 }, (_, index) => (
                    <div
                        key={index}
                        className="flex flex-col justify-end gap-1.5 rounded-lg border p-[6%]"
                        style={{ borderColor: index === 2 ? accent : outline }}
                    >
                        <span className="flex gap-1">
                            {[0, 1, 2].map(swatch => (
                                <span
                                    key={swatch}
                                    className="h-2.5 flex-1 rounded-full"
                                    style={{ backgroundColor: index === 2 && swatch === 0 ? accent : line, opacity: 0.8 }}
                                />
                            ))}
                        </span>
                        <span className="h-1 w-[56%] rounded-full opacity-60" style={{ backgroundColor: line }} />
                    </div>
                ))}
            </div>
        </PonderSurfaceStateLayer>
    </div>
);
