// src/components/app/video/VideoPlayerOverlays.tsx
// 播放层最上面那两张浮层：快捷键一览（F1）和右键菜单（含子菜单）。
//
// 从 VideoPlayer.tsx 拆出来的原因只有一个：那个文件顶到了仓库 800 行的上限（CI 的 check:size）。
// 这里不新增逻辑，props 就是原来闭包里用到的那些。

import React from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { Button } from '../../ui';
import { KEYMAP, type MenuBranch, type MenuEntry } from './videoPlayerModel';

export type VideoPlayerOverlaysProps = {
    helpOpen: boolean;
    setHelpOpen: React.Dispatch<React.SetStateAction<boolean>>;
    menu: { x: number; y: number } | null;
    setMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
    sub: { at: number; top: number } | null;
    setSub: React.Dispatch<React.SetStateAction<{ at: number; top: number } | null>>;
    menuEntries: MenuEntry[];
    menuRef: React.RefObject<HTMLDivElement | null>;
};

export const VideoPlayerOverlays: React.FC<VideoPlayerOverlaysProps> = ({
    helpOpen,
    setHelpOpen,
    menu,
    setMenu,
    sub,
    setSub,
    menuEntries,
    menuRef,
}) => (
    <>
        {/* 快捷键一览：一张玻璃卡片，照着按就行。 */}
        {helpOpen && (
            <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/45 p-6 backdrop-blur-sm" onClick={() => setHelpOpen(false)}>
                <div
                    onClick={event => event.stopPropagation()}
                    className="flex max-h-[82vh] w-[min(92vw,620px)] flex-col overflow-hidden rounded-2xl border border-white/12 bg-[#101014]/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-xl"
                >
                    <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
                        <div className="text-[13px] font-medium text-[#f2f2f4]">快捷键一览</div>
                        <Button type="button" onClick={() => setHelpOpen(false)} className="rounded-full p-1 text-[#f2f2f4]/70 hover:bg-white/10" aria-label="关闭">✕</Button>
                    </div>
                    <div className="grid min-h-0 grid-cols-1 gap-x-6 overflow-y-auto px-4 py-3 sm:grid-cols-2">
                        {KEYMAP.map(([keys, action]) => (
                            <div key={keys} className="flex items-baseline justify-between gap-3 border-b border-white/[0.06] py-1.5">
                                <span className="shrink-0 rounded-md bg-white/10 px-1.5 py-[1px] text-[11px] text-[#f2f2f4]/85">{keys}</span>
                                <span className="min-w-0 text-right text-[11.5px] text-[#f2f2f4]/55">{action}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        )}

        {menu && (
            <div
                ref={menuRef}
                data-video-context-menu
                className="fixed z-[95]"
                style={{ left: menu.x, top: menu.y }}
                onClick={event => event.stopPropagation()}
            >
                <div
                    className="w-[214px] overflow-y-auto rounded-xl border border-white/10 bg-[#101014]/95 py-1 shadow-2xl backdrop-blur"
                    style={{ maxHeight: 470 }}
                >
                    {menuEntries.map((entry, at) => {
                        if (entry.kind === 'line') {
                            return <div key={`line-${at}`} aria-hidden className="mx-2 my-1 h-px bg-white/12" />;
                        }
                        const row = 'flex w-full items-center gap-1.5 px-2.5 py-[5px] text-left text-[12.5px] leading-5 text-[#f2f2f4]/85 transition-colors hover:bg-white/10 disabled:cursor-default disabled:opacity-30';
                        if (entry.kind === 'branch') {
                            const expanded = sub?.at === at;
                            return (
                                <Button
                                    key={entry.label}
                                    type="button"
                                    aria-haspopup="menu"
                                    aria-expanded={expanded}
                                    onMouseEnter={event => setSub({ at, top: event.currentTarget.offsetTop })}
                                    onClick={event => setSub(expanded ? null : { at, top: event.currentTarget.offsetTop })}
                                    className={`${row} ${expanded ? 'bg-white/10 text-[#f2f2f4]' : ''}`}
                                >
                                    <span aria-hidden className="w-4 shrink-0" />
                                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                                    <ChevronRight size={13} className="shrink-0 text-[#f2f2f4]/40" />
                                </Button>
                            );
                        }
                        return (
                            <Button
                                key={entry.label}
                                type="button"
                                disabled={entry.disabled}
                                onMouseEnter={() => setSub(null)}
                                onClick={() => { setMenu(null); setSub(null); entry.run(); }}
                                className={row}
                            >
                                <span aria-hidden className="flex w-4 shrink-0 justify-center text-[#56c98d]">
                                    {entry.checked ? <Check size={13} /> : null}
                                </span>
                                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                                {entry.hint ? <span className="shrink-0 text-[11px] tabular-nums text-[#f2f2f4]/35">{entry.hint}</span> : null}
                            </Button>
                        );
                    })}
                </div>
                {sub && menuEntries[sub.at]?.kind === 'branch' && (() => {
                    const branch = menuEntries[sub.at] as MenuBranch;
                    // 子菜单跟着那一行出现；贴到窗口底就往回收，别掉出去。
                    const limit = window.innerHeight - menu.y - 12 - (branch.children.length * 28 + 12);
                    const top = Math.max(0, Math.min(sub.top, limit));
                    return (
                        <div
                            role="menu"
                            className="absolute left-[208px] w-[196px] overflow-y-auto rounded-xl border border-white/10 bg-[#101014]/95 py-1 shadow-2xl backdrop-blur"
                            style={{ top, maxHeight: 320 }}
                        >
                            {branch.children.map(child => (
                                <Button
                                    key={child.label}
                                    type="button"
                                    disabled={child.disabled}
                                    onClick={() => { setMenu(null); setSub(null); child.run(); }}
                                    className="flex w-full items-center gap-1.5 px-2.5 py-[5px] text-left text-[12.5px] leading-5 text-[#f2f2f4]/85 transition-colors hover:bg-white/10 disabled:cursor-default disabled:opacity-30"
                                >
                                    <span aria-hidden className="flex w-4 shrink-0 justify-center text-[#56c98d]">
                                        {child.checked ? <Check size={13} /> : null}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate">{child.label}</span>
                                    {child.hint ? <span className="shrink-0 text-[11px] tabular-nums text-[#f2f2f4]/35">{child.hint}</span> : null}
                                </Button>
                            ))}
                        </div>
                    );
                })()}
            </div>
        )}
    </>
);

export default VideoPlayerOverlays;
