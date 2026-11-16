// src/components/app/video/VideoWorkspaceHost.tsx
// 影视工作台的一层壳：全窗口覆盖、带一个返回按钮，内容就是 VideoWorkspace。
// 挂在 App 的壳里（与设置浮层同级），所以从任何页面打开它都能盖住当前页面；
// 关掉后回到原来的页面，不改变首页页签的选中态。

import React from 'react';
import { ChevronLeft, X } from 'lucide-react';
import { useVideoWorkspaceStore } from '../../../stores/useVideoWorkspaceStore';
import { VideoWorkspace } from './VideoWorkspace';

export const VideoWorkspaceHost: React.FC = () => {
    const open = useVideoWorkspaceStore(state => state.open);
    const setOpen = useVideoWorkspaceStore(state => state.setOpen);
    const rootRef = React.useRef<HTMLDivElement | null>(null);

    // 首页那几样东西层级比这层高，会从影视页下面透出来：3D 卡片流（连「我的喜欢」都看得见）、
    // 顶上那条「歌单/推荐/专辑/本地」页签和它左边的按钮。工作台开着的时候把它们藏起来，关掉时逐个放回去。
    // 藏的是「别的东西」，不是这一层自己——影视页里自己的 3D 流要留着。
    React.useEffect(() => {
        if (!open) return undefined;
        const hideOthers = () => {
            const mine = rootRef.current;
            const nodes = [
                ...document.querySelectorAll('[data-grid3d-slider], [data-grid-home-chrome]'),
            ].filter(node => !(mine && mine.contains(node)));
            nodes.forEach(node => {
                const shell = (node.parentElement ?? node) as HTMLElement;
                if (shell.dataset.videoHidden === '1') return;
                shell.dataset.videoHidden = '1';
                shell.style.visibility = 'hidden';
            });
        };
        hideOthers();
        const timer = window.setInterval(hideOthers, 600);
        return () => {
            window.clearInterval(timer);
            [...document.querySelectorAll('[data-video-hidden]')].forEach(node => {
                const el = node as HTMLElement;
                el.style.visibility = '';
                delete el.dataset.videoHidden;
            });
        };
    }, [open]);

    if (!open) return null;
    // 设置页那套 --st-* 主题变量只注入在设置浮层里，影视这层在 App 外面，拿不到会变成透明色。
    // 这里给一份「影视自己的深色皮肤」，工作台里的所有 --st-* 引用就都有值了。
    const skin: React.CSSProperties & Record<string, string> = {
        '--st-t1': '#f2f2f4',
        '--st-t2': 'rgba(242, 242, 244, 0.68)',
        '--st-t3': 'rgba(242, 242, 244, 0.45)',
        '--st-line': 'rgba(255, 255, 255, 0.08)',
        '--st-line2': 'rgba(255, 255, 255, 0.2)',
        '--st-fill': 'rgba(255, 255, 255, 0.07)',
        '--st-fill2': 'rgba(255, 255, 255, 0.14)',
        '--st-accent': '#6f5bf0',
        '--st-on-accent': '#ffffff',
        '--st-warn': '#e3a949',
        '--st-err': '#ef6f6f',
        '--st-ok': '#56c98d',
        '--st-bg': '#0a0a0c',
    };
    return (
        <div
            ref={rootRef}
            className="absolute inset-x-0 bottom-0 top-[78px] z-[70] flex min-h-0 select-none flex-col overflow-hidden text-[color:var(--st-t1)]"
            style={{
                ...skin,
                // 不铺一块纯黑：Folia 自己的那层背景（跟着歌走的光）从上面透下来，
                // 越往下越暗到能读字。顶边只压 10% 的黑，和上面那条顶栏就接得住，没有一道缝。
                backgroundColor: 'transparent',
                backgroundImage: 'linear-gradient(180deg, rgba(8,8,10,0.10) 0%, rgba(8,8,10,0.55) 24%, rgba(8,8,10,0.93) 62%, rgba(8,8,10,0.97) 100%)',
            }}
            data-video-workspace="true"
        >
            {/* 顶部那 64px 留给 Folia 自己的页签与右上搜索框：影视页就长在它下面，
                搜索框直接就能搜剧，不另开一个输入框。返回/关闭浮在右上角，不占一行高度。 */}
            <div className="pointer-events-none absolute right-3 top-2 z-10 flex items-center gap-1">
                <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="pointer-events-auto rounded-full bg-white/[0.06] p-1.5 text-[color:var(--st-t2)] hover:bg-white/15 hover:text-[color:var(--st-t1)]"
                    title="返回"
                    aria-label="返回"
                >
                    <ChevronLeft size={17} />
                </button>
                <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="pointer-events-auto rounded-full bg-white/[0.06] p-1.5 text-[color:var(--st-t2)] hover:bg-white/15 hover:text-[color:var(--st-t1)]"
                    title="关闭"
                    aria-label="关闭"
                >
                    <X size={16} />
                </button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden px-4 py-3 md:px-8">
                <VideoWorkspace />
            </div>
        </div>
    );
};

export default VideoWorkspaceHost;
