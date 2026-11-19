import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LibraryHomeSurfaceProps } from '../../core/suite/suite.contract';
import { useThemeSettingsStore } from '../../../stores/useThemeSettingsStore';
import { getPhoneInsets, subscribePhoneInsets } from '../../../services/phoneInsets';
import { openLoginWindow } from '../../../components/login/loginWindowStore';
import { Button } from '../../../components/ui/Button';
import { LogIn } from 'lucide-react';
import { buildRhineFrameSrc, buildRhineHostConfig } from './rhineHostConfig';

// src/library/suites/rhine/RhineHome.tsx
//
// 「莱茵生命」主题首页。
//
// 这一版换成 RhinE（https://github.com/ericzhang12111-cell/RhinE，v2.1.1，MIT）的代码骨架：
// 主题代码原样放在 `res/rhine-theme/`，宿主这边只渲染一个 iframe 指向它的 `index.html`，把
// 语言、明暗、安全区和资源包状态推过去（格式见 `res/rhine-theme/RHINE-ASSETS.md`）。分层口径
// 见 `res/rhine-theme/THEME-LAYERING.md`。
//
// 上一版嵌的是 RhineLabUI 的打包产物（`public/rhinelab/`），靠往压缩后的 bundle 里插探针改
// 行为，上游一换构建就断。那一整套连同补丁脚本、探针脚本已经撤掉。
//
// 资源包（913 MB 的 `assets/`）不进仓库，按 #440 做成可选下载；没下载时主题仍然可用，
// 缺图处退回纯色 / 占位（见 `res/rhine-theme/adapt/rhineFallback.css` 的注释）。

/**
 * 有没有下载过资源包。
 *
 * 骨架目前只有仓库里那一份代码，下载链路归 #440，所以这里恒为 `false`。放在一个函数里而不是
 * 直接写字面量：接上 #440 时只需要改这里，`RhineHome` 与测试都不用动。
 */
const assetsPackageAvailable = (): boolean => false;

const RhineHome = (props: LibraryHomeSurfaceProps): React.ReactElement => {
    const { t, i18n } = useTranslation();
    const frameRef = useRef<HTMLIFrameElement | null>(null);
    const [ready, setReady] = useState(false);
    const isDaylight = useThemeSettingsStore(state => state.isDaylight);
    /** 界面语言，跟着 Folia 的设置走；主题不支持时退回英文。 */
    const language = i18n.resolvedLanguage || i18n.language || 'en';
    const hasAssets = assetsPackageAvailable();
    /** 资源包缺失时给用户的一句说明；文案走 i18n，不用主题内置的英文。 */
    const note = hasAssets ? '' : t('libraryRhine.assetsMissing');

    /** 把宿主状态整份推过去。主题那边只认这一条消息（`res/rhine-theme/host-entry.js`）。 */
    const pushConfig = useCallback((): void => {
        const frame = frameRef.current;
        if (!frame?.contentWindow) return;
        const config = buildRhineHostConfig({
            language,
            isDaylight,
            hasAssetsPackage: hasAssets,
            note,
            insets: getPhoneInsets(),
        });
        frame.contentWindow.postMessage({ type: 'rhine-config', config }, '*');
    }, [language, isDaylight, hasAssets, note]);

    // 换语言、切明暗、主题就绪后各推一次：主题那边收到就地重绘，不用重载 iframe。
    useEffect(() => {
        if (!ready) return;
        pushConfig();
    }, [ready, pushConfig]);

    // 转屏、进全屏、状态栏收放都会改变安全区，跟着推。
    useEffect(() => subscribePhoneInsets(() => pushConfig()), [pushConfig]);

    /*
     * 主题发回来的消息只认它自己的窗口。
     *
     * iframe 没加 `sandbox`（主题要用 WebAudio / 存储），所以别的窗口也可能往这里 post；
     * 按 `event.source` 卡在 iframe 上，和消息里写的内容无关。
     */
    useEffect(() => {
        const onMessage = (event: MessageEvent): void => {
            const frame = frameRef.current?.contentWindow;
            if (!frame || event.source !== frame) return;
            const data = event.data as { type?: string; degraded?: boolean } | null;
            if (data?.type !== 'rhine-theme-ready') return;
            // 主题自己已经把壳画出来了，撤掉同色底那层，别让用户看着一块纯色等。
            setReady(true);
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, []);

    /*
     * 登录入口。
     *
     * iframe 里的主题只画它自己的东西，网页层这边留一个常驻按钮：曲库为空（没登录、没本地扫描）
     * 时它是唯一的出路。位置让开顶部安全区，压在网格首页的同一个位置上。
     */
    const loginButton = (
        <div
            className="absolute z-50"
            style={{
                left: 'calc(12px + var(--folia-safe-area-left, 0px))',
                top: 'calc(96px + var(--folia-safe-area-top, 0px))',
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
        <div className="relative h-full w-full overflow-hidden" data-rhine-home="1" style={{ background: isDaylight ? '#eeede7' : '#0b0b0b' }}>
            {/*
                主题骨架。`assets` 参数告诉它资源包在不在，`note` 那句说明由宿主按 i18n 给。
                推一次不依赖 iframe 的消息：它在 onLoad 之后再推一遍，两遍用同一份 config。
            */}
            <iframe
                ref={frameRef}
                title={t('libraryRhine.stageTitle')}
                src={buildRhineFrameSrc({
                    language,
                    isDaylight,
                    hasAssetsPackage: hasAssets,
                    note,
                    insets: getPhoneInsets(),
                })}
                className="absolute inset-0 h-full w-full border-0"
                style={{ background: isDaylight ? '#eeede7' : '#0b0b0b' }}
                allow="autoplay; fullscreen"
                onLoad={() => {
                    setReady(true);
                    pushConfig();
                }}
            />

            {/*
                主题就绪前先盖一层同色底，避免 iframe 白闪。它不拦截事件，也不遮住任何可交互
                的东西 —— 主题本身在 `res/rhine-theme/index.html` 里已经把壳画出来了。
            */}
            {!ready && (
                <div
                    className="pointer-events-none absolute inset-0 z-40"
                    style={{ background: isDaylight ? '#eeede7' : '#0b0b0b' }}
                />
            )}

            {loginButton}
        </div>
    );
};

export default RhineHome;
