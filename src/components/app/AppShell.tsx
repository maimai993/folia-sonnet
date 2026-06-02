import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Lock, LockOpen } from 'lucide-react';
import TitlebarDragZone from '../TitlebarDragZone';
import WindowControls from '../WindowControls';

// Shared shell for the app container, Electron titlebar, and mounted audio node.
type AppShellProps = {
    appStyle: React.CSSProperties;
    isElectronWindow: boolean;
    usesCustomWindowChrome: boolean;
    useCustomWindowRadius: boolean;
    showTransparentWindowBorder: boolean;
    isPlayerView: boolean;
    isTitlebarRevealed: boolean;
    isMainWindowClickThroughEnabled: boolean;
    showMainWindowClickThroughToggle: boolean;
    onToggleMainWindowClickThrough: () => void;
    audioElement: React.ReactNode;
    children: React.ReactNode;
};

const AppShell: React.FC<AppShellProps> = ({
    appStyle,
    isElectronWindow,
    usesCustomWindowChrome,
    useCustomWindowRadius,
    showTransparentWindowBorder,
    isPlayerView,
    isTitlebarRevealed,
    isMainWindowClickThroughEnabled,
    showMainWindowClickThroughToggle,
    onToggleMainWindowClickThrough,
    audioElement,
    children,
}) => {
    const [isWindowMaximized, setIsWindowMaximized] = useState(false);

    useEffect(() => {
        if (!useCustomWindowRadius || !window.electron?.isWindowMaximized) {
            setIsWindowMaximized(false);
            return;
        }

        let isCancelled = false;

        const syncMaximizedState = async () => {
            try {
                const nextValue = await window.electron!.isWindowMaximized();
                if (!isCancelled) {
                    setIsWindowMaximized(nextValue);
                }
            } catch {
                if (!isCancelled) {
                    setIsWindowMaximized(false);
                }
            }
        };

        void syncMaximizedState();
        window.addEventListener('resize', syncMaximizedState);

        return () => {
            isCancelled = true;
            window.removeEventListener('resize', syncMaximizedState);
        };
    }, [useCustomWindowRadius]);

    const shouldApplyWindowRadius = useCustomWindowRadius && !isWindowMaximized;
    const shouldRenderTitlebarBackdrop = !isPlayerView || (useCustomWindowRadius && !isMainWindowClickThroughEnabled);
    const titlebarBackdropClassName = `absolute inset-0 backdrop-blur-sm ${
        isPlayerView ? 'bg-black/[0.18] border-b border-white/10 shadow-[0_8px_28px_rgba(0,0,0,0.20)]' : ''
    }`;

    return (
        <div
            className="fixed inset-0 w-full h-full flex flex-col overflow-hidden font-sans transition-colors duration-500"
            style={{
                ...appStyle,
                borderRadius: shouldApplyWindowRadius ? '18px' : undefined,
                boxShadow: showTransparentWindowBorder ? 'inset 0 0 0 1px rgba(255,255,255,0.24)' : undefined,
            }}
        >
            {usesCustomWindowChrome && (
                <div className="absolute top-0 left-0 right-0 z-[9999] h-8 pointer-events-none">
                    {shouldRenderTitlebarBackdrop && (
                        <motion.div
                            initial={false}
                            animate={{
                                opacity: isTitlebarRevealed ? 1 : 0,
                            }}
                            transition={{ duration: 0.18, ease: 'easeOut' }}
                            className={titlebarBackdropClassName}
                        />
                    )}
                    <div className="relative h-full">
                        <TitlebarDragZone active={usesCustomWindowChrome} />
                        <div
                            className="pointer-events-auto absolute top-0 right-[180px] z-20 h-full flex items-center"
                            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                        >
                            <button
                                type="button"
                                aria-label={isMainWindowClickThroughEnabled ? 'Disable click-through' : 'Enable click-through'}
                                title={isMainWindowClickThroughEnabled ? '关闭点击穿透' : '开启点击穿透'}
                                onClick={onToggleMainWindowClickThrough}
                                className={`flex h-7 w-7 items-center justify-center rounded-full border shadow-[0_8px_24px_rgba(0,0,0,0.28)] backdrop-blur-md transition-all duration-200 ${
                                    showMainWindowClickThroughToggle
                                        ? 'pointer-events-auto opacity-100 translate-y-0'
                                        : 'pointer-events-none opacity-0 -translate-y-1'
                                } ${
                                    isMainWindowClickThroughEnabled
                                        ? 'border-amber-300/35 bg-black/55 text-amber-100 hover:bg-black/70'
                                        : 'border-white/15 bg-transparent text-white/75 hover:bg-black/20 hover:text-white'
                                }`}
                            >
                                {isMainWindowClickThroughEnabled ? <Lock size={14} /> : <LockOpen size={14} />}
                            </button>
                        </div>
                        <div className="pointer-events-auto absolute top-0 right-0 z-10 h-full">
                            <WindowControls revealed={isTitlebarRevealed} />
                        </div>
                    </div>
                </div>
            )}

            {audioElement}
            {children}
        </div>
    );
};

export default AppShell;
