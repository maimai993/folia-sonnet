import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Trash2, Upload } from 'lucide-react';
import { Button, TextField } from '@/components/ui';
import { Row, Toggle } from '@/components/modal/settings/kit';
import { useConfirmDialog } from '../../shared/useConfirmDialog';
import { useListeningArchiveSettingsStore } from '../../../stores/useListeningArchiveSettingsStore';
import {
    clearArchive,
    exportArchiveBackup,
    importArchiveBackup,
} from '../../../services/listeningArchive/repository';
import { saveFileWithSystemPicker } from '../../../platform/nativeFileSave';
import { triggerBlobDownload } from '../../../services/lyricExport/lyricExportFiles';
import { formatLocalDateTimeStamp } from '../../../utils/downloadFileName';

// src/components/app/listeningArchive/ArchiveSettingsTab.tsx
// 档案自己的设置页：采集开关、低性能模式、导出 / 导入备份、清空记录。
//
// 导出走仓库现成的那条路：安卓上调系统保存位置选择器（nativeFileSave），桌面 / 网页回落成
// Blob 下载（lyricExport 的 triggerBlobDownload 是全仓唯一那份 <a download> 实现）。
// 导入的结果直接写在页面上（新增几条、跳过几条）：重复导入同一份备份不会涨次数，
// 去重靠记录 id，由数据层判定。

type ArchiveSettingsTabProps = {
    /** 已经读到的记录条数。 */
    playCount: number;
    isDaylight: boolean;
    /** 导入 / 清空之后重新读一次档案。 */
    onReload: () => void;
};

type Feedback = { tone: 'ok' | 'warn'; text: string };

const ArchiveSettingsTab: React.FC<ArchiveSettingsTabProps> = ({ playCount, isDaylight, onReload }) => {
    const { t } = useTranslation();
    const enabled = useListeningArchiveSettingsStore(state => state.enabled);
    const lowPerformance = useListeningArchiveSettingsStore(state => state.lowPerformance);
    const setEnabled = useListeningArchiveSettingsStore(state => state.setEnabled);
    const setLowPerformance = useListeningArchiveSettingsStore(state => state.setLowPerformance);
    const { ask, dialog } = useConfirmDialog(isDaylight);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isBusy, setIsBusy] = useState(false);
    const [feedback, setFeedback] = useState<Feedback | null>(null);

    const handleExport = async () => {
        setIsBusy(true);
        setFeedback(null);
        try {
            const backup = await exportArchiveBackup();
            const content = JSON.stringify(backup, null, 2);
            const fileName = `folia-listening-archive-${formatLocalDateTimeStamp()}.json`;
            const outcome = await saveFileWithSystemPicker({
                fileName,
                mimeType: 'application/json',
                content,
            });
            // 用户自己关掉系统那张选择器不算失败：什么也不说，也不再偷偷下一份。
            if (outcome === 'cancelled') return;
            if (outcome === 'unavailable') {
                triggerBlobDownload(new Blob([content], { type: 'application/json' }), fileName);
            }
            setFeedback({ tone: 'ok', text: t('listeningArchive.settings.exported') });
        } catch (error) {
            console.warn('[ListeningArchive] 导出备份失败', error);
            setFeedback({ tone: 'warn', text: t('listeningArchive.settings.exportFailed') });
        } finally {
            setIsBusy(false);
        }
    };

    const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const picked = event.target.files?.[0];
        // 先清掉，否则再选同一个文件不会触发 change。
        event.target.value = '';
        if (!picked) return;
        setIsBusy(true);
        setFeedback(null);
        try {
            const parsed: unknown = JSON.parse(await picked.text());
            const result = await importArchiveBackup(parsed);
            setFeedback({
                tone: 'ok',
                text: t('listeningArchive.settings.imported', { added: result.added, skipped: result.skipped }),
            });
            onReload();
        } catch (error) {
            console.warn('[ListeningArchive] 导入备份失败', error);
            setFeedback({ tone: 'warn', text: t('listeningArchive.settings.importFailed') });
        } finally {
            setIsBusy(false);
        }
    };

    const handleClear = async () => {
        const confirmed = await ask({
            title: t('listeningArchive.settings.clearConfirmTitle'),
            description: t('listeningArchive.settings.clearConfirmDescription'),
            confirmText: t('listeningArchive.settings.clearConfirmAction'),
            cancelText: t('listeningArchive.settings.cancel'),
            confirmVariant: 'danger',
        });
        if (!confirmed) return;
        setIsBusy(true);
        setFeedback(null);
        try {
            await clearArchive();
            setFeedback({ tone: 'ok', text: t('listeningArchive.settings.cleared') });
            onReload();
        } catch (error) {
            console.warn('[ListeningArchive] 清空记录失败', error);
            setFeedback({ tone: 'warn', text: t('listeningArchive.settings.clearFailed') });
        } finally {
            setIsBusy(false);
        }
    };

    return (
        <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pr-1">
            <p className="text-[12px] text-[color:var(--st-t2)]">
                {t('listeningArchive.settings.recorded', { count: playCount })}
            </p>

            <Row label={t('listeningArchive.settings.enabled')} note={t('listeningArchive.settings.enabledNote')}>
                <Toggle
                    checked={enabled}
                    onChange={setEnabled}
                    label={t('listeningArchive.settings.enabled')}
                />
            </Row>

            <Row
                label={t('listeningArchive.settings.lowPerformance')}
                note={t('listeningArchive.settings.lowPerformanceNote')}
            >
                <Toggle
                    checked={lowPerformance}
                    onChange={setLowPerformance}
                    label={t('listeningArchive.settings.lowPerformance')}
                />
            </Row>

            <Row label={t('listeningArchive.settings.export')} note={t('listeningArchive.settings.exportNote')}>
                <Button variant="fill" size="sm" icon={Download} onClick={() => void handleExport()} disabled={isBusy}>
                    {t('listeningArchive.settings.exportAction')}
                </Button>
            </Row>

            <Row label={t('listeningArchive.settings.import')} note={t('listeningArchive.settings.importNote')}>
                <Button
                    variant="fill"
                    size="sm"
                    icon={Upload}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isBusy}
                >
                    {t('listeningArchive.settings.importAction')}
                </Button>
                {/* 系统自己的文件选择器，只是藏起来由上面的按钮按下。 */}
                <TextField
                    ref={fileInputRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={event => void handleImportFile(event)}
                />
            </Row>

            <Row label={t('listeningArchive.settings.clear')} note={t('listeningArchive.settings.clearNote')}>
                <Button
                    variant="fill"
                    size="sm"
                    icon={Trash2}
                    className="text-[color:var(--st-err)]"
                    onClick={() => void handleClear()}
                    disabled={isBusy || playCount === 0}
                >
                    {t('listeningArchive.settings.clearAction')}
                </Button>
            </Row>

            {feedback && (
                <p
                    className="text-[12px]"
                    style={{ color: feedback.tone === 'ok' ? 'var(--st-ok)' : 'var(--st-warn)' }}
                    role="status"
                >
                    {feedback.text}
                </p>
            )}

            {dialog}
        </div>
    );
};

export default ArchiveSettingsTab;
