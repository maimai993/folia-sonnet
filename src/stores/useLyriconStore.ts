import { create } from 'zustand';
import { getStoredBoolean, setStoredBoolean } from './storagePrimitives';
import { getLyriconStatus, setLyriconEnabled } from '../platform/foliaLyricon';

// src/stores/useLyriconStore.ts
// 状态栏歌词（Lyricon）的开关与连接状态。
//
// 开关本身落在 localStorage：它是个用户偏好，跟账号无关，也不该每次启动都被重置。
// 「有没有连上」是运行时状态，只有真正去注册一次才知道，所以另外存一份。

const LYRICON_ENABLED_STORAGE_KEY = 'folia.lyriconEnabled';

type LyriconState = {
    enabled: boolean;
    /** 中心服务是否真的连上了。false 多半意味着设备上没装 Lyricon。 */
    connected: boolean;
    handleToggleLyricon: (enable: boolean) => void;
    /** 启动时把开关同步给原生，并问一次连接状态。 */
    syncLyriconStatus: () => void;
};

export const useLyriconStore = create<LyriconState>((set, get) => ({
    enabled: getStoredBoolean(LYRICON_ENABLED_STORAGE_KEY, false),
    connected: false,
    handleToggleLyricon: (enable) => {
        setStoredBoolean(LYRICON_ENABLED_STORAGE_KEY, enable);
        set({ enabled: enable });
        void setLyriconEnabled(enable).then((result) => {
            // 注册失败（没装 Lyricon / 版本不兼容）时把开关弹回去，
            // 免得界面一直显示「已开启」而状态栏什么都没有。
            if (enable && !result.connected) {
                set({ connected: false });
                return;
            }
            set({ connected: result.connected });
        });
    },
    syncLyriconStatus: () => {
        const enabled = get().enabled;
        void setLyriconEnabled(enabled).then((result) => {
            set({ connected: result.connected });
        });
        void getLyriconStatus().then((result) => {
            set({ connected: result.connected });
        });
    },
}));
