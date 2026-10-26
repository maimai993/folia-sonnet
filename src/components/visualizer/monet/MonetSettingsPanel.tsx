import React, { useRef, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { useVisualizerAssetStore } from '../../../stores/useVisualizerAssetStore';
import { DEFAULT_MONET_TUNING, type MonetPortraitSource, type MonetTuning } from '../../../types';
import { Button, Group, PictureGrid, Row, Segmented, type SettingsGroupDef } from '../../modal/settings/kit';
import { TextField } from '../../ui';
import { type VisualizerSettingsPanelProps } from '../definition';
import { SliderRow, times, ToggleRow } from '../panelRows';

// src/components/visualizer/monet/MonetSettingsPanel.tsx
// Monet-specific lyric, audio, and portrait controls, as three groups of the settings kit.
// Background controls live in the shared background panel.
const LYRICS_GROUP: SettingsGroupDef = { id: 'vis-monet-lyrics', titleKey: 'options.lyricsStyleSettings' };
const PORTRAIT_GROUP: SettingsGroupDef = { id: 'vis-monet-portrait', titleKey: 'options.cappellaAvatarSource' };

type MonetPortraitStyle = 'rectangular' | 'square';

const clampValue = (value: number, min: number, max: number, fallback: number) => (
    Number.isFinite(value)
        ? Math.min(max, Math.max(min, value))
        : fallback
);

/** The portrait's frame: tall, or square. */
const portraitStylePicture = (style: MonetPortraitStyle) => (
    <span className="absolute inset-0 grid place-items-center">
        <span className={`rounded-sm bg-[var(--st-t2)] ${style === 'square' ? 'aspect-square h-[56%]' : 'aspect-[3/4] h-[76%]'}`} />
    </span>
);

export const MonetSettingsPanel: React.FC<VisualizerSettingsPanelProps<MonetTuning>> = ({
    t,
    tuning: monetTuning = DEFAULT_MONET_TUNING,
    onTuningChange: onMonetTuningChange,
    settings: {
        handleUploadMonetPortraitImage: onUploadMonetPortraitImage,
        handleClearMonetPortraitImage: onClearMonetPortraitImage,
    },
    onSliderPointerDown,
    onSliderCommit,
}) => {
    // The listener's own portrait and whether it is still being read back: the style's own, so the panel takes them itself.
    const monetPortraitImage = useVisualizerAssetStore(state => state.monetPortraitImage);
    const isLoadingMonetPortraitImage = useVisualizerAssetStore(state => state.isLoadingMonetPortraitImage);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [feedback, setFeedback] = useState<string | null>(null);
    const resolvedTuning = {
        showDescription: monetTuning.showDescription ?? DEFAULT_MONET_TUNING.showDescription,
        fontScale: clampValue(monetTuning.fontScale ?? DEFAULT_MONET_TUNING.fontScale, 0.7, 1.5, DEFAULT_MONET_TUNING.fontScale),
        portraitSource: monetTuning.portraitSource ?? DEFAULT_MONET_TUNING.portraitSource,
        portraitStyle: monetTuning.portraitStyle ?? DEFAULT_MONET_TUNING.portraitStyle ?? 'rectangular',
        showPortraitDragHanger: monetTuning.showPortraitDragHanger ?? DEFAULT_MONET_TUNING.showPortraitDragHanger,
    };

    const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = '';
        setFeedback(null);
        if (!files.length || !onUploadMonetPortraitImage) {
            return;
        }

        const result = await onUploadMonetPortraitImage(files);
        if (result.ok) {
            onMonetTuningChange?.({ portraitSource: 'custom' });
            setFeedback(files[0].name);
        } else {
            setFeedback(result.error || t('options.monetUploadPortrait'));
        }
    };

    return (
        <>
            <Group def={LYRICS_GROUP}>
                <SliderRow
                    label={t('options.monetFontScale')}
                    value={resolvedTuning.fontScale}
                    min={0.7}
                    max={1.5}
                    step={0.05}
                    format={times}
                    onChange={(value) => onMonetTuningChange?.({ fontScale: value })}
                    onDragStart={onSliderPointerDown}
                    onDragEnd={onSliderCommit}
                />
                <ToggleRow
                    label={t('options.monetShowDescription')}
                    checked={resolvedTuning.showDescription}
                    onChange={(value) => onMonetTuningChange?.({ showDescription: value })}
                />
            </Group>

            <Group def={PORTRAIT_GROUP}>
                <Row label={t('options.monetPortraitSource')}>
                    <Segmented<MonetPortraitSource>
                        value={resolvedTuning.portraitSource}
                        options={[
                            { value: 'cover', label: t('options.monetPortraitSourceCover') },
                            {
                                value: 'custom',
                                label: t('options.monetPortraitSourceCustom'),
                                disabled: !monetPortraitImage && !isLoadingMonetPortraitImage,
                            },
                        ]}
                        onChange={(value) => onMonetTuningChange?.({ portraitSource: value })}
                    />
                </Row>
                <Row
                    label={t('options.monetUploadPortrait')}
                    hint={feedback || monetPortraitImage?.name || '-'}
                >
                    <Button
                        icon={ImagePlus}
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isLoadingMonetPortraitImage || !onUploadMonetPortraitImage}
                    >
                        {t('options.monetUploadPortrait')}
                    </Button>
                    <Button
                        icon={Trash2}
                        onClick={() => void onClearMonetPortraitImage?.()}
                        disabled={!monetPortraitImage || !onClearMonetPortraitImage}
                    >
                        {t('options.monetClearPortrait')}
                    </Button>
                    <TextField
                        ref={fileInputRef}
                        type="file"
                        accept=".png,.jpg,.jpeg,.gif,.webp,.svg,image/*"
                        className="hidden"
                        onChange={(event) => void handleFileChange(event)}
                    />
                </Row>
                <Row
                    label={t('options.monetPortraitStyle')}
                    below={(
                        <PictureGrid<MonetPortraitStyle>
                            className="-mx-4"
                            columns={4}
                            label={t('options.monetPortraitStyle')}
                            value={resolvedTuning.portraitStyle}
                            options={[
                                { value: 'rectangular', label: t('options.monetPortraitStyleRectangular') },
                                { value: 'square', label: t('options.monetPortraitStyleSquare') },
                            ]}
                            picture={portraitStylePicture}
                            onChange={(value) => onMonetTuningChange?.({ portraitStyle: value })}
                        />
                    )}
                />
                <ToggleRow
                    label={t('options.monetPortraitDragHanger')}
                    checked={resolvedTuning.showPortraitDragHanger ?? true}
                    onChange={(value) => onMonetTuningChange?.({ showPortraitDragHanger: value })}
                />
            </Group>

        </>
    );
};
