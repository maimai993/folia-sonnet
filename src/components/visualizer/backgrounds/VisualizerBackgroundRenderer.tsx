import React from 'react';
import { DEFAULT_VISUALIZER_BACKGROUND_MODE, getVisualizerBackgroundRegistryEntry } from './registry';
import type { VisualizerBackgroundRenderProps } from './definition';

// src/components/visualizer/backgrounds/VisualizerBackgroundRenderer.tsx
// Selects the active shell background through the discoverable background registry.

interface BackgroundBoundaryProps {
    children: React.ReactNode;
}

/**
 * 背景画崩了，**只收掉背景这一层**。
 *
 * ★ 这是「切换背景（尤其切到 MV / 从 MV 切走）整个应用黑屏」的兜底。
 *
 * 没有这层边界时，背景组件里任何一次渲染异常都会一路冒到 React 的根：
 * 整棵树被卸载，`#root` 变成空的、高度 0，用户看到的就是「不管干什么都是一片黑」,
 * 而且再也不会自己恢复 —— 只有杀进程重开。实测就是这样：一个背景的
 * `useCallback` 里读了 undefined 的 `.length`，屏幕从此全黑。
 *
 * 有了它，出错的结果是「这一层什么都不画」（页面其余部分照常，还能去设置里换回
 * 别的背景），并且**换一个背景就重置** —— 不必重开应用。
 */
class BackgroundBoundary extends React.Component<BackgroundBoundaryProps, { hasError: boolean }> {
    state: { hasError: boolean } = { hasError: false };

    static getDerivedStateFromError() {
        /*
         * ★ 这里必须真的改状态。React 拿到这份状态后会立刻重渲染边界，render() 才会
         * 返回 null、把崩掉的那层收掉。原来返回 { failedMode: null } 等于没改 ——
         * children 又被原样渲染一遍、再抛一次，React 判定边界无效，继续往上冒，
         * 最后整棵树还是卸载（黑屏兜底根本没兜住）。componentDidCatch 里的 setState
         * 在 commit 阶段才跑，已经太晚。
         */
        return { hasError: true };
    }

    componentDidCatch(error: unknown) {
        console.warn('[Background] this background failed to draw; the rest of the page stays', error);
    }

    render() {
        return this.state.hasError ? null : this.props.children;
    }
}

const VisualizerBackgroundRenderer: React.FC<VisualizerBackgroundRenderProps> = (props) => {
    if (props.config?.transparent) {
        return null;
    }

    const mode = props.config?.mode ?? DEFAULT_VISUALIZER_BACKGROUND_MODE;
    return (
        // key={mode}：换背景换一个新边界实例，崩过的一款不会拖累下一款。
        <BackgroundBoundary key={mode}>
            {getVisualizerBackgroundRegistryEntry(mode).render(props)}
        </BackgroundBoundary>
    );
};

export default VisualizerBackgroundRenderer;
