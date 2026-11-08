import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextField as UiTextField } from '@/components/ui';
import { Button, Row, Segmented, Status, TextField, Toggle } from '../modal/settings/kit';
import { lxSourceStore } from '../../services/onlineMusic/lxmusic/lxSourceStore';
import { importLxSourceFromFile, importLxSourceFromUrl, type ImportResult } from '../../services/onlineMusic/lxmusic/lxImportService';
import type { LxSource } from '../../services/onlineMusic/lxmusic/lxTypes';
import { LX_PUBLIC_PLATFORMS } from '../../services/onlineMusic/lxmusic/lxPublicApi';
import {
    formatPlaybackDiagnostics,
    clearPlaybackDiagnostics,
    readPlaybackDiagnostics,
    type LxPlaybackDiag,
} from '../../services/onlineMusic/lxmusic/lxDiagnostics';
import {
    getLxPreferences,
    setLxPreferences,
    subscribeLxPreferences,
    type LxPreferences,
} from '../../services/onlineMusic/lxmusic/lxPreferences';

// src/components/lxmusic/LxSourcePanel.tsx
// 洛雪「音源」这一组行。以前这里是一整块自绘面板：用自己的 .lx-* 类、自己的一套输入框和按钮，
// 而那套 CSS 只随洛雪工作台加载 —— 放到设置页里就是「有字没样式」，行列与旁边的设置项也对不上。
// 现在每一块都画成 kit 的行：左边名字与说明，右边控件，与连接与集成页其它行完全同一套。
//
// 音源列表是唯一还用 below 的一行：它是有状态的一串条目，做成「右对齐的一颗控件」不像样。

type ImportTab = 'url' | 'file';

type LxSourcePanelProps = {
    /** 音源变动后回调（工作台用它刷新「能不能放」的提示）。 */
    onChanged?: () => void;
};

/** 音源脚本里 `sources` 那一级的平台短名。名字由脚本自己给，这里只是兜底。 */
const PLATFORM_KEYS: Record<string, string> = {
    wy: '网易云', kg: '酷狗', tx: 'QQ', kw: '酷我', mg: '咪咕', local: '本地',
};

