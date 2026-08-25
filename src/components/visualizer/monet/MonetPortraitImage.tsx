import React from 'react';

// src/components/visualizer/monet/MonetPortraitImage.tsx

type MonetPortraitImageProps = {
    src?: string | null;
};

// Replaces the image node when an asynchronously resolved cover URL changes.
const MonetPortraitImage: React.FC<MonetPortraitImageProps> = ({ src }) => (
    <img
        key={src || 'empty'}
        src={src || undefined}
        decoding="async"
        alt=""
        className="h-full w-full object-cover"
        style={{ opacity: src ? 1 : 0, transition: 'opacity 1s ease' }}
        draggable={false}
        data-monet-portrait-image
    />
);

export default MonetPortraitImage;
