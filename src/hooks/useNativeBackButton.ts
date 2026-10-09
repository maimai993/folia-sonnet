import { useEffect } from 'react';

// src/hooks/useNativeBackButton.ts
//
// Android 的返回键：先当一次 Escape 交给页面，没人接管才退出。
//
// 应用里所有弹层（设置、登录、命令面板）本来就监听 Escape 关自己，这里不重复实现一套
// 「当前有没有打开的层」的判断，而是复用那条链路：派发一个 Escape 键事件，被消费掉就说明
// 关掉了一层；没人消费（包括 preventDefault）才真的退出 App。

type NativeBackPlugin = {
    addListener: (
        eventName: string,
        listener: () => void,
    ) => Promise<{ remove: () => Promise<void> }> | { remove: () => Promise<void> };
    exitApp: () => Promise<unknown>;
};

const getPlugin = (): NativeBackPlugin | null => {
    if (typeof window === 'undefined') return null;
    const capacitor = (window as unknown as {
        Capacitor?: {
            getPlatform?: () => string;
            Plugins?: { FoliaNative?: NativeBackPlugin };
        };
    }).Capacitor;
    if (capacitor?.getPlatform?.() !== 'android') return null;
    const plugin = capacitor.Plugins?.FoliaNative;
    return plugin && typeof plugin.addListener === 'function' && typeof plugin.exitApp === 'function'
        ? plugin
        : null;
};

export const useNativeBackButton = (): void => {
    useEffect(() => {
        const plugin = getPlugin();
        if (!plugin) return;

        let disposed = false;
        let listenerHandle: { remove: () => Promise<void> } | { remove: () => void } | null = null;
        const registered = plugin.addListener('backButton', () => {
            if (disposed) return;
            const event = new KeyboardEvent('keydown', {
                key: 'Escape',
                code: 'Escape',
                bubbles: true,
                cancelable: true,
            });
            const handled = !window.dispatchEvent(event) || event.defaultPrevented;
            if (!handled) void plugin.exitApp().catch(() => undefined);
        });

        Promise.resolve(registered)
            .then(handle => {
                if (disposed) {
                    void handle.remove();
                    return;
                }
                listenerHandle = handle;
            })
            .catch(() => undefined);

        return () => {
            disposed = true;
            if (listenerHandle) void listenerHandle.remove();
        };
    }, []);
};

export default useNativeBackButton;
