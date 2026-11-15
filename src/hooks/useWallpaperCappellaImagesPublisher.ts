import { useEffect } from 'react';
import { useVisualizerAssetStore } from '../stores/useVisualizerAssetStore';
import { resolveObsBrowserSourceImageAssets } from '../utils/obsBrowserSource';
import { publishWallpaperCappellaImages } from '../platform/foliaWallpaper';

// src/hooks/useWallpaperCappellaImagesPublisher.ts
// 群唱（Cappella）自定义头像 / 表情图 → 桌面叠层。
//
// 为什么需要这条路：叠层是**另一个 WebView**，它自己的 IndexedDB 是空的 —— 用户在
// 设置里上传的头像 / 表情包存在主应用这边，叠层一张都读不到。于是 `avatarSource` 是
// custom、列表却是空的，Cappella 按「没有自定义头像」回退到封面（用户报的
// 「群唱自定义头像显示的是封面」）。
//
// 解析走的是 OBS 浏览器源同一条路（resolveObsBrowserSourceImageAssets）：store 里存的是
// 主窗口的 blob / object URL，叠层那个 origin 拉不到，必须先转成 data URL 再推。
export const useWallpaperCappellaImagesPublisher = (): void => {
    const avatars = useVisualizerAssetStore(state => state.cappellaCustomAvatarImages);
    const emojis = useVisualizerAssetStore(state => state.cappellaCustomEmojiImages);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const [resolvedAvatars, resolvedEmojis] = await Promise.all([
                resolveObsBrowserSourceImageAssets(avatars),
                resolveObsBrowserSourceImageAssets(emojis),
            ]);
            if (cancelled) return;
            await publishWallpaperCappellaImages(resolvedAvatars, resolvedEmojis);
        })().catch(error => {
            console.warn('[Wallpaper] 群唱自定义图推送失败', error);
        });
        return () => {
            cancelled = true;
        };
    }, [avatars, emojis]);
};