export const LxSourcePanel: React.FC<LxSourcePanelProps> = ({ onChanged }) => {
    const { t } = useTranslation();
    const [tab, setTab] = useState<ImportTab>('url');
    const [url, setUrl] = useState('');
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
    const [sources, setSources] = useState<LxSource[]>(() => lxSourceStore.getSources());
    const [diagText, setDiagText] = useState<string | null>(null);
    const [prefs, setPrefs] = useState<LxPreferences>(getLxPreferences);
    const [lastAttempt, setLastAttempt] = useState<LxPlaybackDiag | null>(() => {
        const list = readPlaybackDiagnostics();
        return list.length > 0 ? list[list.length - 1] : null;
    });
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const unsubscribe = lxSourceStore.subscribe(() => {
            setSources([...lxSourceStore.getSources()]);
            onChanged?.();
        });
        setSources([...lxSourceStore.getSources()]);
        void lxSourceStore.init();
        return unsubscribe;
    }, [onChanged]);

    useEffect(() => subscribeLxPreferences(() => setPrefs(getLxPreferences())), []);

    const refreshLastAttempt = () => {
        const list = readPlaybackDiagnostics();
        setLastAttempt(list.length > 0 ? list[list.length - 1] : null);
    };

    const report = (result: ImportResult) => {
        if (result.ok) {
            setFeedback({
                kind: 'ok',
                text: result.source.error
                    ? t('lxmusic.importedWithError', { name: result.source.meta.name })
                    : t('lxmusic.importedOk', { name: result.source.meta.name }),
            });
        } else {
            setFeedback({ kind: 'err', text: result.error });
        }
    };

    const doImportUrl = async () => {
        if (!url.trim() || busy) return;
        setBusy(true);
        setFeedback(null);
        const result = await importLxSourceFromUrl(url.trim());
        report(result);
        setBusy(false);
    };

    const doImportFiles = async (files: FileList | File[]) => {
        setBusy(true);
        setFeedback(null);
        for (const file of Array.from(files)) {
            const result = await importLxSourceFromFile(file);
            report(result);
        }
        setBusy(false);
    };

    const copyDiagnostics = async () => {
        refreshLastAttempt();
        const text = formatPlaybackDiagnostics();
        try {
            await navigator.clipboard.writeText(text);
            setDiagText(null);
            setFeedback({ kind: 'ok', text: t('lxmusic.copiedDiagnostics') });
        } catch {
            // 部分 WebView 不给写剪贴板：把文本摊开在页面上，长按也能复制。
            setDiagText(text);
        }
    };

    return (
        <>
            {/* 导入 */}
            <Row
                label={t('lxmusic.importTitle')}
                note={t('lxmusic.importNotice')}
            >
                <Segmented
                    value={tab}
                    options={[
                        { value: 'url' as const, label: t('lxmusic.importFromUrl') },
                        { value: 'file' as const, label: t('lxmusic.importFromFile') },
                    ]}
                    onChange={setTab}
                />
            </Row>

            {tab === 'url' ? (
                <Row sub>
                    <span className="flex w-full flex-wrap items-center justify-end gap-2">
                        <span className="min-w-[180px] flex-[1_1_180px]">
                            <TextField
                                type="url"
                                value={url}
                                onChange={setUrl}
                                onCommit={() => void doImportUrl()}
                                placeholder={t('lxmusic.urlPlaceholder')}
                                disabled={busy}
                            />
                        </span>
                        <Button variant="primary" onClick={() => void doImportUrl()} disabled={busy || !url.trim()}>
                            {busy ? t('lxmusic.importing') : t('lxmusic.import')}
                        </Button>
                    </span>
                </Row>
            ) : (
                <Row sub>
                    <span className="flex w-full flex-wrap items-center justify-end gap-2">
                        <Button onClick={() => fileInputRef.current?.click()} disabled={busy}>
                            {t('lxmusic.chooseFile')}
                        </Button>
                        <span className="w-full text-right text-xs text-[color:var(--st-t3)]">{t('lxmusic.multipleFilesHint')}</span>
                        <UiTextField
                            ref={fileInputRef}
                            type="file"
                            accept=".js,.json,application/javascript,application/json"
                            multiple
                            className="hidden"
                            onChange={(event) => {
                                if (event.target.files?.length) void doImportFiles(event.target.files);
                                event.target.value = '';
                            }}
                        />
                    </span>
                </Row>
            )}

            {feedback && (
                <Row label={<Status tone={feedback.kind === 'ok' ? 'ok' : 'error'}>{feedback.text}</Status>} />
            )}

            {/* 播放路由 */}
            <Row
                label={t('lxmusic.routeAllSongs')}
                note={t('lxmusic.routeAllSongsDesc')}
            >
                <Toggle
                    checked={prefs.routeAllSongs}
                    onChange={(next: boolean) => setLxPreferences({ routeAllSongs: next })}
                    label={t('lxmusic.routeAllSongs')}
                />
            </Row>
            <Row
                label={t('lxmusic.allowPublicFallback')}
                note={t('lxmusic.allowPublicFallbackDesc')}
            >
                <Toggle
                    checked={prefs.allowPublicFallback}
                    onChange={(next: boolean) => setLxPreferences({ allowPublicFallback: next })}
                    label={t('lxmusic.allowPublicFallback')}
                />
            </Row>
            {lastAttempt && (
                <Row sub>
                    <span className="w-full text-right text-xs text-[color:var(--st-t3)]">
                        {t('lxmusic.lastAttempt')}：{lastAttempt.ok ? t('lxmusic.succeeded') : t('lxmusic.failed')}
                        {' · '}{lastAttempt.via ?? t('lxmusic.unknownSource')}
                        {lastAttempt.host ? ` · ${lastAttempt.host}` : ''}
                    </span>
                </Row>
            )}

            {/* 播放覆盖：哪些平台现在有音源能取到地址 */}
            <Row label={t('lxmusic.coverage')}>
                <span className="flex flex-wrap items-center justify-end gap-2 text-xs">
                    {LX_PUBLIC_PLATFORMS.map((platform) => {
                        const ok = lxSourceStore.canResolve(platform.key, 'musicUrl') || platform.key === 'kw';
                        return (
                            <span
                                key={platform.key}
                                className="rounded bg-[var(--st-fill)] px-1.5 py-0.5 text-[color:var(--st-t2)]"
                                style={ok ? { color: platform.color } : undefined}
                            >
                                {platform.label}{ok ? ' ✓' : ' —'}
                            </span>
                        );
                    })}
                </span>
            </Row>

            {/* 已导入音源 */}
            <Row
                label={`${t('lxmusic.importedSources')}（${sources.length}）`}
                note={t('lxmusic.importedSourcesDesc')}
                below={(
                    sources.length === 0 ? (
                        <p className="text-xs leading-5 text-[color:var(--st-t3)]">{t('lxmusic.noSources')}</p>
                    ) : (
                        <ul className="flex flex-col gap-2">
                            {sources.map((source) => (
                                <li key={source.id} className="rounded-lg bg-[var(--st-fill)] px-3 py-2">
                                    <div className="flex items-start gap-3">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2">
                                                <span className="truncate text-[13px] font-semibold text-[color:var(--st-t1)]">{source.meta.name}</span>
                                                {source.meta.version && (
                                                    <span className="rounded bg-[var(--st-raise)] px-1.5 text-[10px] text-[color:var(--st-t2)]">
                                                        v{source.meta.version}
                                                    </span>
                                                )}
                                            </div>
                                            {source.meta.author && (
                                                <p className="mt-0.5 truncate text-[11px] text-[color:var(--st-t3)]">
                                                    {t('lxmusic.author', { name: source.meta.author })}
                                                </p>
                                            )}
                                            <div className="mt-1.5 flex flex-wrap gap-1">
                                                {Object.entries(source.sources).map(([key, info]) => (
                                                    <span key={key} className="rounded bg-[var(--st-raise)] px-1.5 py-0.5 text-[10px] text-[color:var(--st-t2)]">
                                                        {PLATFORM_KEYS[key] ?? key}
                                                        {info?.actions?.includes('musicUrl') ? ' · 播放' : ''}
                                                        {info?.actions?.includes('lyric') ? ' · 歌词' : ''}
                                                    </span>
                                                ))}
                                                {source.error && (
                                                    <span className="rounded bg-[#e11d48]/15 px-1.5 py-0.5 text-[10px] text-[#e11d48]">{t('lxmusic.loadFailed')}</span>
                                                )}
                                            </div>
                                            {source.error && (
                                                <p className="mt-1 break-all text-[10px] leading-4 text-[#e11d48]">{source.error}</p>
                                            )}
                                        </div>
                                        <div className="flex shrink-0 flex-col items-end gap-2">
                                            <Toggle
                                                checked={source.enabled}
                                                onChange={() => { void lxSourceStore.setEnabled(source.id, !source.enabled); }}
                                                label={t('lxmusic.enabled')}
                                            />
                                            <Button
                                                variant="quiet"
                                                onClick={() => { void lxSourceStore.removeSource(source.id); }}
                                            >
                                                {t('lxmusic.delete')}
                                            </Button>
                                        </div>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )
                )}
            />

            {/* 诊断 */}
            <Row
                label={t('lxmusic.diagnosticsTitle')}
                note={t('lxmusic.diagnosticsHint')}
            >
                <span className="flex flex-wrap items-center justify-end gap-2">
                    <Button onClick={() => { void copyDiagnostics(); }}>{t('lxmusic.copyDiagnostics')}</Button>
                    <Button
                        onClick={() => {
                            clearPlaybackDiagnostics();
                            setDiagText(null);
                            setLastAttempt(null);
                            setFeedback({ kind: 'ok', text: t('lxmusic.clearedDiagnostics') });
                        }}
                    >
                        {t('lxmusic.clearDiagnostics')}
                    </Button>
                </span>
            </Row>
            {diagText && (
                <Row below={(
                    // 只读的诊断原文：不是输入框，所以是一段可长按选中的文字，不是手写控件。
                    <pre
                        aria-label={t('lxmusic.diagnosticsTitle')}
                        className="st-scroll m-0 max-h-52 w-full select-text overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--st-fill)] px-2.5 py-2 font-mono text-[11px] leading-4 text-[color:var(--st-t1)]"
                    >
                        {diagText}
                    </pre>
                )} />
            )}
        </>
    );
};

export default LxSourcePanel;
