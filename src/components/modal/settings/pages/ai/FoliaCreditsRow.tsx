import React from 'react';
import { CalendarCheck, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Row, Value, option, type SettingsOptionDef } from '../../kit';
import { ensureMachineCode } from '../../../../../services/foliaMachineCode';
import { setStatusMessage } from '../../../../../stores/useStatusMessageStore';
import { fetchFoliaCredits, type FoliaCredits } from '../../../../../services/foliaCredits';
import { FOLIA_CHECKIN_URL } from '../../../../../services/aiText';

// src/components/modal/settings/pages/ai/FoliaCreditsRow.tsx
// 免费渠道的「剩余额度」那一行，以及复制机器码那个小工具。
//
// 为什么值得单独一个文件：桌面设置页要用它，机器码复制失败时的提示也要走同一条路径 ——
// 两处各写一遍的话，迟早有一处忘了处理「复制失败」这种必须告诉用户的情况。

/**
 * 复制机器码。老浏览器 / 非安全上下文里 navigator.clipboard 不存在，落回临时 textarea。
 *
 * 用户拿不到这串东西就绑不了号、签不了到 —— 这条渠道的第一步全押在这一次复制上，
 * 所以失败必须明说（提示手动复制），不能静默什么都不发生。
 */
export const copyMachineCode = async (code: string, t: (key: string) => string): Promise<void> => {
    const done = (): void => { setStatusMessage({ type: 'success', text: t('options.aiMachineCodeCopied'), nonce: Date.now() }); };
    const failed = (): void => { setStatusMessage({ type: 'error', text: t('options.aiMachineCodeCopyFailed'), nonce: Date.now() }); };
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(code);
            done();
            return;
        }
    } catch {
        // 落到下面的兜底
    }
    try {
        const area = document.createElement('textarea');
        area.value = code;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        if (ok) done(); else failed();
    } catch {
        failed();
    }
};

/**
 * 剩余额度：打开设置时问一次，点「刷新」再问一次。
 *
 * 四种状态要分清，别都糊成一句话：
 *   没绑定   → 让用户去群里发机器码
 *   已停用   → 说明换了机器码要重绑
 *   查不到   → 是网络/后台的问题，不是用户的问题
 *   有数字   → 就报数字
 */
/**
 * 签到按钮：和「刷新」**同一个写法**（kit 的 Button + 一个图标），并排放在同一行。
 *
 * 点开之后在下面显示一张卡片，卡片里**只有一层 Cloudflare 控件**，没有标题、没有说明、
 * 也没有第二个按钮 —— 验证一通过就自动签到，然后收起卡片、刷新额度。
 *
 * 卡片是**块级**的（不绝对定位）：之前用 absolute 展开会跑出可视区，这是那个 bug 的根因。
 */
export const FoliaCheckinButton: React.FC<{ credits: FoliaCredits | null; onCheckedIn: () => void }> = ({ credits, onCheckedIn }) => {
    const { t } = useTranslation();
    const [open, setOpen] = React.useState(false);

    const ready = Boolean(credits?.bound) && !credits?.disabled;
    const done = credits?.checkedInToday === true;

    React.useEffect(() => {
        if (!open) return undefined;
        const onMessage = (event: MessageEvent): void => {
            const data = event.data as { source?: unknown; kind?: unknown; text?: unknown } | null;
            if (!data || data.source !== 'folia-checkin') return;
            if (data.kind === 'ok') {
                setStatusMessage({ type: 'success', text: String(data.text || t('options.aiCheckinDone')), nonce: Date.now() });
                onCheckedIn();
                setOpen(false);
            } else if (data.kind === 'err') {
                setStatusMessage({ type: 'error', text: String(data.text || t('options.aiCheckinFailed')), nonce: Date.now() });
            }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [open, onCheckedIn, t]);

    return (
        <>
            <Button
                icon={CalendarCheck}
                onClick={() => setOpen(value => !value)}
                disabled={!ready || done}
                tip={!ready ? t('options.aiCheckinUnbound') : undefined}
            >
                {done ? t('options.aiCheckinDone') : t('options.aiCheckinAction')}
            </Button>
            {open && !done && (
                /* 一张卡片，里面只有 CF 控件。块级布局，不会再跑出屏幕。 */
                <span className="mt-2 block w-full max-w-[320px] overflow-hidden rounded-xl border" style={{ borderColor: 'var(--border-color, rgba(127,127,127,.3))' }}>
                    <iframe
                        title="Folia check-in"
                        src={`${FOLIA_CHECKIN_URL}${encodeURIComponent(ensureMachineCode())}`}
                        style={{ display: 'block', width: '100%', height: 110, border: 0 }}
                    />
                </span>
            )}
        </>
    );
};

export const FoliaCreditsRow: React.FC<{ option?: SettingsOptionDef }> = ({ option }) => {
    const { t } = useTranslation();
    const [state, setState] = React.useState<'loading' | 'ready' | 'unknown'>('loading');
    const [credits, setCredits] = React.useState<Awaited<ReturnType<typeof fetchFoliaCredits>>>(null);

    const load = React.useCallback(async (): Promise<void> => {
        setState('loading');
        const result = await fetchFoliaCredits();
        setCredits(result);
        setState(result === null ? 'unknown' : 'ready');
    }, []);

    React.useEffect(() => {
        void load();
    }, [load]);

    const label = ((): string => {
        if (state === 'loading') return t('options.aiCreditsLoading');
        if (state === 'unknown') return t('options.aiCreditsUnknown');
        if (!credits?.bound) return t('options.aiCreditsUnbound');
        if (credits.disabled) return t('options.aiCreditsDisabled');
        if (credits.remaining === null) return t('options.aiCreditsUnlimited');
        return t('options.aiCreditsRemaining', { remaining: credits.remaining });
    })();

    return (
        <>
            <Row
                option={option}
                /* 上次实际跑的是哪个模型 —— auto 会换，只写「自动」等于什么都没说。 */
                hint={credits?.lastModel ? t('options.aiLastModel', { model: credits.lastModel }) : undefined}
            >
                <Value>{label}</Value>
                <Button icon={RefreshCw} onClick={() => { void load(); }} disabled={state === 'loading'}>
                    {t('options.aiCreditsRefresh')}
                </Button>
                <FoliaCheckinButton credits={credits} onCheckedIn={() => { void load(); }} />
            </Row>
        </>
    );
};
