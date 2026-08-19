import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Upload } from 'lucide-react';
import type { TemperaLayerImage } from '../../../types';
import { DEFAULT_TEMPERA_LAYER_IMAGE } from '../../../types';
import {
    buildStoredTemperaLayerImage,
    clearTemperaLayerImage,
    isSupportedTemperaLayerImageFile,
    saveTemperaLayerImage,
} from '../../../services/temperaLayerImages';
import { TemperaRangeControl } from './TemperaSettingsControls';

// src/components/visualizer/tempera/TemperaImageLayerControls.tsx
// Upload and placement UI for the user's own canvas images (character art, logos, textures).
// The files go straight to IndexedDB; only ids and placement are written back to the tuning.
const MAX_IMAGES = 8;

interface TemperaImageLayerControlsProps {
    images: TemperaLayerImage[];
    depth: 'back' | 'front';
    frequency: number;
    rangeInputClass: string;
    onChange: (images: TemperaLayerImage[]) => void;
    onDepthChange: (depth: 'back' | 'front') => void;
    onFrequencyChange: (frequency: number) => void;
}

const TemperaImageLayerControls: React.FC<TemperaImageLayerControlsProps> = ({
    images,
    depth,
    frequency,
    rangeInputClass,
    onChange,
    onDepthChange,
    onFrequencyChange,
}) => {
    const { t } = useTranslation();
    const inputRef = useRef<HTMLInputElement>(null);

    const handleFiles = useCallback(async (files: File[]) => {
        const room = MAX_IMAGES - images.length;
        const accepted = files.filter(isSupportedTemperaLayerImageFile).slice(0, Math.max(0, room));
        if (accepted.length === 0) return;
        const stored = accepted.map(buildStoredTemperaLayerImage);
        await Promise.all(stored.map(saveTemperaLayerImage));
        onChange([
            ...images,
            ...stored.map(image => ({
                ...DEFAULT_TEMPERA_LAYER_IMAGE,
                id: image.id,
                name: image.name,
            })),
        ]);
    }, [images, onChange]);

    const patch = useCallback((id: string, next: Partial<TemperaLayerImage>) => {
        onChange(images.map(image => (image.id === id ? { ...image, ...next } : image)));
    }, [images, onChange]);

    const remove = useCallback(async (id: string) => {
        // Drop the placement first: a failed delete must not strand a row the user cannot remove.
        onChange(images.filter(image => image.id !== id));
        await clearTemperaLayerImage(id).catch(() => undefined);
    }, [images, onChange]);

    return (
        <div className="space-y-3">
            <input
                ref={inputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                multiple
                className="hidden"
                onChange={(event) => {
                    void handleFiles(Array.from(event.target.files ?? []));
                    event.target.value = '';
                }}
            />
            <p className="text-xs leading-relaxed opacity-55" style={{ color: 'var(--text-secondary)' }}>
                {t('options.temperaLayerImageHint') || '每个分镜会从图片池里随机取一张，位置由对齐倾向决定。'}
            </p>
            <div className="flex flex-wrap gap-2">
                {([
                    ['back', t('options.temperaLayerImageBack') || '歌词之后'],
                    ['front', t('options.temperaLayerImageFront') || '歌词之前'],
                ] as const).map(([value, label]) => (
                    <button
                        key={value}
                        type="button"
                        onClick={() => onDepthChange(value)}
                        className="rounded-full border px-3 py-1.5 text-xs"
                        style={{
                            borderColor: depth === value ? 'var(--text-primary)' : 'rgba(255,255,255,0.15)',
                            color: 'var(--text-primary)',
                            opacity: depth === value ? 1 : 0.55,
                        }}
                    >
                        {label}
                    </button>
                ))}
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
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
                    {images.length} / {MAX_IMAGES}
                </span>
                <button
                    type="button"
                    disabled={images.length >= MAX_IMAGES}
                    onClick={() => inputRef.current?.click()}
                    className="inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-2 text-xs disabled:opacity-40"
                    style={{ color: 'var(--text-primary)' }}
                >
                    <Upload size={14} />
                    {t('options.temperaAddLayerImage') || '添加图片'}
                </button>
            </div>

            {images.map(image => (
                <div key={image.id} className="space-y-2 rounded-2xl border border-white/10 p-3">
                    <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs" style={{ color: 'var(--text-primary)' }}>
                            {image.name}
                        </span>
                        <button
                            type="button"
                            onClick={() => void remove(image.id)}
                            className="rounded-full border border-white/15 p-1.5"
                            aria-label={t('options.temperaRemoveLayerImage') || '移除图片'}
                            style={{ color: 'var(--text-secondary)' }}
                        >
                            <Trash2 size={13} />
                        </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {([
                            ['free', t('options.temperaLayerAlignFree') || '不限'],
                            ['left', t('options.temperaLayerAlignLeft') || '偏左'],
                            ['center', t('options.temperaLayerAlignCenter') || '居中'],
                            ['right', t('options.temperaLayerAlignRight') || '偏右'],
                        ] as const).map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                onClick={() => patch(image.id, { align: value })}
                                className="rounded-full border px-3 py-1.5 text-xs"
                                style={{
                                    borderColor: image.align === value ? 'var(--text-primary)' : 'rgba(255,255,255,0.15)',
                                    color: 'var(--text-primary)',
                                    opacity: image.align === value ? 1 : 0.55,
                                }}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    <TemperaRangeControl
                        label={t('options.temperaLayerImageScale') || '大小'}
                        value={image.scale}
                        min={0.05}
                        max={2}
                        step={0.01}
                        rangeInputClass={rangeInputClass}
                        onChange={value => patch(image.id, { scale: value })}
                    />
                    <TemperaRangeControl
                        label={t('options.temperaLayerImageOpacity') || '不透明度'}
                        value={image.opacity}
                        min={0}
                        max={1}
                        step={0.01}
                        rangeInputClass={rangeInputClass}
                        onChange={value => patch(image.id, { opacity: value })}
                    />
                </div>
            ))}
        </div>
    );
};

export default TemperaImageLayerControls;
