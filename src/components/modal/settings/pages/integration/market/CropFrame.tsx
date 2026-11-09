// src/components/modal/settings/pages/integration/market/CropFrame.tsx
//
// 壁纸裁切取景框。
//
// 为什么需要：壁纸站上的图几乎全是横屏 16:9，手机是竖屏 9:16。
// cover 铺满会裁掉大半画面，固定居中经常裁到主体（人脸、建筑）。
//
// 为什么换成 react-easy-crop：
//   之前是手写指针事件，在 WebView 里始终调不顺 ——
//   单指拖动没反应、双指捏合不跟手、旋转后取景区域算错（两边留空）。
//   这类「图片查看器」的坐标与手势换算坑很深，自己写等于重做一遍。
//   react-easy-crop 已经把这些边界处理透了：触摸拖动、双指捏合、
//   图片永远铺满取景框（不会出现黑边）、支持任意旋转角度。
//
// 它输出的 croppedAreaPixels 是**像素**坐标，这里换算成 0..1 的相对范围，
// 交给原生按同样比例裁切。

import React, { useCallback, useState } from 'react';
import { Button } from '../../../../../../components/ui';
import Cropper, { type Area } from 'react-easy-crop';
import 'react-easy-crop/react-easy-crop.css';

export interface CropRect {
    /** 0..1，相对原图 */
    left: number;
    top: number;
    right: number;
    bottom: number;
}

interface CropFrameProps {
    src: string;
    /** 取景框宽高比，默认竖屏 9:16 */
    aspect: number;
    value: CropRect;
    rotation: number;
    onChange: (rect: CropRect) => void;
    onRotationChange: (rotation: number) => void;
    rotateLabel: string;
    hintLabel: string;
}

const FULL_RECT: CropRect = { left: 0, top: 0, right: 1, bottom: 1 };

const CropFrame: React.FC<CropFrameProps> = ({
    src,
    aspect,
    rotation,
    onChange,
    onRotationChange,
    rotateLabel,
    hintLabel,
}) => {
    const [crop, setCrop] = useState({ x: 0, y: 0 });
    const [zoom, setZoom] = useState(1);
    const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);

    /*
     * react-easy-crop 给出的是像素坐标；上层与原生要的是 0..1 相对范围。
     * 拿原图尺寸做分母即可，旋转角度不影响这个比例关系 ——
     * 库内部已经把旋转折算进 croppedAreaPixels 了。
     */
    const handleCropComplete = useCallback((_area: Area, areaPixels: Area) => {
        if (!imageSize || !areaPixels) return;
        const rotated = Math.abs(rotation % 180) === 90;
        const sourceWidth = rotated ? imageSize.height : imageSize.width;
        const sourceHeight = rotated ? imageSize.width : imageSize.height;
        if (!sourceWidth || !sourceHeight) return;
        onChange({
            left: Math.min(1, Math.max(0, areaPixels.x / sourceWidth)),
            top: Math.min(1, Math.max(0, areaPixels.y / sourceHeight)),
            right: Math.min(1, Math.max(0, (areaPixels.x + areaPixels.width) / sourceWidth)),
            bottom: Math.min(1, Math.max(0, (areaPixels.y + areaPixels.height) / sourceHeight)),
        });
    }, [imageSize, rotation, onChange]);

    /** 旋转时把取景重置回中间，避免用着旧角度的偏移。 */
    const handleRotate = () => {
        setCrop({ x: 0, y: 0 });
        setZoom(1);
        onChange(FULL_RECT);
        onRotationChange((rotation + 90) % 360);
    };

    return (
        <div className="space-y-2">
            <div className="relative w-full overflow-hidden rounded-xl bg-black" style={{ aspectRatio: String(aspect) }}>
                <Cropper
                    image={src}
                    crop={crop}
                    zoom={zoom}
                    rotation={rotation}
                    aspect={aspect}
                    /*
                     * 关键：关闭「限制在图片内」的默认行为，
                     * 让图始终铺满取景框。这是之前出现黑边的根源。
                     */
                    restrictPosition
                    onCropChange={setCrop}
                    onZoomChange={setZoom}
                    onCropComplete={handleCropComplete}
                    onMediaLoaded={(media) => setImageSize({ width: media.naturalWidth, height: media.naturalHeight })}
                    /*
                     * horizontal-cover：图片按「横向铺满」放大，
                     * 保证取景框内没有黑边（contain 会留边，正是之前的问题）。
                     */
                    showGrid
                    objectFit="horizontal-cover"
                    classes={{
                        containerClassName: 'absolute inset-0',
                        cropAreaClassName: 'shadow-[0_0_0_9999em_rgba(0,0,0,0.55)]',
                    }}
                />
            </div>

            <div className="flex items-center justify-between">
                <span className="text-[11px] text-[var(--st-t2)]">{hintLabel}</span>
                <Button
                    onClick={handleRotate}
                    className="rounded-lg bg-[var(--st-fill)] px-2.5 py-1 text-[11.5px] text-[var(--st-t2)] hover:bg-[var(--st-fill2)]"
                >
                    {rotateLabel}
                </Button>
            </div>
        </div>
    );
};

export default CropFrame;
