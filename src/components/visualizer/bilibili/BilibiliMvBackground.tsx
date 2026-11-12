import React from 'react';
import type { BilibiliMvResolution } from '../../../types/bilibili';
import { useBilibiliMvStore } from '../../../stores/useBilibiliMvStore';

// src/components/visualizer/bilibili/BilibiliMvBackground.tsx
// 「B 站 MV」背景：把这首歌对应的 bilibili 投稿画面铺满播放页，声音仍然是歌曲本身。
//
// 为什么只取画面：这样歌词、节奏、可视化都还跟着歌走，也不会因为 MV 的片头片尾
// 比歌曲长而错位。代价是音画可能对不上，所以有了下面那套偏移调校。
//
// 同步策略：视频跟着歌曲时钟走。
// - 播放中用 `currentTime` 追：视频时间 = 歌曲时间 + 偏移。
// - 偏得多了（换歌、拖动进度、视频自己卡了一下）就跳过去，而不是慢慢磨。
// - 暂停跟着暂停。
//
// 视频直链有时效（bilibili 给的签名地址过一阵就失效），所以出错时由 store 重新解析。

interface BilibiliMvBackgroundProps {
    songKey: string;
    songTitle: string;
    songArtist: string;
    /** 歌曲当前时间（秒）。 */
    currentTime: number;
    /** 歌曲总长（秒），0 表示不知道。 */
    duration: number;
    isPlaying: boolean;
}

/** 视频和歌曲时钟差多少就算「偏了」，直接跳过去。 */
const RESYNC_THRESHOLD_SEC = 0.35;
/** 慢速追的时候，每次最多挪多少（避免一顿一顿地跳）。 */
const MAX_DRIFT_CORRECTION = 0.25;

const BilibiliMvBackground: React.FC<BilibiliMvBackgroundProps> = ({
    songKey,
    songTitle,
    songArtist,
    currentTime,
    duration,
    isPlaying,
}) => {
    const videoRef = React.useRef<HTMLVideoElement | null>(null);
    const resolveForSong = useBilibiliMvStore(state => state.resolveForSong);
    const resolution = useBilibiliMvStore(state => state.bySongKey[songKey]);
    /** 上一次因为播放出错而重解析的那条直链，防止死循环。 */
    const retriedForUrlRef = React.useRef<string | null>(null);

    // 换歌就重新解析（store 里有缓存，同一首不会重复搜）。
    React.useEffect(() => {
        if (!songKey) return;
        void resolveForSong(songKey, songTitle, songArtist, duration);
    }, [songKey, songTitle, songArtist, duration, resolveForSong]);

    const stream = resolution?.stream ?? null;
    const offsetSec = useBilibiliMvStore(state => state.offsets[songKey] ?? 0);

    // 播放状态同步。
    React.useEffect(() => {
        const video = videoRef.current;
        if (!video || !stream) return;
        if (isPlaying) {
            // 自动播放可能被阻止，失败就静静等着，不弹错。
            void video.play().catch(() => undefined);
        } else {
            video.pause();
        }
    }, [isPlaying, stream]);

    // 时间同步：每帧看一眼差多少。
    React.useEffect(() => {
        const video = videoRef.current;
        if (!video || !stream) return;
        const target = currentTime + offsetSec;
        if (!Number.isFinite(target) || target < 0) return;
        const drift = Math.abs(video.currentTime - target);
        if (drift > RESYNC_THRESHOLD_SEC) {
            // 跳过去。video.currentTime 对超出范围的值会静默夹到可播范围里。
            video.currentTime = target;
            return;
        }
        // 差得不多：稍微挪一点，别让画面看起来在抖。
        if (drift > 0.05) {
            const step = Math.min(MAX_DRIFT_CORRECTION, target - video.currentTime);
            video.currentTime = Math.max(0, video.currentTime + step);
        }
    }, [currentTime, offsetSec, stream]);

    // 视频循环：MV 往往比歌曲短或长，播到头就绕回去。
    React.useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        const onEnded = () => { video.currentTime = 0; };
        video.addEventListener('ended', onEnded);
        return () => video.removeEventListener('ended', onEnded);
    }, []);

    if (!stream) {
        return <MvStatusOverlay resolution={resolution} songTitle={songTitle} />;
    }

    return (
        <div className="absolute inset-0 overflow-hidden bg-black">
            <video
                ref={videoRef}
                src={stream.videoUrl}
                className="absolute inset-0 h-full w-full object-cover"
                playsInline
                muted
                preload="auto"
                // 不给原生控件：这里只是一层背景，操作走歌曲的播放条。
                controls={false}
                onError={() => {
                    /*
                     * 直链过期（bilibili 的签名地址有时效），重新解析一次。
                     *
                     * 只重试一次：真解不出来（视频被删、地区限制）时一直重试就是死循环，
                     * 每秒打一次接口。计数跟着 stream 走，换了一条新流才重新给机会。
                     */
                    if (retriedForUrlRef.current === stream.videoUrl) return;
                    retriedForUrlRef.current = stream.videoUrl;
                    void resolveForSong(songKey, songTitle, songArtist, duration, true);
                }}
            />
            {/* 压一层暗角，歌词压在上面时读得清。 */}
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_35%,rgba(0,0,0,0.55)_100%)]" />
        </div>
    );
};

/** 没有画面时说明原因。搜索失败 / 没匹配上 / 还在找，三种情况说的话不一样。 */
const MvStatusOverlay: React.FC<{
    resolution?: BilibiliMvResolution;
    songTitle: string;
}> = ({ resolution, songTitle }) => {
    const state = resolution?.state ?? 'idle';
    let text = `正在查找《${songTitle}》的 MV…`;
    if (state === 'missing') text = `没有找到《${songTitle}》的 MV`;
    else if (state === 'error') text = resolution?.message || 'MV 加载失败了';
    else if (state === 'idle' && !songTitle) text = '';

    return (
        <div className="absolute inset-0 flex items-center justify-center bg-black">
            <span className="px-6 text-center text-sm text-white/45">{text}</span>
        </div>
    );
};

export default React.memo(BilibiliMvBackground);
