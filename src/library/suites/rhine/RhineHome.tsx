import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LibraryHomeSurfaceProps } from '../../core/suite/suite.contract';
import { buildRhinePayload, queueOf, type RhinePayload } from './rhinePayload';
import { openLoginWindow } from '../../../components/login/loginWindowStore';
import { Button } from '../../../components/ui/Button';
import { LogIn } from 'lucide-react';

// src/library/suites/rhine/RhineHome.tsx
//
// 「莱茵生命」首页。
//
// 三维档案阵列**不再由原生 Filament 渲染**：那套桥太重，一个相机参数或贴图生命周期
// 出问题就整屏黑、点不中、滑不动。这里直接嵌入 RhineLabUI
// （https://github.com/LBEILC/RhineLabUI，TypeScript + Three.js）的构建产物，
// 它自带五列循环档案阵列、开屏动画、音效与 BGM，全部在网页层完成，
// 不会再和原生窗口抢前台。
//
// 静态资源在 `public/rhinelab/`，构建后随 `dist` 一起进 APK。

const RHINE_PAGE = './rhinelab/rhine.htm#folia';

const RhineHome = (props: LibraryHomeSurfaceProps): React.ReactElement => {
    const { t } = useTranslation();
    const frameRef = useRef<HTMLIFrameElement | null>(null);
    const [ready, setReady] = useState(false);
    /** 转换好的曲库载荷；iframe 就绪后推给它。 */
    const payloadRef = useRef<RhinePayload | null>(null);
    /** 把载荷 postMessage 进 iframe。曲目对象原样带走，点开档案时要用它播放。 */
    const pushPayload = useCallback((): void => {
        const frame = frameRef.current;
        const payload = payloadRef.current;
        if (!frame?.contentWindow || !payload) return;
        frame.contentWindow.postMessage({ type: 'rhine-library', payload }, '*');
    }, []);

    /*
     * 曲库 → 三维阵列。
     *
     * iframe 一上来就加载，开屏动画立刻开始播 —— 它本身就是这期间的加载动画，
     * 比之前「先白屏等数据算完再挂 src」体感好得多。
     *
     * 三维阵列那边已经配合改成「先跑开屏，收到曲库再建场景」，
     * 所以这里不需要再等：数据一到就推，推早了那边会先存着。
     */
    useEffect(() => {
        let disposed = false;
        void buildRhinePayload(props)
            .then(payload => {
                if (disposed || !payload) return;
                payloadRef.current = payload;
                pushPayload();
            })
            .catch(error => console.warn('[rhine] 曲库转换失败', error));
        return () => {
            disposed = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props]);

    /*
     * 播放 / 入队。
     *
     * 三维阵列那侧只认 `record.id`，认不出这是 Folia 的哪一首歌；这里用 `songs`
     * 表把它翻回原始曲目。
     *
     * **第二个参数是队列**：之前传 `undefined`，于是点一首歌就真的只播那一首，
     * 播完即停。这里把同一列（同一个歌单）的歌按列内顺序整段传进去，
     * 播放列表就是「这个歌单全部歌曲」，和网格界面双击歌单的行为一致。
     */
    useEffect(() => {
        const play = props.onPlaySong;
        const enqueueAll = props.onAddAllToQueue;
        const onMessage = (event: MessageEvent): void => {
            const data = event.data as { type?: string; id?: string } | null;
            if (!data || typeof data.id !== 'string') return;
            if (data.type !== 'rhine-play' && data.type !== 'rhine-enqueue') return;
            const payload = payloadRef.current;
            const song = payload?.songs[data.id];
            if (!payload || !song) return;

            // 这个 id 在哪一列，就把整列当作队列。
            const queue = queueOf(payload, data.id);

            if (data.type === 'rhine-enqueue') {
                const list = queue.length > 1 ? queue : [song];
                if (enqueueAll) enqueueAll(list as never[]);
                else if (props.onAddSongToQueue) props.onAddSongToQueue(song as never);
                return;
            }

            play(song as never, queue.length ? (queue as never[]) : undefined, false, undefined);
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [props.onPlaySong, props.onAddAllToQueue, props.onAddSongToQueue]);


    /*
     * 登录入口。
     *
     * 三维阵列整块是 iframe，网页层这边只剩这一个常驻按钮 —— 曲库为空（没登录、
     * 没本地扫描）时它是唯一的出路。
     *
     * 放**顶部左侧**：底部那一条被 RhineLab 自己的东西占满了
     * （ARCHIVE / SELECT、COLUMN 导航、SESSION AUTHORIZED、REINITIALIZE），
     * 再叠一个按钮就会压住它们；顶部这一行只有品牌标题，左边正好是空的。
     */
    const loginButton = (
        <div
            className="lattice-back absolute z-50"
            style={{
                left: 'calc(16px + var(--folia-safe-area-left, 0px))',
                top: 'calc(16px + var(--folia-safe-area-top, 0px))',
            }}
        >
            <Button
                variant="fill"
                icon={LogIn}
                onClick={(event: React.MouseEvent<HTMLElement>) => openLoginWindow(null, event.currentTarget)}
            >
                {t('home.login')}
            </Button>
        </div>
    );

    return (
        <div className="relative h-full w-full overflow-hidden" style={{ background: '#e8e5e1' }}>
            {/*
                内嵌的三维档案阵列。不带 sandbox：它要自己用 WebAudio / localStorage /
                IndexedDB 缓存模型和音频，sandbox 一加这些全被挡掉、开屏动画直接静音失败。
            */}
            <iframe
                ref={frameRef}
                title={t('libraryRhine.stageTitle')}
                src={RHINE_PAGE}
                className="absolute inset-0 h-full w-full border-0"
                style={{ background: '#e8e5e1' }}
                allow="autoplay; fullscreen"
                onLoad={() => {
                    setReady(true);
                    pushPayload();
                }}
            />

            {/*
                开屏完成前先盖一层同色底，避免 iframe 白闪。
                它不拦截任何事件，只是遮住加载瞬间。
            */}
            {!ready && (
                <div
                    className="pointer-events-none absolute inset-0 z-40"
                    style={{ background: '#e8e5e1' }}
                />
            )}

            {loginButton}
        </div>
    );
};

export default RhineHome;
