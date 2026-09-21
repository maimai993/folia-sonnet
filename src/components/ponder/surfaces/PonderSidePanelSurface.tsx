import React from 'react';
import { Disc, FileAudio, ListMusic, SlidersHorizontal, User } from 'lucide-react';
import PonderSurfaceStateLayer, { PonderSurfaceBase, type PonderSurfaceStateRegistrar } from './PonderSurfaceStateLayer';
import { SIDE_PANEL_GEOMETRY as G, relativeRectStyle } from './ponderSurfaceGeometry';

// src/components/ponder/surfaces/PonderSidePanelSurface.tsx
// 右侧展开的控制面板：一张方封面压在最上面，下面是曲目信息、一排标签页，再下面是当前标签页的内容。
//
// 标签页那一排是这块面板的全部意义 —— 封面、控制、队列、账号是同一块地方的四副面孔，
// 画成四个并排的小格子而不是一堆行，才读得出「这里可以换页」。

/** 标签页那一排在登记表里的名字：换标签页时只替换它下面那层内容。 */
export const SIDE_PANEL_BODY_STATE = 'panel-body';

type PonderSidePanelSurfaceProps = {
    accent: string;
    line: string;
    outline: string;
    registerStateNode?: PonderSurfaceStateRegistrar;
};

const TABS = [Disc, SlidersHorizontal, ListMusic, User, FileAudio];

/** 队列那一页：一行一首歌，当前这首带标记。 */
const QueueRows: React.FC<{ accent: string; line: string; outline: string }> = ({ accent, line, outline }) => (
    <div data-ponder-panel-queue className="flex flex-col gap-[6%]" style={relativeRectStyle(G.body)}>
        {[0, 1, 2, 3].map(index => (
            <div key={index} className="flex min-h-0 flex-1 items-center gap-2 border-b" style={{ borderColor: outline }}>
                <span
                    className="aspect-square h-[62%] rounded-[16%]"
                    style={{ backgroundColor: index === 0 ? accent : line, opacity: index === 0 ? 0.55 : 1 }}
                />
                <span className="flex flex-1 flex-col gap-1">
                    <span className="h-1.5 rounded-full" style={{ width: `${78 - index * 9}%`, backgroundColor: line }} />
                    <span className="h-1 rounded-full opacity-60" style={{ width: `${46 + index * 5}%`, backgroundColor: line }} />
                </span>
            </div>
        ))}
    </div>
);

/** 控制那一页：几条滑杆和开关。 */
const ControlRows: React.FC<{ accent: string; line: string; outline: string }> = ({ accent, line, outline }) => (
    <div data-ponder-panel-controls className="flex flex-col justify-evenly" style={relativeRectStyle(G.body)}>
        {[0.62, 0.34, 0.78].map((fill, index) => (
            <div key={index} className="flex items-center gap-2">
                <span className="h-1.5 w-[22%] rounded-full opacity-70" style={{ backgroundColor: line }} />
                <span className="relative h-1.5 flex-1 rounded-full" style={{ backgroundColor: line }}>
                    <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${fill * 100}%`, backgroundColor: accent, opacity: 0.6 }} />
                    <span
                        className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border"
                        style={{ left: `${fill * 100}%`, borderColor: outline, backgroundColor: accent }}
                    />
                </span>
            </div>
        ))}
    </div>
);

const PonderSidePanelSurface: React.FC<PonderSidePanelSurfaceProps> = ({
    accent,
    line,
    outline,
    registerStateNode,
}) => (
    <div className="absolute inset-0 overflow-hidden" data-ponder-side-panel-structure>
        <PonderSurfaceBase registerStateNode={registerStateNode}>
            <span
                data-ponder-panel-cover
                className="flex items-center justify-center rounded-[6%] border"
                style={{ ...relativeRectStyle(G.cover), borderColor: outline, backgroundColor: accent, opacity: 0.4 }}
            >
                <Disc className="h-[28%] w-[28%] opacity-45" />
            </span>

            <div data-ponder-panel-meta className="flex flex-col justify-center gap-2" style={relativeRectStyle(G.meta)}>
                <span className="h-2 w-[64%] rounded-full" style={{ backgroundColor: line }} />
                <span className="h-1.5 w-[40%] rounded-full opacity-60" style={{ backgroundColor: line }} />
            </div>

            <div
                data-ponder-panel-tabs
                className="flex items-center gap-[3%] rounded-full p-[1.5%]"
                style={{ ...relativeRectStyle(G.tabs), backgroundColor: line }}
            >
                {TABS.map((Icon, index) => (
                    <span
                        key={index}
                        data-ponder-panel-tab
                        data-active={index === 0 || undefined}
                        className="flex h-full flex-1 items-center justify-center rounded-full"
                        style={{
                            backgroundColor: index === 0 ? accent : undefined,
                            opacity: index === 0 ? 0.55 : 1,
                        }}
                    >
                        <Icon className="h-[52%] w-auto opacity-70" />
                    </span>
                ))}
            </div>

            <PonderSurfaceStateLayer state={SIDE_PANEL_BODY_STATE} registerStateNode={registerStateNode} visible>
                <div className="flex flex-col justify-evenly" style={relativeRectStyle(G.body)}>
                    {[86, 62, 74].map(width => (
                        <span key={width} className="h-1.5 rounded-full" style={{ width: `${width}%`, backgroundColor: line }} />
                    ))}
                </div>
            </PonderSurfaceStateLayer>
        </PonderSurfaceBase>

        {/* 换标签页只换下面那层内容，封面、信息和标签排留在原处。 */}
        <PonderSurfaceStateLayer state="queue-tab" registerStateNode={registerStateNode} replaces={SIDE_PANEL_BODY_STATE}>
            <QueueRows accent={accent} line={line} outline={outline} />
        </PonderSurfaceStateLayer>

        <PonderSurfaceStateLayer state="controls-tab" registerStateNode={registerStateNode} replaces={SIDE_PANEL_BODY_STATE}>
            <ControlRows accent={accent} line={line} outline={outline} />
        </PonderSurfaceStateLayer>
    </div>
);

export default PonderSidePanelSurface;
