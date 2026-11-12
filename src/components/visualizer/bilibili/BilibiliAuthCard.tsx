import React from 'react';
import QRCode from 'qrcode';
import { Group, type SettingsGroupDef } from '../../modal/settings/kit';
import { ToggleRow } from '../panelRows';
import { useBilibiliAuthStore } from '../../../stores/useBilibiliAuthStore';

// src/components/visualizer/bilibili/BilibiliAuthCard.tsx
// 「B 站 MV」的登录卡片。
//
// 这是**独立的登录**，不参与 folia 的统一登录面板：那面板管理的是在线音源
// （切歌要从哪儿取流），而 B 站只为一件事服务 —— 让 MV 能拿到更高画质。
// 未登录看 480p，登录了大会员能到 1080p。所以它不进切换器，也不改当前平台。
//
// 扫码走 bilibili 网页端那套接口（services/bilibili/login.ts）；凭据直接进
// 原生 CookieManager，渲染层拿不到、也不存。

const BILIBILI_GROUP: SettingsGroupDef = { id: 'bg-bilibili-auth', titleKey: 'options.bilibiliMvSettings' };

interface BilibiliAuthCardProps {
    t: (key: string) => string;
}

const BilibiliAuthCard: React.FC<BilibiliAuthCardProps> = ({ t }) => {
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
        void QRCode.toDataURL(qrUrl, { margin: 1, width: 220, errorCorrectionLevel: 'M' })
            .then(url => { if (alive) setQrImage(url); })
            .catch(() => { if (alive) setQrImage(''); });
        return () => { alive = false; };
    }, [qrUrl]);

    // 关掉卡片时把轮询停了，别让它在后台一直打接口。
    React.useEffect(() => () => cancelLogin(), [cancelLogin]);

    const statusText = () => {
        if (signedIn) return uid ? t('options.bilibiliSignedInAs').replace('{uid}', uid) : t('options.bilibiliSignedIn');
        if (qrState === 'scanned') return t('options.bilibiliQrScanned');
        if (qrState === 'confirmed') return t('options.bilibiliQrConfirming');
        if (qrState === 'expired') return t('options.bilibiliQrExpired');
        if (qrState === 'error') return message || t('options.bilibiliQrError');
        return t('options.bilibiliQrWaiting');
    };

    return (
        <Group def={BILIBILI_GROUP}>
            <ToggleRow
                label={t('options.bilibiliLogin')}
                note={
                    available
                        ? signedIn
                            ? t('options.bilibiliLoginHintSignedIn')
                            : t('options.bilibiliLoginHint')
                        : t('options.bilibiliUnsupported')
                }
                checked={signedIn}
                disabled={!available || busy}
                onChange={enable => {
                    if (!enable) {
                        void signOut();
                        return;
                    }
                    void startLogin();
                }}
            />
            {qrImage ? (
                <div className="flex flex-col items-center gap-2 py-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src={qrImage}
                        alt={t('options.bilibiliQrAlt')}
                        className="h-[220px] w-[220px] rounded-lg bg-white p-2"
                    />
                    <span className="text-xs text-[var(--text-secondary)]">{statusText()}</span>
                </div>
            ) : null}
            {available && signedIn ? (
                <p className="px-1 pb-2 text-xs text-[var(--text-secondary)]">
                    {t('options.bilibiliSignOutHint')}
                </p>
            ) : null}
        </Group>
    );
};

export default BilibiliAuthCard;
