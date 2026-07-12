import React from 'react';
import { type VisualizerMode } from '../../types';
import { type VisualizerSharedProps } from './definition';
import { getVisualizerRegistryEntry } from './registry';
import { applyVisualizerTuning } from './tuningRegistry';

interface VisualizerRendererProps extends VisualizerSharedProps {
    mode: VisualizerMode;
}

const VisualizerRenderer: React.FC<VisualizerRendererProps> = ({ mode, ...props }) => {
    const resolvedProps = applyVisualizerTuning(mode, {
        ...props,
        resolvedVisualizerBackgroundMode: props.visualizerBackgroundMode ?? (mode === 'monet' ? 'monet' : 'common'),
    }, props.visualizerTunings);

    return getVisualizerRegistryEntry(mode).render(resolvedProps);
};

export default VisualizerRenderer;
