import { useEffect, useState } from 'react';

// src/library/suites/rhine/useRhineLandscape.ts
// 「当前视口是不是横向」的读数。
//
// 原来这里还有一个「挂载时锁横屏」的 hook（走 @capacitor/screen-orientation）。
// 真架子在竖屏下也能正常渲染，强制转屏反而抢走了用户的控制权，所以去掉了 ——
// 现在只保留这个读数，用来给竖屏换一档排布（架子更矮、格数更少）。

/**
 * 当前视口是不是横向。
 *
 * 竖屏时窗口更窄，架子要相应收窄；用它在两种排布之间切换，而不是去转用户的屏幕。
 */
export const useIsLandscape = (): boolean => {
    const [landscape, setLandscape] = useState(() => (
        typeof window === 'undefined' ? true : window.innerWidth >= window.innerHeight
    ));

    useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        const update = (): void => setLandscape(window.innerWidth >= window.innerHeight);
        update();
        window.addEventListener('resize', update);
        window.addEventListener('orientationchange', update);
        return () => {
            window.removeEventListener('resize', update);
            window.removeEventListener('orientationchange', update);
        };
    }, []);

    return landscape;
};
