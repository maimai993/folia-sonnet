import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Row } from './kit';
import type { SettingsOptionDef } from './kit';
import { isCapacitorAndroid } from '../../../platform/runtime';
import {
    openKeepAliveSettings,
    readKeepAliveStatus,
    requestBatteryExemption,
    type KeepAliveStatus,
} from '../../../platform/keepAlive';

// src/components/modal/settings/AndroidKeepAliveSetting.tsx
// 播放控制 → 播放行为里那一行「后台运行」。
//
// 为什么需要用户手动点：国内 ROM 的省电策略没有统一 API，应用既不能替用户授权，
// 也不能可靠地探测「还剩几道开关没过」。能做的只有如实显示**唯一可读**的那一条
// （电池优化白名单），再把用户送到各家自启动 / 耗电页 —— 剩下的交给用户点一下。
//
// 这一行不做「自动保活」：不轮询、不后台唤起。真正的保活是前台服务 + 系统白名单，
// 前者已经在跑（FoliaPlaybackService），后者只能由用户授权。
//
// 只在安卓原生壳里出现：桌面端没有这回事，网页版也没有。

type Props = { def: SettingsOptionDef };

const AndroidKeepAliveSetting: React.FC<Props> = ({ def }) => {
    const { t } = useTranslation();
    const [status, setStatus] = React.useState<KeepAliveStatus | null>(null);
    /*
     * 上一次跳转落到了哪一页。
     *
     * 只在「猜不中、退到应用详情页」时才有用：那时用户看到的是应用信息页，
     * 和一个说「去设置里开自启动」的提示对不上，会以为按钮坏了。文案要说清楚
     * 「接下来点哪里」。正常跳过去（autostart / battery）就不必多话，清空。
     */
    const [fellBack, setFellBack] = React.useState(false);
    const [busy, setBusy] = React.useState(false);

    const refresh = React.useCallback(async () => {
        setStatus(await readKeepAliveStatus());
    }, []);

    /*
     * 每次打开设置页读一次，回到前台再读一次 —— 用户点完按钮就跳去系统设置了，
     * 回来时状态可能已经变了，不重读会一直显示「未授权」。
     */
    React.useEffect(() => {
        void refresh();
        const onVisible = () => {
            if (document.visibilityState === 'visible') void refresh();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [refresh]);

    if (!isCapacitorAndroid()) return null;
    // 读不到（老 APK 没这三个方法、或系统不给读）：整行不画，
    // 而不是画一个恒为「未授权」的假状态骗用户反复点。
    if (status === null) return null;

    const run = async (action: () => Promise<unknown>) => {
        if (busy) return;
        setBusy(true);
        try {
            await action();
        } finally {
            setBusy(false);
            // 系统对话框与设置页都是跳出去再回来，回来时值可能已经变了。
            void refresh();
        }
    };

    const askBattery = () => run(async () => {
        const result = await requestBatteryExemption();
        setFellBack(result ? !result.opened : false);
    });

    const askAutostart = () => run(async () => {
        const landed = await openKeepAliveSettings('autostart');
        setFellBack(landed === 'details');
    });

    const hint = fellBack
        ? t('options.keepAliveFellBack')
        : status.ignoringBatteryOptimizations
            ? t('options.keepAliveGranted')
            : t('options.keepAliveMissing', {
                // ROM 标签是原生按 Build.BRAND 猜的，猜不出来时用泛称，别显示空串。
                rom: status.rom || t('options.keepAliveRomGeneric'),
            });

    return (
        <Row option={def} hint={hint}>
            {/*
              已豁免时不再给「允许后台运行」按钮：那一颗按下去也是弹同一个对话框，
              点完没有任何变化，只会让人怀疑是不是没生效。自启动那颗仍然留着 ——
              国产 ROM 里它是另一道闸，与电池优化白名单互不覆盖。
            */}
            {!status.ignoringBatteryOptimizations && (
                <Button variant="quiet" disabled={busy} onClick={askBattery}>
                    {t('options.keepAliveActionBattery')}
                </Button>
            )}
            {status.rom !== '' && (
                <Button variant="quiet" disabled={busy} onClick={askAutostart}>
                    {t('options.keepAliveActionAutostart')}
                </Button>
            )}
        </Row>
    );
};

export default AndroidKeepAliveSetting;
