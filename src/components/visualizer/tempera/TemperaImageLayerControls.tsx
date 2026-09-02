import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImagePlus, Settings2 } from 'lucide-react';
import type { TemperaLayerImage } from '../../../types';
import { DEFAULT_TEMPERA_LAYER_IMAGE, TEMPERA_MAX_LAYER_IMAGES } from '../../../types';
import {
    clearTemperaLayerImage,
    isSupportedTemperaLayerImageFile,
    prepareTemperaLayerImage,
    saveTemperaLayerImage,
    type StoredTemperaLayerImage,
} from '../../../services/temperaLayerImages';
import {
    createTemperaImageArchive,
    readTemperaImageArchiveFile,
    TemperaArchiveTooLargeError,
} from '../../../services/temperaImageArchive';
import { createSafeObjectUrl } from '../../../utils/blobGuards';
import { setStatusMessage } from '../../../stores/useStatusMessageStore';
import { formatLocalDateStamp, sanitizeDownloadFileName } from '../../../utils/downloadFileName';
import TemperaImageLayerDialog, { type TemperaPoolBusyAction } from './TemperaImageLayerDialog';
import { useTemperaLayerImageThumbnails } from './useTemperaLayerImageThumbnails';

// src/components/visualizer/tempera/TemperaImageLayerControls.tsx
// Summary row for the user's own canvas images (character art, logos, textures): a strip of
// previews and the way into the dialog where they are actually managed. The files go straight
// to IndexedDB; only ids and placement are written back to the tuning.
//
// Everything the dialog edits is held here as a draft and written to the tuning only when the
// dialog closes. Editing the live tuning instead meant a synchronous localStorage write and a
// global store update on every pointermove of a slider, which pinned a core; the card preview
// is what gives feedback during the edit, so nothing is lost by holding the commit back.
export interface TemperaImageLayerCommit {
    layerImages: TemperaLayerImage[];
    layerImageDepth: 'back' | 'front';
    layerImageFrequency: number;
}

interface TemperaImageLayerControlsProps {
    images: TemperaLayerImage[];
    depth: 'back' | 'front';
    frequency: number;
    rangeInputClass: string;
    isDaylight: boolean;
    /** One patch for the whole layer, so a session of edits costs a single store write. */
    onCommit: (next: TemperaImageLayerCommit) => void;
}

const sameImages = (a: TemperaLayerImage[], b: TemperaLayerImage[]) => (
    a.length === b.length && a.every((image, index) => (
        image.id === b[index].id
        && image.align === b[index].align
        && image.verticalAlign === b[index].verticalAlign
        && image.scale === b[index].scale
        && image.opacity === b[index].opacity
    ))
);

