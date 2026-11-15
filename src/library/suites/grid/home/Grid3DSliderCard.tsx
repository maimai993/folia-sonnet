import React from 'react';
import { Disc } from 'lucide-react';
import { getSizedCoverUrl } from '../../../../utils/coverUrl';
import { resolveProxiedCollectionCover } from '../../../../services/onlineMusic/onlineCoverFallback';
import { CARD_TITLE_ATTR, MORPH_FRAME_ATTR } from '../transitions/gridMorphContract';
import {
    getGrid3DSliderDisplayName,
    getGrid3DSliderSecondaryText,
    getGrid3DSliderSummaryText,
    getLocalFolderPath,
    type Grid3DSliderItem,
} from './grid3DSliderModel';

// src/library/suites/grid/home/Grid3DSliderCard.tsx
// 滑条里的一张卡：图片档或相纸档。外观与 Grid3DSlider 里原先写的逐字一致。

interface Grid3DSliderCardProps {
    item: Grid3DSliderItem;
    index: number;
    isFocused: boolean;
    coverSize: number;
    cardStyle: 'image' | 'card';
    /** 这张卡在聚焦项附近（渲染窗口里），封面已经可以加载。 */
    hasCover: boolean;
    marginRight: number;
    onClick: () => void;
}

export const Grid3DSliderCard: React.FC<Grid3DSliderCardProps> = ({
    item,
    index,
    isFocused,
    coverSize,
    cardStyle,
    hasCover,
    marginRight,
    onClick,
}) => {
    const folderPath = getLocalFolderPath(item);
    const displayName = getGrid3DSliderDisplayName(item);
    const secondaryText = getGrid3DSliderSecondaryText(item);
    const summaryText = getGrid3DSliderSummaryText(item);

    return (
        <div
            data-grid3d-index={index}
            className="shrink-0 cursor-pointer pointer-events-auto select-none"
            style={{ marginRight }}
            onClick={onClick}
        >
            {cardStyle === 'image' ? (
                <div
                    data-grid3d-card="image"
                    className={`aspect-square rounded-2xl overflow-hidden shadow-2xl relative border border-white/10 ${
                        isFocused ? 'ring-2 ring-white/30' : ''
                    }`}
                    style={{ width: coverSize, height: coverSize }}
                >
                    {item.coverUrl && hasCover ? (
                        <img src={getSizedCoverUrl(resolveProxiedCollectionCover(item.coverUrl), coverSize)} alt={typeof displayName === 'string' ? displayName : ''} loading="lazy" decoding="async" className="w-full h-full object-cover pointer-events-none select-none" />
                    ) : (
                        <div className="w-full h-full bg-zinc-800/20 flex items-center justify-center">
                            <Disc size={64} className="opacity-20" />
                        </div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-tr from-white/10 to-transparent opacity-0 hover:opacity-100 transition-opacity" />
                </div>
            ) : (
                <div
                    {...{ [MORPH_FRAME_ATTR]: '' }}
                    data-grid3d-card="polaroid"
                    className="rounded-xl border p-4 flex flex-col items-center backdrop-blur-md shadow-lg hover:shadow-2xl theme-polaroid-card"
                    style={{ width: coverSize }}
                >
                    <div data-grid3d-card-cover className="w-full aspect-square rounded-lg overflow-hidden bg-zinc-800/20 relative shadow-inner mb-4 flex items-center justify-center">
                        {item.coverUrl && hasCover ? (
                            <img src={getSizedCoverUrl(item.coverUrl, coverSize)} alt={typeof displayName === 'string' ? displayName : ''} loading="lazy" decoding="async" className="w-full h-full object-cover pointer-events-none select-none" />
                        ) : (
                            <Disc size={64} className="opacity-20" />
                        )}
                    </div>

                    <div data-grid3d-card-text className="w-full text-left pt-2 min-w-0">
                        <h3 {...{ [CARD_TITLE_ATTR]: '' }} className="font-bold text-sm truncate max-w-full tracking-tight">
                            {displayName}
                        </h3>
                        {secondaryText && (
                            <p
                                className={`text-xs opacity-50 max-w-full mt-1 font-medium ${folderPath ? 'line-clamp-2 break-words' : 'truncate'}`}
                                title={folderPath || undefined}
                            >
                                {secondaryText}
                            </p>
                        )}
                        {summaryText && (
                            <p className="text-[10px] leading-snug opacity-45 mt-2 line-clamp-2">
                                {summaryText}
                            </p>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
