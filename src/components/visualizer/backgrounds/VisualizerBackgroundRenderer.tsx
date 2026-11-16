import React from 'react';
import { DEFAULT_VISUALIZER_BACKGROUND_MODE, getVisualizerBackgroundRegistryEntry } from './registry';
import type { VisualizerBackgroundRenderProps } from './definition';

// src/components/visualizer/backgrounds/VisualizerBackgroundRenderer.tsx
// Selects the active shell background through the discoverable background registry.

interface BackgroundBoundaryProps {
    /** Which background is inside: the boundary starts over when this changes. */
    mode: string;
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
class BackgroundBoundary extends React.Component<BackgroundBoundaryProps, { failedMode: string | null }> {
    state: { failedMode: string | null } = { failedMode: null };

    static getDerivedStateFromError() {
        return { failedMode: null as string | null };
    }

    componentDidCatch(error: unknown) {
        console.warn('[Background] this background failed to draw; the rest of the page stays', error);
        this.setState({ failedMode: this.props.mode });
    }

    render() {
        // 崩过的那一款就不再画；切到别的背景时 props.mode 变了，自然重新开始。
        if (this.state.failedMode !== null && this.state.failedMode === this.props.mode) return null;
        return this.props.children;
    }
}

const VisualizerBackgroundRenderer: React.FC<VisualizerBackgroundRenderProps> = (props) => {
    if (props.config?.transparent) {
        return null;
    }

    const mode = props.config?.mode ?? DEFAULT_VISUALIZER_BACKGROUND_MODE;
    return (
        <BackgroundBoundary mode={mode}>
            {getVisualizerBackgroundRegistryEntry(mode).render(props)}
        </BackgroundBoundary>
    );
};

export default VisualizerBackgroundRenderer;
