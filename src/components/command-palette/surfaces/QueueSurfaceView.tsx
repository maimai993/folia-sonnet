import React from 'react';
import CommandPaletteQueueView from '../CommandPaletteQueueView';
import type { QueueSearchSuggestion } from '../queueSearch';

// src/components/command-palette/surfaces/QueueSurfaceView.tsx
// Lazy entry point for the queue surface; restores input focus after a completion is accepted.

type QueueSurfaceViewProps = React.ComponentProps<typeof CommandPaletteQueueView> & {
    refocusInput: () => void;
};

const QueueSurfaceView: React.FC<QueueSurfaceViewProps> = ({ refocusInput, onAcceptSuggestion, ...rest }) => (
    <CommandPaletteQueueView
        {...rest}
        onAcceptSuggestion={(suggestion: QueueSearchSuggestion) => {
            onAcceptSuggestion(suggestion);
            refocusInput();
        }}
    />
);

export default QueueSurfaceView;
