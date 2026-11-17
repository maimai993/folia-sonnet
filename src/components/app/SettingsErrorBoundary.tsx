import React from 'react';

// src/components/app/SettingsErrorBoundary.tsx
// 设置弹窗的兜底边界。弹窗一挂载就渲染整棵页面树，其中任何一页在真实设备上抛错
// （jsdom 探针抓不到、只有真机才崩的那种），以前的表现是整棵 React 树卸载 → 整个应用黑屏。
// 有了这一层，崩溃被圈在弹窗里：屏幕上给出错误摘要（而不是黑屏），完整堆栈打到 console.error
// （installConsoleLogCapture 会把它送进运行日志），弹窗照常可以关掉。
export interface SettingsErrorBoundaryProps {
    onClose?: () => void;
    children?: React.ReactNode;
}

interface State {
    error: Error | null;
}

export class SettingsErrorBoundary extends React.Component<SettingsErrorBoundaryProps, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: unknown) {
        console.error('[SettingsErrorBoundary] settings crashed:', error, info);
    }

    render() {
        const { error } = this.state;
        if (!error) {
            return this.props.children;
        }
        return (
            <div
                style={{
                    position: 'fixed',
                    inset: 0,
                    zIndex: 200,
                    background: '#111114',
                    color: '#e8e6e3',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                    padding: 24,
                    overflowY: 'auto',
                    fontFamily: 'monospace',
                    fontSize: 13,
                }}
            >
                <div style={{ fontWeight: 700 }}>设置页出错了（已拦下，应用没崩）</div>
                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    {error.message || String(error)}
                </div>
                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', opacity: 0.7 }}>
                    {error.stack || ''}
                </div>
                <button
                    type="button"
                    onClick={() => this.setState({ error: null })}
                    style={{
                        alignSelf: 'flex-start',
                        padding: '8px 16px',
                        borderRadius: 10,
                        background: '#2a2a30',
                        color: '#e8e6e3',
                        border: '1px solid #3a3a42',
                    }}
                >
                    重试
                </button>
                <button
                    type="button"
                    onClick={() => {
                        this.setState({ error: null });
                        this.props.onClose?.();
                    }}
                    style={{
                        alignSelf: 'flex-start',
                        padding: '8px 16px',
                        borderRadius: 10,
                        background: '#2a2a30',
                        color: '#e8e6e3',
                        border: '1px solid #3a3a42',
                    }}
                >
                    关闭设置
                </button>
            </div>
        );
    }
}

export default SettingsErrorBoundary;
