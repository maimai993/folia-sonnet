import { Buffer } from 'buffer';
import { ensureBackgroundRenderGateInstalled } from './utils/backgroundRenderGate';
import { installGlobalVisualizerFrameRateLimiter } from './utils/frameRateLimiter';
import { installRenderPixelRatioLimit } from './utils/renderPixelRatio';
import { installConsoleLogCapture } from './utils/consoleLogBuffer';
import { installDebugModule } from './services/debug/debugModule';
import { installMemorySampleFeed } from './services/debug/memorySamples';
import { installNativeAndroidBridge } from './services/nativeAndroidBridge';
import { installPerfDiagnosticsSwitch } from './utils/frameTimingDiagnostics';
import { setMediaDiagnosticsEnabledReader } from './utils/mediaDiagnostics';
import { usePerfDiagnosticsStore } from './stores/usePerfDiagnosticsStore';
import { installAndroidPhoneFitPreference, installDeviceProfilePreference } from './services/androidPhoneLayout';
import { installHdrProjectionPreference } from './services/hdrProjection';
import { installAndroidModsBridge } from './mods/android/androidModsBridge';
// import { installCoverSizeAudit } from './services/debug/coverSizeSamples';
// @ts-ignore
globalThis.Buffer = Buffer;
// First, so the debug overlay's console tab has the startup lines too - they are where a failure
// to reach a library or restore a session shows up.
installConsoleLogCapture();
// Right after it, so the startup lines reach the runtime log file too and not only the in-memory
// buffer. Both no-op off Electron. See services/debug/debugModule.ts.
installDebugModule();
installMemorySampleFeed();
// 只在安卓原生端有作用；桌面/网页会立刻返回，不会碰 Capacitor。
// 莱茵生命的原生桥由插件 load() 自启动，入口不再需要唤醒（分层边界：只有 registry 能碰 suite）。
// Cover size audit, left wired but switched off: it answered whether the provider CDNs honour the
// size in a cover URL - they do - and that is not a question worth re-asking every session. The
// collector and its panel are still in the tree, and `?probe=coverSizeAudit` still reaches them.
// To bring the tab back, uncomment this line and the four sites in DevDebugOverlay.tsx. It was dev
// only even then: a packaged build has nothing to do with the answer, so it should not pay the
// observer or the rows it retains.
// if (import.meta.env.DEV) installCoverSizeAudit();
/*
 * 后台渲染总闸。必须装在下面那个帧率限制器**之前**：限制器会把「当时的」原生 rAF 存起来
 * 当底层用，装在它后面就只能拦到没被限制的那部分循环。
 *
 * 装了不等于暂停 —— 只是把 rAF 过一道闸，真正翻转开关的是 useBackgroundRenderPause
 * （挂在主界面上）。壁纸叠层是另一个入口（wallpaper.html），不经过这里，所以它在桌面
 * 上照常渲染。
 */
ensureBackgroundRenderGateInstalled();
installGlobalVisualizerFrameRateLimiter();
installRenderPixelRatioLimit();
/*
 * 帧耗时 / 长任务采样。用户报「卡顿」时靠它区分「我们的渲染开销」与「设备性能不足」，
 * 在调试面板的 Perf 页看。必须装在帧率限制器之后：它优先用限制器保存的原生 rAF，
 * 否则会把用户自己设的帧率上限当成掉帧。
 *
 * **默认不采样**，由开发者选项里的「性能采样」开关控制（见 usePerfDiagnosticsStore）：
 * 这条 rAF 循环是常驻开销，只有真在查问题的时候才该付。开关可以随时翻，
 * 这里订阅它做启停。
 *
 * 采样模块自己不 import store（utils → stores 是反的依赖方向），所以读值与订阅在这里
 * 接给它；媒体诊断那份计数用的是同一个开关，只要读值（每个音频事件问一次现值，
 * 不需要订阅）。
 */
const perfDiagnosticsPort = {
    isEnabled: () => usePerfDiagnosticsStore.getState().perfDiagnosticsEnabled,
    subscribe: (listener: (enabled: boolean) => void) => {
        usePerfDiagnosticsStore.subscribe((state) => listener(state.perfDiagnosticsEnabled));
    },
};
installPerfDiagnosticsSwitch(perfDiagnosticsPort);
setMediaDiagnosticsEnabledReader(perfDiagnosticsPort.isEnabled);
// 本地登录的地基：把内置的接口代码挂到页面与原生之间。它是异步的（要 import 那份 JS），
// 但装好之前页面发来的请求会被排队，装好后统一补发，所以不用 await。
void installNativeAndroidBridge();
// 手机适配的属性必须在首帧之前落到 <html> 上：否则用户开了开关后，React 挂载那一瞬
// 会先按桌面布局量一遍尺寸，再被 CSS 拉回手机布局，开屏那一下看得见跳变。
installAndroidPhoneFitPreference();
// 设备类型（手机 / 平板）：选了手机的话横屏整屏缩一档，同样要在首帧之前落到 <html> 上，
// 否则第一帧按原始尺寸铺完再缩，开屏那一下看得见跳变。
installDeviceProfilePreference();
// HDR 投影：上次开着的话，镜像要在首帧之前落到 <html> 上（理由同上），剩下的横屏与
// 亮度由它自己那 5 秒倒计时带过去 —— 那时 React 还没挂载，界面上没人看着。
installHdrProjectionPreference();
/*
 * 安卓端的模组桥：把原生 FoliaMods 插件包成桌面端那一份 `window.electron.mods`。
 *
 * 必须赶在 `./bootstrap` **之前**装上：模组 client 在启动链里就被 import 了，而它们只认
 * 这个对象；如果晚一步，第一次 reconcile 会以为没有任何模组。桌面端/网页上直接返回。
 *
 * 注意这份 shim **不带 `platform`**：`window.electron.platform` 只有 Electron 的 preload
 * 会写，所以凡是靠它判断「是不是桌面端」的代码，在安卓上仍然走非桌面分支。
 */
installAndroidModsBridge();

void import('./bootstrap');
// window.__foliaDev and the ?skipStartup / ?mockSong launch flags (src/dev/devLaunchFlags.ts).
if (import.meta.env.DEV) void import('./dev/devTools');
