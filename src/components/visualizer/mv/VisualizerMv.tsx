import React from 'react';
import type { VisualizerSharedProps } from '../definition';
import VisualizerShell from '../VisualizerShell';
import { setMvRequiredByStyle } from '../../../services/mvRequirement';

// src/components/visualizer/mv/VisualizerMv.tsx
// 「MV」样式：画面铺满，歌词不出。
//
// 和 blank 的区别不在画什么，而在这一款**要求**有画面：它挂上去的时候把 MV 那一层
// 强制打开（store 的 forcedByStyle），所以即使「连接与集成」里的开关是关的，选了它
// 也照样有视频。歌词一律不画 —— 这个样式表达的就是「这里只看画面」。
//
// 为什么不是又一个开关：开关只在 MV 打开时才起作用，而 MV 又只在某几个页面才会画；
// 做成样式之后，它和别的样式一样随处可选，切走时也不留下任何痕迹。

const VisualizerMv: React.FC<VisualizerSharedProps> = ({
    theme,
    isDaylight = false,
    audioPower,
    audioBands,
    ...sharedProps
}) => {
    /*
     * 挂着的时候要求画面，卸下的时候放开。
     *
     * 走的是 mvRequirement 那个入口而不是某一家的 store：这一层只表达「这款背景
     * 要画面」，谁提供画面是视频层的内部事。只碰「被样式要求」那一份，不碰用户
     * 自己的开关 —— 切走之后用户原来那个开关该是什么还是什么。
     */
    React.useEffect(() => {
        setMvRequiredByStyle(true);
        return () => setMvRequiredByStyle(false);
    }, []);

    return (
        <VisualizerShell
            theme={theme}
            audioPower={audioPower}
            audioBands={audioBands}
            sharedProps={{
                ...sharedProps,
                isDaylight,
            }}
            renderBackground={false}
            className="visualizer-mv"
        >
            {null}
        </VisualizerShell>
    );
};

export default VisualizerMv;
