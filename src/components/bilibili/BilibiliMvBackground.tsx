import React from 'react';
import type { BilibiliMvResolution } from '../../types/bilibili';
import { useBilibiliMvStore } from '../../stores/useBilibiliMvStore';

// src/components/bilibili/BilibiliMvBackground.tsx
// 「B 站 MV」背景：把这首歌对应的 bilibili 投稿画面铺满播放页。
//
// 这一层**只出画面，永远静音**。声音由播放器放 —— 解析时把 bilibili DASH 里的声音轨
// （BilibiliMvStream.audioUrl）交给播放器当这首歌的音源，画面这条流只 decode 视频。
//
// 为什么这样分：两端都来自同一个投稿、同一条 DASH，起点天然对齐，不需要任何音画偏移；
// 而进度条、歌词、可视化仍旧读播放器的时钟，拖进度就是拖 MV，一处改动全跟着走。
//
// 视频直链有时效（bilibili 给的签名地址过一阵就失效），所以出错时由 store 重新解析。

interface BilibiliMvBackgroundProps {
    songKey: string;
    songTitle: string;
    songArtist: string;
    /** 播放器当前时间（秒）—— 画面跟着它走。 */
    currentTime: number;
    /** 歌曲总长（秒），0 表示不知道。 */
    duration: number;
    isPlaying: boolean;
}

/** 画面和播放器时钟差多少就算「偏了」，直接跳过去。 */
const RESYNC_THRESHOLD_SEC = 0.35;

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

    /*
     * 时间同步：画面跟着播放器时钟走。
     *
     * 声音已经由播放器在放（同一条 DASH 的声音轨），所以这里对齐的是「同一份时间的画面」，
     * 不需要任何偏移。偏得多了（换歌、拖进度、视频卡了一下）就跳过去，差得少就慢慢挪。
     */
    React.useEffect(() => {
        const video = videoRef.current;
        if (!video || !stream) return;
        const target = currentTime;
        if (!Number.isFinite(target) || target < 0) return;
        const drift = Math.abs(video.currentTime - target);
        if (drift > RESYNC_THRESHOLD_SEC) {
            video.currentTime = target;
            return;
        }
        if (drift > 0.05) {
            const step = Math.min(0.25, target - video.currentTime);
            video.currentTime = Math.max(0, video.currentTime + step);
        }
    }, [currentTime, stream]);

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
                // 这一层只出画面：声音由播放器放同一条 DASH 的声音轨。
                // 不静音的话同一条音轨会响两遍（差几十毫秒，听起来是回声）。
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
