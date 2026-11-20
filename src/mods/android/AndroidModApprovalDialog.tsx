import React from 'react';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ModRuntimeInfo } from '../types';
import ThemedDialog from '../../components/shared/ThemedDialog';
import { SheetButton } from '../../components/shared/Sheet';

// src/mods/android/AndroidModApprovalDialog.tsx
// 安卓端的「启用模组」确认框。
//
// 桌面端这一步是主进程里的原生对话框（electron/modSystem/approval.cjs）：渲染进程里的代码
// 伪造不了它，也点不动它。安卓没有主进程窗口，只能在渲染进程里画 —— 这两者并不等价，所以
// 这里做两件事：把「用户到底同意了什么」讲得和桌面端一样清楚；把这份同意绑定到眼前这一份
// 内容摘要上（摘要随 setModEnabled 交给宿主复核，文件在确认之后变了就拒绝启用）。
//
// 列出的条目对应桌面确认框：模组身份、声明的权限、进程能力、有没有 Node 入口、内容指纹。
// 默认（左边）是「取消」，「仍要启用」在右边，不让误触直接放行一份能读写本机文件的代码。

interface AndroidModApprovalDialogProps {
    /** 待确认的模组；null 表示没有待确认的模组，弹窗关闭。 */
    mod: ModRuntimeInfo | null;
    isDaylight: boolean;
    pending: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="flex items-start gap-3 text-xs">
        <span className="w-20 shrink-0 text-[color:var(--text-secondary)]">{label}</span>
        <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
);

/**
 * 进程能力（mod.json 的 `processes`）的说明。认不出的能力原样显示 id：用户至少要知道
 * 这个模组额外要了东西，而不是看到一行空白。
 */
const PROCESS_CAPABILITY_TEXT: Record<string, string> = {
    'worker-threads': 'mods.approval.processWorkerThreads',
    'process.run': 'mods.approval.processRun',
    'network.socket': 'mods.approval.processSocket',
};

export const AndroidModApprovalDialog: React.FC<AndroidModApprovalDialogProps> = ({
    mod, isDaylight, pending, onCancel, onConfirm,
}) => {
    const { t } = useTranslation();
    const processes = mod?.processes ?? [];
    const permissions = mod?.permissions ?? [];

    return (
        <ThemedDialog
            isOpen={mod !== null}
            onClose={pending ? () => undefined : onCancel}
            isDaylight={isDaylight}
            title={t('mods.approval.title')}
            description={mod ? t('mods.approval.message', { name: mod.name, id: mod.id }) : undefined}
            size="m"
            closeDisabled={pending}
            footer={(
                <>
                    <SheetButton onClick={onCancel} disabled={pending}>
                        {t('common.cancel')}
                    </SheetButton>
                    <SheetButton variant="primary" onClick={onConfirm} disabled={pending}>
                        {t('mods.approval.enable')}
                    </SheetButton>
                </>
            )}
        >
            {mod && (
                <div className="space-y-2.5">
                    <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
                        <TriangleAlert size={14} className="mt-px shrink-0" />
                        <span>{mod.trustStale ? t('mods.approval.staleRisk') : t('mods.approval.risk')}</span>
                    </div>

                    <Row label={t('mods.approval.permissions')}>
                        {permissions.length > 0 ? permissions.join(', ') : t('mods.approval.noPermissions')}
                    </Row>

                    {processes.length > 0 && (
                        <Row label={t('mods.approval.processes')}>
                            <ul className="space-y-1">
                                {processes.map((capability) => (
                                    <li key={capability}>
                                        {t(PROCESS_CAPABILITY_TEXT[capability] ?? 'mods.approval.processUnknown', { capability })}
                                    </li>
                                ))}
                            </ul>
                        </Row>
                    )}

                    <Row label={t('mods.approval.client')}>
                        {mod.hasMain ? t('mods.approval.hasNodeEntry') : t('mods.approval.noNodeEntry')}
                    </Row>

                    <Row label={t('mods.approval.fingerprint')}>
                        <span className="break-all font-mono text-[11px]">
                            {mod.digest ?? t('mods.approval.fingerprintUnknown')}
                        </span>
                    </Row>

                    <p className="text-xs text-[color:var(--text-secondary)]">{t('mods.approval.rebind')}</p>
                </div>
            )}
        </ThemedDialog>
    );
};
