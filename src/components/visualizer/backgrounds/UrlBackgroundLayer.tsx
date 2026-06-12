import React, { useMemo } from 'react';
import type { UrlBackgroundItem } from '../../../types';

// src/components/visualizer/backgrounds/UrlBackgroundLayer.tsx
// Renders a webpage as background via iframe.
// Uses key={url} to force full iframe recreation on URL change,
// avoiding chrome-error://chromewebdata cross-origin navigation issues.

interface UrlBackgroundLayerProps {
    urlBackgroundList?: UrlBackgroundItem[];
    urlBackgroundSelectedId?: string | null;
}

const UrlBackgroundLayer: React.FC<UrlBackgroundLayerProps> = ({
    urlBackgroundList = [],
    urlBackgroundSelectedId = null,
}) => {
    const selectedItem = useMemo(
        () => urlBackgroundList.find(item => item.id === urlBackgroundSelectedId) ?? null,
        [urlBackgroundList, urlBackgroundSelectedId],
    );

    if (!selectedItem?.url) return null;

    return (
        <div className="absolute inset-0 z-0 overflow-hidden">
            {/* key forces React to destroy and recreate the iframe when URL changes,
                preventing chrome-error://chromewebdata cross-origin navigation errors */}
            <iframe
                key={selectedItem.url}
                src={selectedItem.url}
                title={selectedItem.note || selectedItem.url}
                className="w-full h-full border-0"
                style={{
                    pointerEvents: 'none',
                }}
                allowFullScreen
            />
            {/* Semi-transparent overlay to ensure lyrics readability */}
            <div
                className="absolute inset-0"
                style={{
                    background: 'linear-gradient(to bottom, rgba(0,0,0,0.15), rgba(0,0,0,0.35))',
                    pointerEvents: 'none',
                }}
            />
        </div>
    );
};

export default UrlBackgroundLayer;
