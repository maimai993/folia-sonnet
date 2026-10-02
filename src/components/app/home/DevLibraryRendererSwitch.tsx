import React from 'react';
import { useTranslation } from 'react-i18next';
import type { LibraryRendererId } from '../../../types/libraryUi';
import { useLibraryRendererStore } from '../../../stores/useLibraryRendererStore';
import { switchLibraryRenderer } from './switchLibraryRenderer';

// src/components/app/home/DevLibraryRendererSwitch.tsx
// 【PoC 临时组件】只在开发版出现的浮层：在网格与 TUI 两个 renderer 之间切换当前打开的集合，
// 用来验收 Library Core（换 UI 不重新请求、不丢筛选与焦点）。验收结束后删除，
// 或改成正式设置项（届时按设置集成的规则接入导入导出与命令面板）。

const RENDERERS: LibraryRendererId[] = ['grid', 'tui'];

const DevLibraryRendererSwitch: React.FC<{ sessionKey: string }> = ({ sessionKey }) => {
    const { t } = useTranslation();
    const renderer = useLibraryRendererStore(state => state.renderer);

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
            {RENDERERS.map(id => (
                <button
                    key={id}
                    type="button"
                    data-renderer={id}
                    aria-pressed={renderer === id}
                    onClick={() => switchLibraryRenderer(sessionKey, id)}
                    className={`rounded-full px-2 py-0.5 ${renderer === id ? 'bg-current/15 font-bold' : 'opacity-60 hover:opacity-100'}`}
                >
                    {id === 'grid' ? t('libraryTui.rendererGrid') : t('libraryTui.rendererTui')}
                </button>
            ))}
        </div>
    );
};

export default DevLibraryRendererSwitch;
