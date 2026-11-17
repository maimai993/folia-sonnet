import React from 'react';
import i18n from '../../i18n/config';
import { Button } from '../ui';

// src/components/app/SettingsErrorBoundary.tsx
// 设置弹窗的兜底边界。弹窗一挂载就渲染整棵页面树，其中任何一页在真实设备上抛错
// （jsdom 探针抓不到、只有真机才崩的那种），以前的表现是整棵 React 树卸载 → 整个应用黑屏。
// 有了这一层，崩溃被圈在弹窗里：屏幕上给出错误摘要（而不是黑屏），完整堆栈打到 console.error
// （installConsoleLogCapture 会把它送进运行日志），弹窗照常可以关掉。
//
// 类组件是 getDerivedStateFromError 的要求；文案走 i18n（不是 hooks，所以这里直接读 i18n.t）。
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

    private retry = () => this.setState({ error: null });

    private close = () => {
        this.setState({ error: null });
        this.props.onClose?.();
    };

    render() {
        const { error } = this.state;
        if (!error) {
            return this.props.children;
        }
        return (
            <div className="fixed inset-0 z-[200] flex flex-col gap-3 overflow-y-auto bg-[#111114] p-6 font-mono text-[13px] text-[#e8e6e3]">
                <div className="font-bold">{i18n.t('settingsErrorBoundary.title')}</div>
                <div className="whitespace-pre-wrap break-all">{error.message || String(error)}</div>
                <div className="whitespace-pre-wrap break-all opacity-70">{error.stack || ''}</div>
                <div className="flex gap-2">
                    <Button onClick={this.retry}>{i18n.t('settingsErrorBoundary.retry')}</Button>
                    <Button onClick={this.close}>{i18n.t('settingsErrorBoundary.close')}</Button>
                </div>
            </div>
        );
    }
}

export default SettingsErrorBoundary;
