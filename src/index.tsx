import { Buffer } from 'buffer';
import { installGlobalVisualizerFrameRateLimiter } from './utils/frameRateLimiter';
import { installConsoleLogCapture } from './utils/consoleLogBuffer';
import { installDebugModule } from './services/debug/debugModule';
import { installMemorySampleFeed } from './services/debug/memorySamples';
import { installNativeAndroidBridge } from './services/nativeAndroidBridge';
import { installPerfDiagnosticsSwitch } from './utils/frameTimingDiagnostics';
import { installAndroidPhoneFitPreference } from './services/androidPhoneLayout';
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
// Cover size audit, left wired but switched off: it answered whether the provider CDNs honour the
// size in a cover URL - they do - and that is not a question worth re-asking every session. The
// collector and its panel are still in the tree, and `?probe=coverSizeAudit` still reaches them.
// To bring the tab back, uncomment this line and the four sites in DevDebugOverlay.tsx. It was dev
// only even then: a packaged build has nothing to do with the answer, so it should not pay the
// observer or the rows it retains.
// if (import.meta.env.DEV) installCoverSizeAudit();
installGlobalVisualizerFrameRateLimiter();
/*
 * 帧耗时 / 长任务采样。用户报「卡顿」时靠它区分「我们的渲染开销」与「设备性能不足」，
 * 在调试面板的 Perf 页看。必须装在帧率限制器之后：它优先用限制器保存的原生 rAF，
 * 否则会把用户自己设的帧率上限当成掉帧。
 *
 * **默认不采样**，由开发者选项里的「性能采样」开关控制（见 usePerfDiagnosticsStore）：
 * 这条 rAF 循环是常驻开销，只有真在查问题的时候才该付。开关可以随时翻，
 * 这里订阅它做启停。
 */
installPerfDiagnosticsSwitch();
// 本地登录的地基：把内置的接口代码挂到页面与原生之间。它是异步的（要 import 那份 JS），
// 但装好之前页面发来的请求会被排队，装好后统一补发，所以不用 await。
void installNativeAndroidBridge();
// 手机适配的属性必须在首帧之前落到 <html> 上：否则用户开了开关后，React 挂载那一瞬
// 会先按桌面布局量一遍尺寸，再被 CSS 拉回手机布局，开屏那一下看得见跳变。
installAndroidPhoneFitPreference();

void import('./bootstrap');
