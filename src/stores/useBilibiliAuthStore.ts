import { create } from 'zustand';
import {
    clearBilibiliCookiesNative,
    readBilibiliAuthNative,
    saveBilibiliCookiesNative,
} from '../platform/foliaNative';
import { isBilibiliAvailable } from '../services/bilibili/transport';
import { exchangeLogin, generateQrCode, pollQrCode, type BilibiliQrState } from '../services/bilibili/login';

// src/stores/useBilibiliAuthStore.ts
//
// bilibili 扫码登录的状态机。
//
// 它**不参与 folia 的账号体系**：登录只是为 MV 换来一组 cookie，存进原生
// CookieManager 就完事，不影响在线音源、切换器、任何 ProviderAccountSummary。
// 所以这里没有 providerId，也没有「当前平台」的概念 —— 就是一个独立的开关。
//
// 流程见 services/bilibili/login.ts。轮询由一个 2 秒的定时器推，窗口关掉就停。

const POLL_INTERVAL_MS = 2000;

interface BilibiliAuthState {
    /** 原生桥在不在（不在就是桌面/网页版，整块都不可用）。 */
    available: boolean;
    signedIn: boolean;
    uid: string;
    /** 二维码内容；非空表示正在等扫码。 */
    qrUrl: string;
    /** 轮询用的 key。 */
    qrKey: string;
    qrState: BilibiliQrState;
    /** 出错时要给用户看的一句话。 */
    message: string;
    busy: boolean;
}

interface BilibiliAuthActions {
    /** 启动时问一次登录态。 */
    hydrate: () => Promise<void>;
    /** 申请二维码并开始轮询。 */
    startLogin: () => Promise<void>;
    /** 停止轮询、清掉二维码。 */
    cancelLogin: () => void;
    /** 注销：清掉原生 cookie。 */
    signOut: () => Promise<void>;
}

export type BilibiliAuthStore = BilibiliAuthState & BilibiliAuthActions;

/** 轮询定时器放模块作用域：它只是「有没有在跑」，不是渲染状态。 */
let pollTimer: ReturnType<typeof setInterval> | null = null;

const stopPoll = () => {
    if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
};

const emptyQr = (): Pick<BilibiliAuthState, 'qrUrl' | 'qrKey' | 'qrState' | 'message'> => ({
    qrUrl: '',
    qrKey: '',
    qrState: 'waiting',
    message: '',
});

export const useBilibiliAuthStore = create<BilibiliAuthStore>()((set, get) => ({
    available: false,
    signedIn: false,
    uid: '',
    qrUrl: '',
    qrKey: '',
    qrState: 'waiting',
    message: '',
    busy: false,

    hydrate: async () => {
        const available = isBilibiliAvailable();
        if (!available) {
            set({ available: false, signedIn: false });
            return;
        }
        const status = await readBilibiliAuthNative();
        set({ available: true, signedIn: status.signedIn, uid: status.uid });
    },

    startLogin: async () => {
        stopPoll();
        set({ busy: true, ...emptyQr() });
        try {
            const qr = await generateQrCode();
            set({ qrUrl: qr.url, qrKey: qr.qrcodeKey, qrState: 'waiting', busy: false });

            pollTimer = setInterval(() => {
                const key = get().qrKey;
                if (!key) {
                    stopPoll();
                    return;
                }
                void (async () => {
                    try {
                        const poll = await pollQrCode(key);
                        if (poll.state === 'waiting' || poll.state === 'scanned') {
                            set({ qrState: poll.state });
                            return;
                        }
                        stopPoll();
                        if (poll.state === 'expired') {
                            set({ qrState: 'expired', message: '二维码过期了，重新点一次扫码登录' });
                            return;
                        }
                        if (poll.state === 'confirmed') {
                            const redirect = poll.redirectUrl;
                            if (!redirect) {
                                set({ qrState: 'error', message: 'bilibili 没有给跳转地址' });
                                return;
                            }
                            set({ qrState: 'confirmed', busy: true });
                            const exchange = await exchangeLogin(redirect);
                            const saved = await saveBilibiliCookiesNative(exchange.cookie);
                            if (!saved) {
                                set({ busy: false, message: '凭据没能存进设备' });
                                return;
                            }
                            set({
                                busy: false,
                                signedIn: true,
                                uid: exchange.uid,
                                ...emptyQr(),
                            });
                        }
                    } catch (error) {
                        stopPoll();
                        set({
                            qrState: 'error',
                            message: error instanceof Error ? error.message : String(error),
                        });
                    }
                })();
            }, POLL_INTERVAL_MS);
        } catch (error) {
            set({
                busy: false,
                qrState: 'error',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    },

    cancelLogin: () => {
        stopPoll();
        set(emptyQr());
    },

    signOut: async () => {
        stopPoll();
        await clearBilibiliCookiesNative();
        set({ signedIn: false, uid: '', ...emptyQr() });
    },
}));
