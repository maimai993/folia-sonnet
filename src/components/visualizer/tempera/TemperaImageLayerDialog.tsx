import React, { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImagePlus, Trash2, Upload } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { TemperaLayerImage, TemperaLayerImageAlign } from '../../../types';
import ThemedDialog from '../../shared/ThemedDialog';
import { TemperaRangeControl } from './TemperaSettingsControls';

// src/components/visualizer/tempera/TemperaImageLayerDialog.tsx
// The one place canvas images are managed: upload, preview, per-image tendency and size, and
// the two pool-wide settings. Split out of the settings panel because a list of filenames with
// two sliders each is unreadable inline - the picture is the thing being chosen.
//
// Every control here edits the caller's draft, never the live tuning; the caller commits on
// close. That makes this card the feedback surface for an edit, so it is drawn as a miniature
// of the frame rather than as a bare thumbnail: `scale` is the sprite's height as a fraction of
// the viewport and `align` picks a horizontal band, both of which a 16:9 box can show honestly.

/** Transparent PNGs are the expected input, so the preview needs something to read against. */
const CHECKER_BACKGROUND = {
    backgroundImage:
        'linear-gradient(45deg, rgba(255,255,255,0.07) 25%, transparent 25%),'
        + 'linear-gradient(-45deg, rgba(255,255,255,0.07) 25%, transparent 25%),'
        + 'linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.07) 75%),'
        + 'linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.07) 75%)',
    backgroundSize: '14px 14px',
    backgroundPosition: '0 0, 0 7px, 7px -7px, -7px 0',
};

/** Centre of each tendency's band in ALIGN_BANDS; the preview parks the picture there. */
const ALIGN_PREVIEW_X: Record<TemperaLayerImageAlign, number> = {
    left: 0.23,
    center: 0.5,
    right: 0.77,
    free: 0.5,
};

/** Middle of the vertical band pictures are placed in, so the preview stands them where shots do. */
const PREVIEW_Y = 0.62;

interface TemperaImageLayerDialogProps {
    isOpen: boolean;
    onClose: () => void;
    isDaylight: boolean;
    t: TFunction;
    images: TemperaLayerImage[];
    thumbnails: Map<string, string>;
    depth: 'back' | 'front';
    frequency: number;
    maxImages: number;
    rangeInputClass: string;
    onAddFiles: (files: File[]) => void;
    onPatch: (id: string, next: Partial<TemperaLayerImage>) => void;
    onRemove: (id: string) => void;
    onDepthChange: (depth: 'back' | 'front') => void;
    onFrequencyChange: (frequency: number) => void;
}

interface ChipProps {
    label: string;
    active: boolean;
    onClick: () => void;
}

const Chip: React.FC<ChipProps> = ({ label, active, onClick }) => (
    <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className="rounded-full border px-3 py-1.5 text-xs transition-colors"
        style={{
            borderColor: active ? 'var(--text-primary)' : 'rgba(255,255,255,0.15)',
            color: 'var(--text-primary)',
            opacity: active ? 1 : 0.55,
        }}
    >
        {label}
    </button>
);

