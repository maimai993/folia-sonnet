import React, { useEffect, useRef, useState } from 'react';

// src/components/visualizer/videoLayer/VideoLayerSpinner.tsx
// 画面还没出来的时候转个圈。
//
// 为什么要有它：换源、网络慢、CDN 那台回 403，`<video>` 的表现都是**一块什么都没有的
// 黑块**。用户看到的是「视频裂开了」，但没有任何东西说明它在等 —— 等得久了就以为坏了。
//
// 判据只看 `<video>` 自己的 `readyState`：不到 HAVE_CURRENT_DATA 就是「这一帧还没有」。
// 不用 `waiting` 事件，因为它在播放中途卡顿时不一定派发；也不用 React 状态逐帧同步，
// 这里是一个 200ms 的轮询 —— 转圈这件事不需要帧率。
//
// 转圈本身是一次性的 CSS 动画，轮询只切换显不显示。

const POLL_MS = 200;
/** 短于这个时长的卡顿不显示（元数据一到位就消失，闪一下反而更难看）。 */
const SHOW_AFTER_MS = 180;

interface VideoLayerSpinnerProps {
    videoRef: React.RefObject<HTMLVideoElement | null>;
}

const VideoLayerSpinner: React.FC<VideoLayerSpinnerProps> = ({ videoRef }) => {
    const [visible, setVisible] = useState(false);
    const stalledSinceRef = useRef<number | null>(null);

    useEffect(() => {
        const timer = window.setInterval(() => {
            const video = videoRef.current;
            if (!video) {
                setVisible(false);
                stalledSinceRef.current = null;
                return;
            }
            const ready = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
            if (ready) {
                stalledSinceRef.current = null;
                setVisible(false);
                return;
            }
            const since = stalledSinceRef.current;
            if (since === null) {
                stalledSinceRef.current = Date.now();
                return;
            }
            if (Date.now() - since >= SHOW_AFTER_MS) setVisible(true);
        }, POLL_MS);
        return () => window.clearInterval(timer);
    }, [videoRef]);

    if (!visible) return null;

    return (
        <div
            className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none"
            aria-hidden
        >
            <div className="w-10 h-10 rounded-full border-2 border-white/25 border-t-white/80 animate-spin" />
        </div>
    );
};

export default VideoLayerSpinner;
