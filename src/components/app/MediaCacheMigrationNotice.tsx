import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { migrateLegacyMediaCache } from '../../services/mediaCacheMigration';

// src/components/app/MediaCacheMigrationNotice.tsx
/**
 * 启动时把上一版的媒体缓存搬进私有目录，搬的过程中在底部挂一条提示。
 *
 * 提示走 `createPortal` 挂到 body：App 的外壳是 `fixed inset-0`，就地挂的弹层会被
 * 祖先上的 transform / 合成层牵连（弹出来却点不动那类毛病都是这么来的）。
 * 尺寸一律 rem —— 手机那套缩放改的是根字号，写死 px 不吃缩放。
 */
const MediaCacheMigrationNotice: React.FC = () => {
    const { t } = useTranslation();
    const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null);

    React.useEffect(() => {
        let alive = true;
        void (async () => {
            // 首屏先出来：搬缓存是重活，别压在启动那一帧上。
            await new Promise(resolve => setTimeout(resolve, 1500));
            const result = await migrateLegacyMediaCache(next => {
                if (alive) setProgress(next);
            });
            if (!alive) return;
            if (result.migrated > 0 || result.dropped > 0) {
                console.log(
                    `[Cache] 旧版本媒体缓存已清除：迁入私有目录 ${result.migrated} 条`
                    + `，没搬成直接删掉 ${result.dropped} 条（共 ${result.total} 条）`,
                );
            }
            setProgress(null);
        })();
        return () => {
            alive = false;
        };
    }, []);

    if (!progress || progress.total <= 0) return null;

    return createPortal(
        <div
            style={{
                position: 'fixed',
                left: 0,
                right: 0,
                // 底部那层归播放条（z-60），这里压在它上面一点。
                bottom: 'calc(6.5rem + env(safe-area-inset-bottom, 0px))',
                display: 'flex',
                justifyContent: 'center',
                zIndex: 200,
                pointerEvents: 'none',
            }}
        >
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.55rem 1.05rem',
                    borderRadius: '999px',
                    background: 'rgba(16, 16, 20, 0.92)',
                    color: '#f5f5f7',
                    fontSize: '0.82rem',
                    lineHeight: 1.4,
                    boxShadow: '0 0.4rem 1.4rem rgba(0, 0, 0, 0.35)',
                }}
            >
                <span>{t('notifications.mediaCacheMigrating')}</span>
                <span style={{ opacity: 0.65 }}>
                    {progress.done}/{progress.total}
                </span>
            </div>
        </div>,
        document.body,
    );
};

export default MediaCacheMigrationNotice;
