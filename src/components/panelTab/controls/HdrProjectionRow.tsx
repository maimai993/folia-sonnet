import React, { useEffect, useState } from 'react';
import { Projector, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../../../types';
import { Toggle } from '../../modal/settings/kit';
import {
    disableHdrProjection,
    readDisplayBoostResult,
    readHdrProjectionCountdown,
    readStoredHdrProjection,
    startHdrProjectionCountdown,
    subscribeDisplayBoostResult,
    subscribeHdrProjectionCountdown,
} from '../../../services/hdrProjection';
import { Button } from '../../ui';

// src/components/panelTab/controls/HdrProjectionRow.tsx
// 控制面板里的「HUD 投影」：锁横屏 + 亮度顶满 + 整屏左右镜像，为的是把手机躺在
// 仪表台上、画面经挡风玻璃反射过来当抬头显示用。
//
// 打开不是立刻生效 —— 先数 5 秒。翻横屏那一刻手机多半正拿在手里，数完再翻，用户
// 有时间把它放稳；这 5 秒里开关旁边显示还剩几秒，旁边那颗「取消」随时能掐掉。
//
// 只在安卓上出现：亮度与色彩模式是 Activity 窗口的属性，浏览器里根本够不着，摆着
// 也只会得到一个不完整的开关（其余三件事倒是都能做，但那不是这个开关的用途）。

const isAndroidNativeRuntime = (): boolean => (
    typeof window !== 'undefined'
    && (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() === 'android'
);

interface HdrProjectionRowProps {
    theme: Theme;
}

const HdrProjectionRow: React.FC<HdrProjectionRowProps> = ({ theme }) => {
    const { t } = useTranslation();
    const [enabled, setEnabled] = useState(() => readStoredHdrProjection());
    const [remaining, setRemaining] = useState(() => readHdrProjectionCountdown());
    /*
     * 亮度那一趟的结果在倒计时数完之后才回来（服务里异步推给原生），所以它跟
     * 「还剩几秒」一样是订阅来的 —— 数完那一下自己会送到这里。
     */
    const [brightness, setBrightness] = useState(() => readDisplayBoostResult());

    /*
     * 倒计时只有一个（收在 services/hdrProjection.ts），启动时那条路与手动拨开关
     * 共用它 —— 所以这里不是「自己数 5 秒」，而是订阅那一个：启动那一趟还在数的时候
     * 打开面板，看到的就是它剩下的秒数，取消也取消的是同一个。
     */
    useEffect(() => subscribeHdrProjectionCountdown(setRemaining), []);
    useEffect(() => subscribeDisplayBoostResult(setBrightness), []);

    useEffect(() => {
        // 数完那一下由服务写盘并生效；取消同理。两边都把开关的状态拉回实际值。
        if (remaining === 0) setEnabled(readStoredHdrProjection());
    }, [remaining]);

    if (!isAndroidNativeRuntime()) return null;

    const on = enabled || remaining > 0;

    return (
        <div>
            <div className="flex min-h-11 items-center gap-3 px-1 py-1.5">
                <Projector
                    size={16}
                    className="shrink-0"
                    style={on ? { color: theme.accentColor } : { opacity: 0.4 }}
                />
                <span className="shrink-0 text-sm leading-5">{t('ui.hdrProjectionTitle', 'HUD 投影')}</span>
                <span
                    className="min-w-0 flex-1 truncate text-[10px] tabular-nums"
                    style={{ color: 'var(--text-secondary)', opacity: remaining > 0 ? 1 : 0.5 }}
                >
                    {remaining > 0
                        ? t('ui.hdrProjectionCountdown', '{{count}} 秒后生效').replace('{{count}}', String(remaining))
                        : t('ui.hdrProjectionHint', '横屏 · 最亮 · 镜像')}
                </span>
                {remaining > 0 && (
                    <Button
                        onClick={() => {
                            disableHdrProjection();
                            setEnabled(false);
                        }}
                        className="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-1 text-[10px] font-semibold opacity-60 transition-opacity hover:opacity-100"
                        style={{ color: 'var(--text-secondary)' }}
                    >
                        <X size={11} />
                        {t('ui.hdrProjectionCancel', '取消')}
                    </Button>
                )}
                <Toggle
                    checked={on}
                    label={t('ui.hdrProjectionTitle', 'HUD 投影')}
                    onChange={(next) => {
                        if (next) {
                            setEnabled(true);
                            startHdrProjectionCountdown();
                            return;
                        }
                        /*
                         * 关掉是**立刻**的，没有倒计时：亮度顶在那儿刺眼，
                         * 画面还是反的，等 5 秒毫无意义。
                         */
                        disableHdrProjection();
                        setEnabled(false);
                    }}
                />
            </div>
            <p className="px-1 pb-1 text-[10px] leading-4" style={{ color: 'var(--text-secondary)', opacity: 0.55 }}>
                {t('ui.hdrProjectionNote', '屏幕朝上放着，画面经挡风玻璃反射回来才是正的 —— 关掉即还原。')}
                {on && !brightness.systemBrightness && (
                    <>
                        <br />
                        {t('ui.hdrProjectionBrightnessNote', '系统亮度没被改动：需要系统设置里的「修改系统设置」权限，没给的话只在 App 内提亮。')}
                    </>
                )}
            </p>
        </div>
    );
};

export default HdrProjectionRow;
