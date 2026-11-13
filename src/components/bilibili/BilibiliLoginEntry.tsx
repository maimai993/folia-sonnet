import React from 'react';
import { useTranslation } from 'react-i18next';
import { Sheet } from '../shared/Sheet';
import BilibiliAuthCard from './BilibiliAuthCard';
import { useBilibiliAuthStore } from '../../stores/useBilibiliAuthStore';

// src/components/bilibili/BilibiliLoginEntry.tsx
// 统一登录面板里的「B 站」入口：从这里可以扫码登录、退出，但**不能切换过去**。
//
// 为什么不在平台那一列：那一列是「音乐从哪来」，选中它就换了取流的地方。
// B 站只为一件事服务 —— 让 MV 拿到更高画质（未登录 480p，登录了能到更高），
// 它不参与取流，也不该成为当前平台。所以它是一颗单独的入口，凭据单独存，
// 点开会话不动 activeProviderId。
//
// 只在安卓出现（MV 只在那里能用）；别处整颗入口不画。

type Props = {
    /** 侧栏里那颗按钮的样子由调用方决定，这里只管开关与内容。 */
    children?: (open: () => void) => React.ReactNode;
};

const BilibiliLoginEntry: React.FC<Props> = ({ children }) => {
    const { t } = useTranslation();
    const available = useBilibiliAuthStore(state => state.available);
    const signedIn = useBilibiliAuthStore(state => state.signedIn);
    const [open, setOpen] = React.useState(false);

    if (!available) return null;

    return (
        <>
            {children?.(() => setOpen(true))}
            <Sheet isOpen={open} onClose={() => setOpen(false)} size="side" title={t('options.bilibiliLogin')}>
                <div className="flex flex-col gap-2 px-1 py-2">
                    <p className="px-1 text-xs text-[var(--text-secondary)]">
                        {signedIn
                            ? t('options.bilibiliLoginHintSignedIn')
                            : t('options.bilibiliLoginHint')}
                    </p>
                    <BilibiliAuthCard t={t} />
                    <p className="px-1 text-xs text-[var(--text-secondary)]">
                        {t('options.bilibiliNoSwitchHint')}
                    </p>
                </div>
            </Sheet>
        </>
    );
};

export default BilibiliLoginEntry;
