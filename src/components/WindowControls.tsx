import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Maximize, Minimize, Minus, Radio, Square, X } from 'lucide-react';

export default function WindowControls({
    revealed,
    isDaylight = false,
    isMainWindowClickThroughEnabled = false,
}: {
    revealed: boolean;
    isDaylight?: boolean;
    isMainWindowClickThroughEnabled?: boolean;
}) {
    const { t } = useTranslation();
    const [isExpanded, setIsExpanded] = useState(false);
    const electron = window.electron;
    const isMac = electron?.platform === 'darwin';

    useEffect(() => {
        if (!electron) return;
        let active = true;
        let nativeStateReceived = false;
        const unsubscribe = isMac ? electron.onWindowFullscreenChanged(fullscreen => {
            nativeStateReceived = true;
            if (active) setIsExpanded(fullscreen);
        }) : undefined;
        const checkExpanded = async () => {
            const expanded = await (isMac ? electron.isWindowFullscreen() : electron.isWindowMaximized());
            if (active && !nativeStateReceived) setIsExpanded(expanded);
        };
        void checkExpanded();
        if (!isMac) window.addEventListener('resize', checkExpanded);
        return () => {
            active = false;
            unsubscribe?.();
            window.removeEventListener('resize', checkExpanded);
        };
    }, [electron, isMac]);

    if (!electron) return null;

    const remoteControlVisible = revealed && !isMainWindowClickThroughEnabled;
    const standardControlsVisible = revealed && !isMainWindowClickThroughEnabled;
    const remoteBtnClass = `flex items-center justify-center w-11 h-full transition-all duration-200 ${
        remoteControlVisible
            ? isDaylight
                ? 'pointer-events-auto opacity-85 translate-y-0 hover:opacity-100 hover:bg-black/[0.05]'
                : 'pointer-events-auto opacity-75 translate-y-0 hover:opacity-100 hover:bg-white/10'
            : 'pointer-events-none opacity-0 -translate-y-1'
    }`;
    const btnClass = `flex items-center justify-center w-11 h-full transition-all duration-200 ${
        standardControlsVisible
            ? isDaylight
                ? 'pointer-events-auto opacity-85 translate-y-0 hover:opacity-100 hover:bg-black/[0.05]'
                : 'pointer-events-auto opacity-75 translate-y-0 hover:opacity-100 hover:bg-white/10'
            : 'pointer-events-none opacity-0 -translate-y-1'
    }`;
    const closeBtnClass = `flex items-center justify-center w-11 h-full transition-all duration-200 ${
        standardControlsVisible
            ? isDaylight
                ? 'pointer-events-auto opacity-85 translate-y-0 hover:opacity-100 hover:bg-red-500 hover:text-white'
                : 'pointer-events-auto opacity-75 translate-y-0 hover:opacity-100 hover:bg-red-500 hover:text-white'
            : 'pointer-events-none opacity-0 -translate-y-1'
    }`;

    return (
        <div
            className={`flex h-full ${isDaylight ? 'text-zinc-800' : 'text-[var(--text-primary)]'}`}
            style={{
                WebkitAppRegion: 'no-drag',
                pointerEvents: 'none',
            } as React.CSSProperties}
        >
            <button
                className={remoteBtnClass}
                title={t('ui.remoteControl')}
                tabIndex={remoteControlVisible ? 0 : -1}
                onClick={() => void electron.openRemoteControl?.()}
            >
                <Radio size={15} />
            </button>
            <button
                className={btnClass}
                tabIndex={standardControlsVisible ? 0 : -1}
                onClick={() => electron.minimizeWindow()}
            >
                <Minus size={16} />
            </button>
            <button
                className={btnClass}
                tabIndex={standardControlsVisible ? 0 : -1}
                title={t(isMac
                    ? isExpanded ? 'ui.exitFullscreen' : 'ui.enterFullscreen'
                    : isExpanded ? 'ui.restoreWindow' : 'ui.maximizeWindow')}
                aria-label={t(isMac
                    ? isExpanded ? 'ui.exitFullscreen' : 'ui.enterFullscreen'
                    : isExpanded ? 'ui.restoreWindow' : 'ui.maximizeWindow')}
                onClick={async () => {
                    if (isMac) {
                        await electron.toggleFullscreenWindow();
                    } else {
                        await electron.toggleMaximizeWindow();
                        setIsExpanded(await electron.isWindowMaximized());
                    }
                }}
            >
                {isMac
                    ? isExpanded ? <Minimize size={13} /> : <Maximize size={13} />
                    : isExpanded ? <Copy size={13} /> : <Square size={13} />}
            </button>
            <button
                className={closeBtnClass}
                tabIndex={standardControlsVisible ? 0 : -1}
                onClick={() => electron.closeWindow()}
            >
                <X size={16} />
            </button>
        </div>
    );
}
