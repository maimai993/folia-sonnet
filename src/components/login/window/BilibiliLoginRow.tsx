import React from 'react';
import QRCode from 'qrcode';
import { useTranslation } from 'react-i18next';
import { useBilibiliAuthStore } from '../../../stores/useBilibiliAuthStore';
import { Button } from '../../ui/Button';

// src/components/login/window/BilibiliLoginRow.tsx
// 通用登录面板里多出来的那一个条目：B 站。
//
// 它**不是平台**。那一列里每一行选中都意味着「换掉音乐从哪来」，而 B 站只为让 MV
// 拿到更高画质（未登录 480p）。所以这一条只做三件事：扫码登录、看状态、退出 ——
// 不参与切换，不进 providerRegistry，也不改 activeProviderId。
//
// 凭据直接进原生 CookieManager（services/bilibili/login.ts），渲染层拿不到、也不存。

/** 这一行在平台列里的位置感：和上面那些行一样的左内边距。 */
const ROW_PAD = 'px-3';

const BilibiliLoginRow: React.FC = () => {
    const { t } = useTranslation();
    const available = useBilibiliAuthStore(state => state.available);
    const signedIn = useBilibiliAuthStore(state => state.signedIn);
    const uid = useBilibiliAuthStore(state => state.uid);
    const qrUrl = useBilibiliAuthStore(state => state.qrUrl);
    const qrState = useBilibiliAuthStore(state => state.qrState);
    const message = useBilibiliAuthStore(state => state.message);
    const busy = useBilibiliAuthStore(state => state.busy);
    const hydrate = useBilibiliAuthStore(state => state.hydrate);
    const startLogin = useBilibiliAuthStore(state => state.startLogin);
    const cancelLogin = useBilibiliAuthStore(state => state.cancelLogin);
    const signOut = useBilibiliAuthStore(state => state.signOut);

    const [qrImage, setQrImage] = React.useState('');

    React.useEffect(() => {
        void hydrate();
    }, [hydrate]);

    // 二维码内容 → data URL。qrcode 是纯前端库，不联网。
    React.useEffect(() => {
        if (!qrUrl) {
            setQrImage('');
            return;
        }
        let alive = true;
        void QRCode.toDataURL(qrUrl, { margin: 1, width: 200, errorCorrectionLevel: 'M' })
            .then(url => { if (alive) setQrImage(url); })
            .catch(() => { if (alive) setQrImage(''); });
        return () => { alive = false; };
    }, [qrUrl]);

    // 离开面板就把轮询停了，别让它在后台一直打接口。
    React.useEffect(() => () => cancelLogin(), [cancelLogin]);

    if (!available) return null;

    const statusText = () => {
        if (signedIn) return uid ? t('options.bilibiliSignedInAs').replace('{uid}', uid) : t('options.bilibiliSignedIn');
        if (qrState === 'scanned') return t('options.bilibiliQrScanned');
        if (qrState === 'confirmed') return t('options.bilibiliQrConfirming');
        if (qrState === 'expired') return t('options.bilibiliQrExpired');
        if (qrState === 'error') return message || t('options.bilibiliQrError');
        return t('options.bilibiliQrWaiting');
    };

    return (
        <div className={`flex flex-col gap-1 border-t border-[var(--st-line)] pt-2 ${ROW_PAD}`}>
            <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium">{t('options.bilibiliLogin')}</span>
                <span className="text-[11px] text-[var(--text-secondary)]">
                    {signedIn ? statusText() : t('options.bilibiliOnlyCredentials')}
                </span>
            </div>
            <div className="flex items-center gap-2">
                <Button
                    variant="bare"
                    disabled={busy}
                    onClick={() => { void (signedIn ? signOut() : startLogin()); }}
                    className="rounded-md px-2 py-1 text-[12px] text-[var(--text-secondary)] hover:bg-white/5 hover:text-[var(--text-primary)]"
                >
                    {signedIn ? t('options.bilibiliSignOut') : t('options.bilibiliLogin')}
                </Button>
            </div>
            {qrImage ? (
                <div className="flex flex-col items-center gap-1 py-1">
                    <img
                        src={qrImage}
                        alt={t('options.bilibiliQrAlt')}
                        className="h-[152px] w-[152px] rounded-md bg-white p-1.5"
                    />
                    <span className="text-[11px] text-[var(--text-secondary)]">{statusText()}</span>
                </div>
            ) : null}
        </div>
    );
};

export default BilibiliLoginRow;
