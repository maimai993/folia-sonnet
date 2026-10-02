import React from 'react';
import { useTranslation } from 'react-i18next';
import { useLibrarySuiteStore } from '../core/state/useLibrarySuiteStore';
import { listLibrarySuites } from '../registry';
import { switchLibrarySuite } from './switchLibrarySuite';

// src/library/app/DevLibraryRendererSwitch.tsx
// 【PoC 临时组件】只在开发版出现的浮层：在各套 UI suite 之间切换当前打开的集合，
// 用来验收 Library Core（换 UI 不重新请求、不丢筛选与焦点）。验收结束后删除，
// 或改成正式设置项（届时按设置集成的规则接入导入导出与命令面板）。
// 按钮列表来自 registry（R3 之前是写死的 grid / tui）；data-renderer 沿用旧名，e2e 用它定位。

const DevLibraryRendererSwitch: React.FC<{ sessionKey: string }> = ({ sessionKey }) => {
    const { t } = useTranslation();
    const activeSuite = useLibrarySuiteStore(state => state.suite);

    return (
        <div
            data-testid="dev-library-renderer-switch"
            className="fixed bottom-12 left-4 z-[120] flex items-center gap-1 rounded-full border border-dashed border-current/30 px-2 py-1 font-mono text-[11px] backdrop-blur-md"
            style={{
                backgroundColor: 'color-mix(in srgb, var(--bg-color) 80%, transparent)',
                color: 'var(--text-primary)',
            }}
        >
            <span className="px-1 opacity-50">{`DEV · ${t('libraryTui.rendererSwitch')}`}</span>
            {listLibrarySuites().map(suite => (
                <button
                    key={suite.id}
                    type="button"
                    data-renderer={suite.id}
                    data-suite={suite.id}
                    aria-pressed={activeSuite === suite.id}
                    onClick={() => switchLibrarySuite(sessionKey, suite.id)}
                    className={`rounded-full px-2 py-0.5 ${activeSuite === suite.id ? 'bg-current/15 font-bold' : 'opacity-60 hover:opacity-100'}`}
                >
                    {t(suite.labelKey)}
                </button>
            ))}
        </div>
    );
};

export default DevLibraryRendererSwitch;
