import React, { useCallback, useMemo } from 'react';
import {
  AlertCircle,
  ArrowUpCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { APP_UPDATE_RELEASES_PAGE } from '../../../services/appUpdate';
import {
  installDownloadedUpdate,
  isUpdateVersionIgnored,
  refreshUpdateCheck,
  startUpdateDownload,
} from '../../../services/appUpdateCenter';
import { useUpdateCenter } from '../../../hooks/useUpdateCenter';
import { openExternalUrl } from '../../../utils/openExternalUrl';
import { Button } from '@/components/ui';

// src/components/modal/settings/AndroidUpdatePanel.tsx
// 安卓「版本更新」这一块：状态、下载进度、下载 / 安装都在一处，但自己不带框 ——
// 设置页里它长在「关于」那张卡里，再画一层边框就是卡里套卡。
//
// 之前这里是一排散着的小按钮 + 一条单独的状态文字，手机上既点不准也看不出主次。现在收敛成：
//   ┌ 状态（发现新版本 v0.7.19 · 68.4 MB）┐
//   │          【 大按钮 】                │    ← 检查 / 下载 / 进度 / 安装 都长在它身上
//   │  失败原因、授权提示等小字            │
//   │  打开发布页 · 更新内容               │
//   └───────────────────────────────────┘
// 一个按钮跟着状态变脸（同一个位置永远是「下一步该干什么」），而不是让用户在三四个
// 小按钮里挑。
//
// 这一整块被两个地方复用：设置 → 帮助页的版本区，以及启动时的更新弹窗。状态在
// services/appUpdateCenter.ts，两边共用，不会分叉。
//
// 下载走原生而不是 WebView 里 fetch：APK 动辄上百 MB，在 WebView 里攒 Blob 再转 base64
// 写过桥，中途要同时持有字节数组和膨胀后的字符串，低端机直接 OOM。
// 最后一步必须落到系统安装器 —— Android 不允许应用自己静默装更新。

/** 把字节数写成人话，安装包尺寸没必要精确到个位。 */
const formatSize = (bytes: number): string => (
    bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : ''
);

/**
 * 失败码 → 文案 key。
 *
 * 检查和下载分开列：检查失败是「够不着服务器」，下载失败是「拿到了清单但下不下来」，
 * 给用户的建议不一样。认不出来就退回通用的「检查失败」。
 */
const failureKeyOf = (message: string): string => {
    switch (message) {
        case 'manifest-missing': return 'options.androidUpdateFailureManifestMissing';
        case 'rate-limited': return 'options.androidUpdateFailureRateLimited';
        case 'timeout': return 'options.androidUpdateFailureTimeout';
        case 'empty-manifest': return 'options.androidUpdateFailureEmptyManifest';
        case 'no-apk': return 'options.androidUpdateFailureNoApk';
        case 'download-timeout': return 'options.androidUpdateFailureDownloadTimeout';
        case 'download-http-error': return 'options.androidUpdateFailureDownloadHttpError';
        case 'download-no-space': return 'options.androidUpdateFailureDownloadNoSpace';
        case 'download-file-error': return 'options.androidUpdateFailureDownloadFileError';
        case 'download-failed': return 'options.androidUpdateFailureDownloadFailed';
        default: return 'options.updateCheckFailed';
    }
};

type AndroidUpdatePanelProps = {
    /** 宽度类。默认撑满所在那一列。 */
    widthClassName?: string;
    /** 右上角的额外操作（弹窗用它放「忽略此版本」）。 */
    headerAction?: React.ReactNode;
};

const AndroidUpdatePanel: React.FC<AndroidUpdatePanelProps> = ({
    widthClassName = 'w-full',
    headerAction,
}) => {
    const { t } = useTranslation();
    const { result, isChecking, phase, installNotice } = useUpdateCenter();

    const release = result && result.status !== 'failed' ? result.release : null;
    const isAvailable = result?.status === 'update-available';
    const apk = result?.status === 'update-available' ? result.release.apk : null;
    // 这一份是为了在 JSX 里直接取字节数：`isDownloading` 是布尔，TS 靠它收不窄 `phase`。
    const downloadingPhase = phase.kind === 'downloading' ? phase : null;
    const isDownloading = downloadingPhase !== null;
    const isIgnored = isUpdateVersionIgnored(release?.version) && isAvailable;
    // 总量未知（服务端没给 Content-Length）时 percent 是 -1，这时候只报已下载量。
    const percent = downloadingPhase ? Math.max(0, downloadingPhase.percent) : 0;
    const hasPercent = Boolean(downloadingPhase) && (downloadingPhase?.percent ?? -1) >= 0;

    /** 大按钮在这一刻该干什么。只有五种，互斥。 */
    const action = useMemo(() => {
        if (isChecking) return 'checking';
        if (isDownloading) return 'downloading';
        if (phase.kind === 'downloaded') return 'install';
        if (isAvailable) return phase.kind === 'failed' ? 'retry-download' : 'download';
        return 'check';
    }, [isAvailable, isChecking, isDownloading, phase.kind]);

    const statusText = (() => {
        if (isChecking) return t('options.updateChecking');
        if (isDownloading) return t('options.androidUpdateDownloading');
        if (phase.kind === 'downloaded') return t('options.androidUpdateReady');
        if (phase.kind === 'failed' && isAvailable) return t('options.androidUpdateDownloadFailedShort');
        if (result?.status === 'update-available') return t('options.newVersionFound', { version: result.release.version });
        if (result?.status === 'up-to-date') return t('options.androidUpdateLatest', { version: result.currentVersion });
        if (result?.status === 'failed') return t(failureKeyOf(result.message));
        return t('options.androidUpdatePanelTitle');
    })();

    const subtitle = (() => {
        if (isChecking) return t('options.androidUpdateSubtitleChecking');
        if (isAvailable && release) {
            const size = release.apk && release.apk.sizeBytes > 0 ? formatSize(release.apk.sizeBytes) : '';
            return size
                ? t('options.androidUpdateSubtitleAvailable', { version: release.version, size })
                : t('options.androidUpdateSubtitleAvailableNoSize', { version: release.version });
        }
        if (phase.kind === 'downloaded' && release) {
            return t('options.androidUpdateSubtitleDownloaded', { version: release.version });
        }
        // 已是最新时状态文字里已经带了版本号，下面再写一遍没有新信息。
        if (result?.status === 'up-to-date') return null;
        return release
            ? t('options.androidUpdateSubtitleIdle', { version: result?.currentVersion ?? release.version })
            : null;
    })();

    const handlePrimary = useCallback(() => {
        if (action === 'install') {
            void installDownloadedUpdate();
            return;
        }
        if (action === 'download' || action === 'retry-download') {
            void startUpdateDownload();
            return;
        }
        void refreshUpdateCheck().catch(() => {
            // 只有主动取消会走到这里（其余失败已在服务里翻成 result），什么都不用做。
        });
    }, [action]);

    const handleOpenPage = useCallback(() => {
        void openExternalUrl(release?.pageUrl ?? APP_UPDATE_RELEASES_PAGE).catch(() => {
            // 打不开外链不算功能失败：地址就在上面，用户自己复制也行。
        });
    }, [release?.pageUrl]);

    const isHighlight = action === 'install' || (isAvailable && phase.kind !== 'failed');

    // 这一块画在设置 → 帮助页「关于」那张 kit 卡片里（以及启动时的更新弹窗），
    // 所以自己不再画一张卡：没有边框、没有圆角、也不限宽度 —— 之前它是
    // `w-full max-w-sm` 的一张带边框的卡，嵌在卡片里右边一大条空白。
    // 底色也一并去掉了：整块 bg-white/[0.06] 会让「检查更新」这一行比上面「版本」
    // 那行深一档，看着像另一个东西；现在跟同卡里的其它行一个底色。
    // 左右内边距照 kit 那一行的 pl-4 / pr-4，字和上面的「版本」那行对齐。
    return (
        <div
            data-folia-update-panel="true"
            data-folia-update-action={action}
            className={`${widthClassName} px-4 py-3 font-sans`}
        >
            <div className="mb-2.5 flex items-start gap-2">
                <span className={`mt-[1px] shrink-0 ${phase.kind === 'failed' || result?.status === 'failed' ? 'text-amber-500' : isHighlight ? 'text-amber-500' : 'opacity-50'}`}>
                    {isChecking || isDownloading
                        ? <Loader2 size={14} className="animate-spin" />
                        : phase.kind === 'downloaded'
                            ? <CheckCircle2 size={14} />
                            : result?.status === 'failed' || phase.kind === 'failed'
                                ? <AlertCircle size={14} />
                                : <ArrowUpCircle size={14} />}
                </span>
                <div className="min-w-0 flex-1">
                    <div
                        data-folia-update-status={result?.status ?? 'unknown'}
                        className={`text-[13px] font-semibold leading-snug ${isHighlight ? 'text-amber-500' : 'opacity-70'}`}
                        style={isHighlight ? undefined : { color: 'var(--text-primary)' }}
                    >
                        {statusText}
                    </div>
                    {subtitle && (
                        <div
                            className="mt-0.5 text-[11px] leading-snug opacity-55"
                            style={{ color: 'var(--text-secondary)' }}
                        >
                            {subtitle}
                        </div>
                    )}
                </div>
                {headerAction && <div className="shrink-0">{headerAction}</div>}
            </div>

            {/* 一个框里那颗唯一的按钮：检查 → 下载 → 进度 → 安装，全部长在同一个位置。 */}
            <Button
                onClick={handlePrimary}
                disabled={action === 'checking' || action === 'downloading'}
                data-folia-update-primary={action}
                className={`relative w-full overflow-hidden rounded-xl px-3 py-2.5 text-[13px] font-bold transition-opacity ${
                    action === 'install'
                        ? 'bg-amber-500 text-black hover:opacity-90'
                        : 'border border-white/10 bg-white/[0.08] hover:bg-white/[0.14]'
                } ${action === 'checking' || action === 'downloading' ? 'cursor-default opacity-80' : ''}`}
                style={action === 'install' ? undefined : { color: 'var(--text-primary)' }}
            >
                {isDownloading && (
                    <span
                        aria-hidden="true"
                        className={`absolute inset-y-0 left-0 bg-white/20 transition-[width] duration-150 ${hasPercent ? '' : 'w-full animate-pulse opacity-40'}`}
                        style={{ width: hasPercent ? `${percent}%` : undefined }}
                    />
                )}
                <span className="relative flex items-center justify-center gap-1.5">
                    {action === 'checking' && <Loader2 size={14} className="animate-spin" />}
                    {action === 'download' && <Download size={14} />}
                    {action === 'retry-download' && <RefreshCw size={14} />}
                    {action === 'install' && <CheckCircle2 size={14} />}
                    {action === 'check' && <RefreshCw size={14} />}
                    {action === 'checking' && t('options.updateChecking')}
                    {action === 'downloading' && downloadingPhase && (
                        hasPercent
                            ? `${t('options.androidUpdateDownloading')} ${percent}% · ${formatSize(downloadingPhase.receivedBytes)}${downloadingPhase.totalBytes > 0 ? ` / ${formatSize(downloadingPhase.totalBytes)}` : ''}`
                            : `${t('options.androidUpdateDownloading')} ${formatSize(downloadingPhase.receivedBytes)}`
                    )}
                    {action === 'download' && (
                        apk && apk.sizeBytes > 0
                            ? `${t('options.androidUpdateDownload')} · ${formatSize(apk.sizeBytes)}`
                            : t('options.androidUpdateDownload')
                    )}
                    {action === 'retry-download' && t('options.androidUpdateDownloadAgain')}
                    {action === 'install' && t('options.androidUpdateInstall')}
                    {action === 'check' && (result ? t('options.androidUpdateRecheck') : t('options.androidUpdateCheck'))}
                </span>
            </Button>

            {phase.kind === 'failed' && (
                <p
                    className="mt-2 inline-flex w-full items-start gap-1 text-[11px] leading-snug text-amber-500/90"
                >
                    <AlertCircle size={11} className="mt-[2px] shrink-0" />
                    <span>{t(failureKeyOf(phase.message))}</span>
                </p>
            )}

            {result?.status === 'failed' && (
                <p
                    className="mt-2 inline-flex w-full items-start gap-1 text-[11px] leading-snug opacity-60"
                    style={{ color: 'var(--text-secondary)' }}
                >
                    <AlertCircle size={11} className="mt-[2px] shrink-0" />
                    <span>{t('options.androidUpdateFailedNotice')}</span>
                </p>
            )}

            {installNotice === 'permission-required' && (
                <p
                    className="mt-2 inline-flex w-full items-start gap-1 text-[11px] leading-snug text-amber-500/90"
                >
                    <AlertCircle size={11} className="mt-[2px] shrink-0" />
                    <span>{t('options.androidUpdateInstallPermissionHint')}</span>
                </p>
            )}

            {isIgnored && (
                <p
                    className="mt-2 w-full text-[11px] leading-snug opacity-55"
                    style={{ color: 'var(--text-secondary)' }}
                >
                    {t('options.androidUpdateIgnoredHint')}
                </p>
            )}

            {isAvailable && (
                <p
                    className="mt-2 w-full text-[11px] leading-snug opacity-55"
                    style={{ color: 'var(--text-secondary)' }}
                >
                    {t('options.androidUpdateInstallHint')}
                </p>
            )}

            <div className="mt-2.5 flex flex-wrap items-center justify-center gap-1">
                <Button
                    onClick={handleOpenPage}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] opacity-65 transition-colors hover:bg-white/10 hover:opacity-100"
                    style={{ color: 'var(--text-secondary)' }}
                >
                    <ExternalLink size={11} />
                    {t('options.androidUpdateOpenPage')}
                </Button>
            </div>

            {release?.notes && (
                <details className="mt-1 w-full text-left">
                    <summary
                        className="cursor-pointer text-center text-[11px] opacity-60 hover:opacity-100"
                        style={{ color: 'var(--text-secondary)' }}
                    >
                        {t('options.androidUpdateNotes')}
                    </summary>
                    <pre
                        className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-white/10 bg-white/[0.035] p-2 font-sans text-[11px] opacity-70"
                        style={{ color: 'var(--text-secondary)' }}
                    >
                        {release.notes}
                    </pre>
                </details>
            )}
        </div>
    );
};

export default AndroidUpdatePanel;