const TemperaImageLayerControls: React.FC<TemperaImageLayerControlsProps> = ({
    images,
    depth,
    frequency,
    rangeInputClass,
    isDaylight,
    onCommit,
}) => {
    const { t } = useTranslation();
    const [isDialogOpen, setDialogOpen] = useState(false);
    const [draft, setDraft] = useState<TemperaImageLayerCommit>({
        layerImages: images,
        layerImageDepth: depth,
        layerImageFrequency: frequency,
    });
    // Files deleted in the draft. The record is only dropped from IndexedDB on commit, so a
    // removal is undone by simply not committing it.
    const [removedIds, setRemovedIds] = useState<string[]>([]);
    const [busy, setBusy] = useState<TemperaPoolBusyAction>('idle');

    const previewImages = isDialogOpen ? draft.layerImages : images;
    const thumbnails = useTemperaLayerImageThumbnails(previewImages);

    const open = useCallback(() => {
        setDraft({ layerImages: images, layerImageDepth: depth, layerImageFrequency: frequency });
        setRemovedIds([]);
        setDialogOpen(true);
    }, [depth, frequency, images]);

    const commit = useCallback(() => {
        setDialogOpen(false);
        void Promise.all(removedIds.map(id => clearTemperaLayerImage(id).catch(() => undefined)));
        setRemovedIds([]);
        const changed = draft.layerImageDepth !== depth
            || draft.layerImageFrequency !== frequency
            || !sameImages(draft.layerImages, images);
        if (changed) onCommit(draft);
    }, [depth, draft, frequency, images, onCommit, removedIds]);

    // Closing the whole playground while the dialog is open must not strand an upload the user
    // already made in IndexedDB with nothing in the tuning pointing at it. Unmount only - keying
    // this on `isDialogOpen` would fire the same commit a second time on every ordinary close.
    const commitRef = useRef(commit);
    commitRef.current = commit;
    const isOpenRef = useRef(isDialogOpen);
    isOpenRef.current = isDialogOpen;
    useEffect(() => () => { if (isOpenRef.current) commitRef.current(); }, []);

    // Files the pool cannot take are invisible otherwise: the strip looks exactly as it did, so
    // "three of your five files went in" has to be said rather than inferred.
    const reportAddResult = useCallback((added: number, unsupported: number, overCap: number) => {
        const notes: string[] = [t('options.temperaLayerImagesAdded', {
            defaultValue: '已添加 {{count}} 张图片',
            count: added,
        })];
        if (unsupported > 0) {
            notes.push(t('options.temperaLayerImageUnsupported', {
                defaultValue: '{{count}} 个文件不是图片池支持的格式',
                count: unsupported,
            }));
        }
        if (overCap > 0) {
            notes.push(t('options.temperaPoolImportTruncated', {
                defaultValue: '超出上限，未导入 {{count}} 张',
                count: overCap,
            }));
        }
        setStatusMessage({ type: 'success', text: notes.join(' · ') });
    }, [t]);

    const handleFiles = useCallback(async (files: File[]) => {
        if (files.length === 0) return;
        const room = Math.max(0, TEMPERA_MAX_LAYER_IMAGES - draft.layerImages.length);
        const supported = files.filter(isSupportedTemperaLayerImageFile);
        const accepted = supported.slice(0, room);
        if (accepted.length === 0) {
            // Nothing went in at all, so there is no partial success to soften it with.
            setStatusMessage({
                type: 'error',
                text: t('options.temperaLayerImageUnsupported', {
                    defaultValue: '{{count}} 个文件不是图片池支持的格式',
                    count: files.length,
                }),
            });
            return;
        }
        const stored = await Promise.all(accepted.map(file => (
            prepareTemperaLayerImage(file).catch(error => {
                console.error('[Tempera] canvas image could not be stored:', error);
                return null;
            })
        )));
        const saved = stored.filter((image): image is StoredTemperaLayerImage => image !== null);
        await Promise.all(saved.map(image => (
            saveTemperaLayerImage(image).catch(error => {
                console.error('[Tempera] canvas image could not be saved:', error);
            })
        )));
        setDraft(current => ({
            ...current,
            layerImages: [
                ...current.layerImages,
                ...saved.map(image => ({
                    ...DEFAULT_TEMPERA_LAYER_IMAGE,
                    id: image.id,
                    name: image.name,
                })),
            ].slice(0, TEMPERA_MAX_LAYER_IMAGES),
        }));
        reportAddResult(
            saved.length,
            files.length - supported.length,
            // A file that failed to decode is not "over the cap" - it was accepted and then lost -
            // but the tail that never got processed is, and that is what this counts.
            accepted.length - saved.length,
        );
    }, [draft.layerImages.length, reportAddResult, t]);

    const patch = useCallback((id: string, next: Partial<TemperaLayerImage>) => {
        setDraft(current => ({
            ...current,
            layerImages: current.layerImages.map(image => (image.id === id ? { ...image, ...next } : image)),
        }));
    }, []);

    const remove = useCallback((id: string) => {
        setDraft(current => ({
            ...current,
            layerImages: current.layerImages.filter(image => image.id !== id),
        }));
        setRemovedIds(current => (current.includes(id) ? current : [...current, id]));
    }, []);

    const clearAll = useCallback(() => {
        setDraft(current => ({ ...current, layerImages: [] }));
        setRemovedIds(current => Array.from(new Set([
            ...current,
            ...draft.layerImages.map(image => image.id),
        ])));
    }, [draft.layerImages]);

    const exportPool = useCallback(async () => {
        setBusy('exporting');
        try {
            const archive = await createTemperaImageArchive({
                layerImages: draft.layerImages,
                layerImageDepth: draft.layerImageDepth,
                layerImageFrequency: draft.layerImageFrequency,
            });
            if (archive.exported === 0) throw new Error('Tempera pool export held no image');
            const url = createSafeObjectUrl(archive.blob);
            if (!url) throw new TypeError('Tempera pool export must produce a Blob');
            const link = document.createElement('a');
            link.href = url;
            link.download = `${sanitizeDownloadFileName(
                // Falls back to the shipped Chinese name: the key is new and a stale locale
                // file would otherwise name the file after the raw key.
                t('options.temperaExportBaseName') || '凝彩参数-画布图片备份',
            )}-${formatLocalDateStamp()}.zip`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 0);

            // A picture whose file has gone missing is left out of the zip, so the count the
            // pool shows and the one the backup holds can differ; say so instead of letting the
            // user discover it on a restore.
            const notes = [t('options.temperaPoolExported', {
                defaultValue: '已导出 {{count}} 张图片',
                count: archive.exported,
            })];
            if (archive.skipped > 0) {
                notes.push(t('options.temperaPoolExportSkipped', {
                    defaultValue: '{{count}} 张的原文件已丢失，未写入备份',
                    count: archive.skipped,
                }));
            }
            setStatusMessage({ type: 'success', text: notes.join(' · ') });
        } catch (error) {
            console.error('[Tempera] canvas image pool export failed:', error);
            setStatusMessage({ type: 'error', text: t('options.temperaPoolExportFailed') || '导出失败' });
        } finally {
            setBusy('idle');
        }
    }, [draft.layerImageDepth, draft.layerImageFrequency, draft.layerImages, t]);

    const importPool = useCallback(async (file: File, mode: 'replace' | 'append') => {
        // Replace wipes the current pool, and the only confirmation is here: the dialog has no
        // closing state to lose, but the IndexedDB records it drops are gone for good.
        if (mode === 'replace' && draft.layerImages.length > 0
            && !window.confirm(t('options.temperaImportConfirmReplace', {
                defaultValue: '替换导入会先清空当前 {{count}} 张图片，确定继续？',
                count: draft.layerImages.length,
            }))) {
            return;
        }

        setBusy('importing');
        try {
            const result = await readTemperaImageArchiveFile(file, {
                existing: mode === 'append' ? draft.layerImages : [],
            });
            // A backup that yields nothing is a failure the user has to hear about, but there are
            // two very different reasons for it: a pool that was already full when the zip landed
            // (every entry was counted as left out) and a zip that simply held no picture worth
            // restoring. Saying "no usable image" for the first would send the user looking for a
            // better backup when the fix is to make room.
            if (result.layerImages.length === 0) {
                console.warn('[Tempera] canvas image pool import added nothing', {
                    file: file.name,
                    skipped: result.skipped,
                    truncated: result.truncated,
                });
                setStatusMessage({
                    type: 'error',
                    text: result.truncated > 0
                        ? t('options.temperaPoolImportTruncated', {
                            defaultValue: '超出上限，未导入 {{count}} 张',
                            count: result.truncated,
                        })
                        : (t('options.temperaPoolImportEmpty') || '这份备份里没有可用的图片'),
                });
                return;
            }

            // Replacing the pool drops the old blobs here rather than through `removedIds`,
            // because those files have to go even if the user never commits the dialog.
            if (mode === 'replace') {
                await Promise.all(draft.layerImages.map(image => (
                    clearTemperaLayerImage(image.id).catch(() => undefined)
                )));
                setRemovedIds([]);
            }

            setDraft(current => ({
                layerImages: (mode === 'append' ? current.layerImages : []).concat(result.layerImages),
                layerImageDepth: result.layerImageDepth,
                layerImageFrequency: result.layerImageFrequency,
            }));

            const notes: string[] = [t('options.temperaPoolImported', {
                defaultValue: '已导入 {{count}} 张图片',
                count: result.layerImages.length,
            })];
            if (result.skipped > 0) {
                notes.push(t('options.temperaPoolImportSkipped', {
                    defaultValue: '跳过 {{count}} 个无效文件',
                    count: result.skipped,
                }));
            }
            if (result.truncated > 0) {
                notes.push(t('options.temperaPoolImportTruncated', {
                    defaultValue: '超出上限，未导入 {{count}} 张',
                    count: result.truncated,
                }));
            }
            setStatusMessage({ type: 'success', text: notes.join(' · ') });
        } catch (error) {
            console.error('[Tempera] canvas image pool import failed:', error);
            setStatusMessage({
                type: 'error',
                text: error instanceof TemperaArchiveTooLargeError
                    ? (t('options.temperaPoolImportTooLarge') || '已取消导入：备份解压后预计超过 512 MB，疑似损坏或压缩炸弹')
                    : (t('options.temperaPoolImportFailed') || '导入失败'),
            });
        } finally {
            setBusy('idle');
        }
    }, [draft.layerImages, t]);

    return (
        <div className="space-y-3">
            {/* The hint gets the panel's full width. Inside the button it had to share the row
                with the previews, which in a 360px settings column left it one word wide. */}
            <p className="text-xs leading-relaxed opacity-55" style={{ color: 'var(--text-secondary)' }}>
                {t('options.temperaLayerImageHint') || '每个分镜会从图片池里随机取一张，位置由对齐倾向决定。'}
            </p>
            <button
                type="button"
                onClick={open}
                className={`flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition-colors ${
                    isDaylight
                        ? 'border-black/10 bg-black/[0.04] hover:bg-black/[0.07]'
                        : 'border-white/10 bg-white/5 hover:bg-white/10'
                }`}
            >
                {images.length === 0 ? (
                    <span
                        className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-dashed ${isDaylight ? 'border-black/15' : 'border-white/15'}`}
                        style={{ color: 'var(--text-secondary)' }}
                    >
                        <ImagePlus size={16} className="opacity-60" />
                    </span>
                ) : (
                    <span className="flex shrink-0 -space-x-2">
                        {images.slice(0, 4).map(image => (
                            <span
                                key={image.id}
                                className={`h-12 w-12 overflow-hidden rounded-xl border ${isDaylight ? 'border-black/15 bg-black/10' : 'border-white/15 bg-black/30'}`}
                            >
                                {thumbnails.get(image.id) && (
                                    <img
                                        src={thumbnails.get(image.id)}
                                        alt={image.name}
                                        className="h-full w-full object-cover"
                                    />
                                )}
                            </span>
                        ))}
                        {images.length > 4 && (
                            <span
                                className={`flex h-12 w-12 items-center justify-center rounded-xl border text-xs ${isDaylight ? 'border-black/15 bg-black/[0.06]' : 'border-white/15 bg-black/50'}`}
                                style={{ color: 'var(--text-secondary)' }}
                            >
                                +{images.length - 4}
                            </span>
                        )}
                    </span>
                )}
                <span className="ml-auto shrink-0 text-sm" style={{ color: 'var(--text-primary)' }}>
                    {images.length === 0
                        ? (t('options.temperaAddLayerImage') || '添加图片')
                        : t('options.temperaImagePoolCount', {
                            defaultValue: '{{count}} / {{max}}',
                            count: images.length,
                            max: TEMPERA_MAX_LAYER_IMAGES,
                        })}
                </span>
                <Settings2 size={16} className="shrink-0 opacity-50" style={{ color: 'var(--text-secondary)' }} />
            </button>

            <TemperaImageLayerDialog
                isOpen={isDialogOpen}
                onClose={commit}
                isDaylight={isDaylight}
                t={t}
                images={draft.layerImages}
                thumbnails={thumbnails}
                depth={draft.layerImageDepth}
                frequency={draft.layerImageFrequency}
                maxImages={TEMPERA_MAX_LAYER_IMAGES}
                rangeInputClass={rangeInputClass}
                onAddFiles={files => void handleFiles(files)}
                onPatch={patch}
                onRemove={remove}
                onClearAll={clearAll}
                onDepthChange={layerImageDepth => setDraft(current => ({ ...current, layerImageDepth }))}
                onFrequencyChange={layerImageFrequency => setDraft(current => ({ ...current, layerImageFrequency }))}
                onImportPool={(file, mode) => void importPool(file, mode)}
                onExportPool={() => void exportPool()}
                busy={busy}
            />
        </div>
    );
};

export default TemperaImageLayerControls;