const TemperaImageLayerDialog: React.FC<TemperaImageLayerDialogProps> = ({
    isOpen,
    onClose,
    isDaylight,
    t,
    images,
    thumbnails,
    depth,
    frequency,
    maxImages,
    rangeInputClass,
    onAddFiles,
    onPatch,
    onRemove,
    onDepthChange,
    onFrequencyChange,
}) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const [dragging, setDragging] = useState(false);
    const full = images.length >= maxImages;

    const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDragging(false);
        onAddFiles(Array.from(event.dataTransfer.files ?? []));
    }, [onAddFiles]);

    const alignOptions: Array<[TemperaLayerImageAlign, string]> = [
        ['free', t('options.temperaLayerAlignFree') || '不限'],
        ['left', t('options.temperaLayerAlignLeft') || '偏左'],
        ['center', t('options.temperaLayerAlignCenter') || '居中'],
        ['right', t('options.temperaLayerAlignRight') || '偏右'],
    ];

    // Portalled to the document body like the app's other dialogs: both hosts of this panel -
    // VisPlayground and the settings modal - animate a transformed ancestor, and a transformed
    // ancestor is what a `position: fixed` overlay is measured against instead of the viewport.
    if (typeof document === 'undefined') return null;

    return createPortal((
        <ThemedDialog
            isOpen={isOpen}
            onClose={onClose}
            isDaylight={isDaylight}
            title={t('options.temperaImageSection') || '画布图片'}
            description={`${t('options.temperaLayerImageHint') || '每个分镜会从图片池里随机取一张，位置由对齐倾向决定。'}\n${t('options.temperaLayerImageSaveHint') || '改动会在关闭本窗口时写入。'}`}
            maxWidthClass="max-w-3xl"
            footer={(
                <button
                    type="button"
                    onClick={onClose}
                    className="rounded-full border border-white/15 px-5 py-2 text-sm transition-colors hover:bg-white/10"
                    style={{ color: 'var(--text-primary)' }}
                >
                    {t('options.temperaLayerImageSave') || '保存'}
                </button>
            )}
        >
            <div className="max-h-[62vh] space-y-5 overflow-y-auto pr-1">
                <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
                    <div className="space-y-2">
                        <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
                            {t('options.temperaLayerImageDepth') || '图层位置'}
                        </span>
                        <div className="flex flex-wrap gap-2">
                            {([
                                ['back', t('options.temperaLayerImageBack') || '歌词之后'],
                                ['front', t('options.temperaLayerImageFront') || '歌词之前'],
                            ] as const).map(([value, label]) => (
                                <Chip
                                    key={value}
                                    label={label}
                                    active={depth === value}
                                    onClick={() => onDepthChange(value)}
                                />
                            ))}
                        </div>
                    </div>
                    <TemperaRangeControl
                        label={t('options.temperaLayerImageFrequency') || '出现频率'}
                        value={frequency}
                        min={0}
                        max={1}
                        step={0.05}
                        rangeInputClass={rangeInputClass}
                        onChange={onFrequencyChange}
                    />
                </div>

                <input
                    ref={inputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                        onAddFiles(Array.from(event.target.files ?? []));
                        event.target.value = '';
                    }}
                />
                <div
                    onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={handleDrop}
                    className="flex flex-col items-center gap-2 rounded-2xl border border-dashed p-5 text-center transition-colors"
                    style={{
                        borderColor: dragging ? 'var(--text-primary)' : 'rgba(255,255,255,0.18)',
                        backgroundColor: dragging ? 'rgba(255,255,255,0.06)' : 'transparent',
                    }}
                >
                    <ImagePlus size={20} style={{ color: 'var(--text-secondary)' }} className="opacity-60" />
                    <button
                        type="button"
                        disabled={full}
                        onClick={() => inputRef.current?.click()}
                        className="inline-flex items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-xs transition-colors hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent"
                        style={{ color: 'var(--text-primary)' }}
                    >
                        <Upload size={14} />
                        {t('options.temperaAddLayerImage') || '添加图片'}
                    </button>
                    <span className="text-xs opacity-50" style={{ color: 'var(--text-secondary)' }}>
                        {t('options.temperaLayerImageDropHint') || '也可以把文件拖到这里'} · {images.length} / {maxImages}
                    </span>
                </div>

                {images.length === 0 ? (
                    <p className="py-6 text-center text-xs opacity-50" style={{ color: 'var(--text-secondary)' }}>
                        {t('options.temperaLayerImageEmpty') || '还没有图片。加入立绘、logo 或纹理后，每个分镜会随机取用。'}
                    </p>
                ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                        {images.map(image => (
                            <div key={image.id} className="space-y-3 rounded-2xl border border-white/10 p-3">
                                {/* A miniature of the frame, not a thumbnail: the picture sits at
                                    its band and at its real height fraction, so size, opacity
                                    and tendency all read here while the tuning stays untouched. */}
                                <div
                                    className="relative w-full overflow-hidden rounded-xl border border-white/10"
                                    style={{ ...CHECKER_BACKGROUND, aspectRatio: '16 / 9' }}
                                >
                                    {thumbnails.get(image.id) ? (
                                        <img
                                            src={thumbnails.get(image.id)}
                                            alt={image.name}
                                            className="absolute w-auto max-w-none object-contain"
                                            style={{
                                                height: `${Math.min(image.scale, 1) * 100}%`,
                                                left: `${ALIGN_PREVIEW_X[image.align] * 100}%`,
                                                top: `${PREVIEW_Y * 100}%`,
                                                transform: 'translate(-50%, -50%)',
                                                opacity: image.opacity,
                                            }}
                                        />
                                    ) : (
                                        <div className="absolute inset-0 flex items-center justify-center">
                                            <ImagePlus size={18} className="opacity-30" style={{ color: 'var(--text-secondary)' }} />
                                        </div>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => onRemove(image.id)}
                                        className="absolute right-2 top-2 rounded-full border border-white/15 bg-black/50 p-1.5 backdrop-blur-sm transition-colors hover:bg-black/70"
                                        aria-label={t('options.temperaRemoveLayerImage') || '移除图片'}
                                        style={{ color: 'var(--text-primary)' }}
                                    >
                                        <Trash2 size={13} />
                                    </button>
                                </div>
                                <div className="space-y-2">
                                    <span className="block break-all text-xs leading-snug opacity-70" style={{ color: 'var(--text-primary)' }}>
                                        {image.name}
                                    </span>
                                    <div className="flex flex-wrap gap-1.5">
                                        {alignOptions.map(([value, label]) => (
                                            <Chip
                                                key={value}
                                                label={label}
                                                active={image.align === value}
                                                onClick={() => onPatch(image.id, { align: value })}
                                            />
                                        ))}
                                    </div>
                                </div>
                                <TemperaRangeControl
                                    label={t('options.temperaLayerImageScale') || '大小'}
                                    value={image.scale}
                                    min={0.05}
                                    max={2}
                                    step={0.01}
                                    rangeInputClass={rangeInputClass}
                                    onChange={value => onPatch(image.id, { scale: value })}
                                />
                                <TemperaRangeControl
                                    label={t('options.temperaLayerImageOpacity') || '不透明度'}
                                    value={image.opacity}
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    rangeInputClass={rangeInputClass}
                                    onChange={value => onPatch(image.id, { opacity: value })}
                                />
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </ThemedDialog>
    ), document.body);
};

export default TemperaImageLayerDialog;
