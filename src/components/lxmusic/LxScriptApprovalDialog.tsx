import React from 'react';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ThemedDialog from '../../components/shared/ThemedDialog';
import { SheetButton } from '../../components/shared/Sheet';
import type { LxSourceMeta } from '../../services/onlineMusic/lxmusic/lxTypes';

// src/components/lxmusic/LxScriptApprovalDialog.tsx
// 洛雪音源脚本的「执行前确认」（C2）。
//
// 音源是用户从网上拿来的第三方脚本。升级前它直接在页面主线程里跑，等于把 localStorage
// （含登录态）、Capacitor 原生桥、electron 桥全交给它。现在它在专用 worker 沙箱里跑，手里只剩
// 一张能力清单 —— 但清单里「能发 HTTP 请求」这一条仍然值得让用户看一眼再决定。
//
// 这个框要回答的是「这个脚本能做什么」，而不是复述一句「有风险」：
//   · 它能请求任意公网地址（音源服务器域名千奇百怪，不能按域名放行）；不能读本地数据、不能碰界面；
//   · 它能声明哪些平台（wy / kg / tx / kw / mg / qs / local），用户据此判断是不是自己要的那个源；
//   · 脚本自己在前 4000 字符的注释里声称的名字 / 作者 / 版本 —— 只是它自称的，不是验证过的；
//   · 指纹（脚本正文的 sha256）。脚本改一个字指纹就变，下次会重新问。
//
// 左边是「取消」，右边才是「同意并运行」：默认动作不是放行。

export interface LxPendingScript {
    /** 音源 id（导入时的 uuid），确认记录按它存。 */
    sourceId: string;
    meta: LxSourceMeta;
    /** 脚本正文字数，让用户知道这份东西大概多大。 */
    sizeBytes: number;
    /** 正文的 sha256，完整显示。 */
    fingerprint: string;
    /** 脚本正文里出现的平台键（静态扫出来的，只是提示；真正的平台以运行后的 inited 为准）。 */
    platforms: string[];
}

interface LxScriptApprovalDialogProps {
    pending: LxPendingScript | null;
    isDaylight: boolean;
    /** 用户同意。 */
    onConfirm: () => void;
    /** 用户取消 —— 意味着这份脚本不会被导入 / 不会被执行。 */
    onCancel: () => void;
}

const Line: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="flex items-start gap-3 text-xs">
        <span className="w-20 shrink-0 text-[color:var(--text-secondary)]">{label}</span>
        <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
);

export const LxScriptApprovalDialog: React.FC<LxScriptApprovalDialogProps> = ({
    pending, isDaylight, onConfirm, onCancel,
}) => {
    const { t } = useTranslation();
    const meta = pending?.meta;
    const platforms = pending?.platforms ?? [];

    return (
        <ThemedDialog
            isOpen={pending !== null}
            onClose={onCancel}
            isDaylight={isDaylight}
            title={t('lxmusic.approval.title')}
            description={meta ? t('lxmusic.approval.message', { name: meta.name }) : undefined}
            size="m"
            footer={(
                <>
                    <SheetButton onClick={onCancel}>{t('common.cancel')}</SheetButton>
                    <SheetButton variant="primary" onClick={onConfirm}>{t('lxmusic.approval.run')}</SheetButton>
                </>
            )}
        >
            {pending && meta && (
                <div className="space-y-2.5">
                    <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
                        <TriangleAlert size={14} className="mt-px shrink-0" />
                        <span>{t('lxmusic.approval.risk')}</span>
                    </div>

                    <Line label={t('lxmusic.approval.canDo')}>
                        <ul className="space-y-1">
                            <li>{t('lxmusic.approval.canNetwork')}</li>
                            <li>{t('lxmusic.approval.cannotLocal')}</li>
                            <li>{t('lxmusic.approval.cannotUi')}</li>
                        </ul>
                    </Line>

                    <Line label={t('lxmusic.approval.declares')}>
                        {platforms.length > 0
                            ? platforms.map((key) => t(`lxmusic.platform.${key}`, { defaultValue: key })).join(' · ')
                            : t('lxmusic.approval.declaresUnknown')}
                    </Line>

                    {(meta.author || meta.version || meta.homepage) && (
                        <Line label={t('lxmusic.approval.claims')}>
                            <ul className="space-y-0.5">
                                {meta.version && <li>{t('lxmusic.approval.claimVersion', { value: meta.version })}</li>}
                                {meta.author && <li>{t('lxmusic.approval.claimAuthor', { value: meta.author })}</li>}
                                {meta.homepage && <li className="break-all">{t('lxmusic.approval.claimHomepage', { value: meta.homepage })}</li>}
                            </ul>
                        </Line>
                    )}

                    <Line label={t('lxmusic.approval.size')}>
                        {t('lxmusic.approval.sizeValue', { count: pending.sizeBytes })}
                    </Line>

                    <Line label={t('lxmusic.approval.fingerprint')}>
                        <span className="break-all font-mono text-[11px]">{pending.fingerprint}</span>
                    </Line>

                    <p className="text-xs text-[color:var(--text-secondary)]">{t('lxmusic.approval.rebind')}</p>
                </div>
            )}
        </ThemedDialog>
    );
};
