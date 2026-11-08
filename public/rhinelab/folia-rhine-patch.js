/*
 * Folia 对 RhineLabUI 的运行时补丁。
 *
 * 为什么是补丁而不是改源码：public/rhinelab 是 RhineLabUI 的**构建产物**。上游
 * LBEILC/RhineLabUI（main 与其它所有分支、全部历史）里都没有本仓这套 `rhine-*`
 * 消息协议和 `#folia` 入口 —— 这份产物是从一个没有公开的分支构建的，重新构建
 * 它需要那份分支。所以这里在 bundle 之前注入一段策略层，只做它**做不到**的事：
 * 帧率闸门、设备像素比上限、活动期判定。视锥剔除和「画面没变就不重画」它自己
 * 已经有（ArchiveVisibility / RenderState），这里不重复实现。
 */
(function foliaRhinePatch() {
    'use strict';

    /*
     * 清掉续播标记。
     *
     * RhineLabUI 在用户点播放时写 sessionStorage['rhine-resume']='1'，之后加载只要
     * 读到它就 `ei("archive")`，**整段开屏连同 array 阶段一起跳过** —— 表现是
     * 「开屏一进来几秒就到底」。
     *
     * 宿主（RhineHome）也会清一次，但那是新装的包才生效；升级前已经写进去的旧标记
     * 会一直留着（sessionStorage 跨页面加载存活）。这里在 bundle 之前再清一次，
     * 保证无论从哪进来的都不受历史状态影响。
     */
    try {
        window.sessionStorage.removeItem('rhine-resume');
    } catch (error) {
        // 私密模式 / 存储被禁用：读不到标记，也就不会跳过开屏。
    }

    var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /*
     * 真实时钟，**在任何劫持之前**取下来。
     *
     * installTimelineRate() 会把 performance.now 换成「开屏期间走得更快」的版本。
     * 补丁自己的帧率闸门与活跃判定必须继续按真实时间走 —— 否则节拍被一起放大，
     * 60 帧的间隔会按错误的步子算，限流直接失效。
     */
    var realNow = performance.now.bind(performance);

    /*
     * 策略。默认值按「安卓手机」定：60 帧上限、静止 12 帧、DPR 压到 1.5。
     * 宿主通过 postMessage({type:'rhine-policy', ...}) 覆盖，见 rhine.htm 的桥。
     */
    var policy = {
        /** 有交互时每秒最多画几帧；0 = 不限。 */
        maxFps: REDUCED ? 30 : 60,
        /** 静止时降到几帧；0 = 不降。 */
        idleFps: REDUCED ? 8 : 12,
        /** 最后一次输入之后多久算「还在动」。 */
        activeMs: 9000,
        /**
         * 页面加载后的宽限期，这段时间一律按 maxFps 画。
         *
         * 开屏（n=0 到 22）、SELECTING FILES、卡片入场（到 28.3）全是时间驱动的，
         * 期间一个手势都没有 —— 只靠 activeMs 覆盖不到，整段开屏会被压到 12 帧。
         * 40 秒足够盖住「开屏 22s + 入场 6s」再留余量；之后才开始省电。
         */
        bootGraceMs: 40000,
        /** devicePixelRatio 上限；0 = 不压。 */
        maxPixelRatio: 1.5,
        /**
         * 开屏动画倍速。1 = 原速，3 = 三倍速。
         *
         * 开屏那 22 秒（扫描线、编号滚动、SELECTING FILES、卡片入场）是纯时间驱动的，
         * bundle 里只有一个时间原点 `Gi`：每帧算的是 `performance.now()/1e3 - Gi`。
         * 所以加速不必碰任何动画代码 —— 只要让时钟随真实时间走得更快，
         * 「动画已经过了多久」就跟着走得快，见 installTimelineRate。
         */
        bootSpeed: 3,
    };
    window.__FOLIA_RHINE__ = policy;

    /* —— 活动期判定 —— */
    var BOOT_AT = performance.now();
    var moving = false;
    var movingTimer = 0;
    function noteActivity() {
        moving = true;
        if (movingTimer) clearTimeout(movingTimer);
        movingTimer = setTimeout(function markIdle() {
            moving = false;
            movingTimer = 0;
        }, policy.activeMs);
    }
    ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'wheel', 'keydown', 'scroll'].forEach(function bind(type) {
        window.addEventListener(type, noteActivity, { passive: true, capture: true });
    });

    /** 开屏期间不节流：那一段没有任何输入，只能按加载后经过的时间判断。 */
    function inBootGrace() {
        // 真实时间：这个「宽限期」量的是真实秒数，不该跟着开屏倍速一起被放大。
        return policy.bootGraceMs > 0 && realNow() - BOOT_AT < policy.bootGraceMs;
    }

    function targetFps() {
        return moving || inBootGrace() ? policy.maxFps : policy.idleFps;
    }

    /*
     * 开屏倍速。
     *
     * bundle 里的时间轴只有一个原点：`Gi`（`Gi = performance.now()/1e3 - 偏移`），
     * 每帧的开屏时间算作 `performance.now()/1e3 - Gi`。`Gi` 是模块内的局部变量，
     * 补丁层拿不到 —— 但它**只经由 `performance.now()` 被读**。
     *
     * 所以这里劫持 `performance.now()`：开屏期间让它比真实时间跑得快。
     * 设倍速 k，则返回 `t0 + (real - t0) * k`。
     *
     * 为什么这样是安全的：
     *   - `Gi` 与每帧的 `e` 都从同一支 `performance.now()` 取值，两边同时被放大，
     *     差值 `e - Gi` 正好按 k 倍增长 —— 动画加速，而「何时解锁」的判定
     *     （`e - Gi >= ic`）语义不变，只是来得更早。
     *   - 开屏结束（`#stage` 的 `data-mode` 不再是 `boot`，由 bundle 自己写）后
     *     立刻恢复真实时间，之后的交互、粒子、配色都不受影响。
     *   - 只影响这个 iframe 内的时序：宿主页面是另一个文档，用的是它自己的
     *     `performance.now()`，不受牵连。
     *
     * 判定用 `data-mode` 而不是「用户有没有点过」：后者会让动画在开屏中途忽然
     * 变回原速，看起来是卡了一下 —— 那不叫加速，叫掉帧。
     */
    function installTimelineRate() {
        var speed = Number(policy.bootSpeed);
        if (!isFinite(speed) || speed <= 0 || speed === 1) return;

        // realNow 是文件头取下的真实时钟；这里绝不能再包一次 performance.now。
        var t0 = realNow();
        var active = true;

        /** 开屏真的结束了就收手。#stage 的 data-mode 由 bundle 自己在切场景时写。 */
        function bootOver() {
            var stage = document.getElementById('stage');
            return Boolean(stage) && stage.dataset.mode !== 'boot';
        }

        performance.now = function patchedNow() {
            var real = realNow();
            if (!active) return real;
            if (bootOver()) {
                active = false;
                return real;
            }
            return t0 + (real - t0) * speed;
        };

        /*
         * 兜底：万一 data-mode 一直停在 boot（比如加载卡住），到点也恢复，
         * 免得这一帧的时钟被永久放大 —— 那会让之后所有计时都不准。
         * 开屏整段约 35 秒，留足余量。
         */
        setTimeout(function () {
            active = false;
        }, (policy.bootGraceMs || 40000) + 5000);
    }

    installTimelineRate();

    /*
     * 帧率闸门。
     *
     * 拦 requestAnimationFrame 而不是 renderer.render：RhineLabUI 的帧循环里除了
     * 绘制还有相机插值与着色器时间推进，整体节流才对应「帧率」这个语义；只跳绘制
     * 会让动画状态和画面不同步。
     *
     * 做法：每次请求都登记「最早可以画的时刻」= 上一次放行 + 间隔。到点了就排一个
     * 原生 rAF，没到点就先 setTimeout 到那个时刻再排 rAF。lastPaint 记的是**放行
     * 时刻**，不是回调时刻 —— 用它推进节拍，帧率才锁得住。
     */
    var nativeRaf = window.requestAnimationFrame.bind(window);
    var nativeCancelRaf = window.cancelAnimationFrame.bind(window);
    var handles = new Map();
    var seq = 0;
    /** 上一次真正放行的时刻（ms）。 */
    var lastPaint = 0;

    function schedule(id, callback, delay) {
        if (delay > 0) {
            var timer = setTimeout(function fire() {
                handles.delete(id);
                var raf = nativeRaf(function run(ms) {
                    handles.delete(id);
                    callback(ms);
                });
                handles.set(id, raf);
            }, delay);
            handles.set(id, timer);
            return;
        }
        var raf = nativeRaf(function run(ms) {
            handles.delete(id);
            callback(ms);
        });
        handles.set(id, raf);
    }

    window.requestAnimationFrame = function foliaRaf(callback) {
        if (typeof callback !== 'function') throw new TypeError('rAF needs a function');
        var id = ++seq;
        var fps = targetFps();
        if (!fps) {
            schedule(id, callback, 0);
            return id;
        }
        var gap = 1000 / fps;
        var now = realNow();
        // 首帧：lastPaint 还是 0，直接放行并定下节拍起点。
        if (!lastPaint) {
            lastPaint = now;
            schedule(id, callback, 0);
            return id;
        }
        // 早于节拍就等到节拍；但等待最多一个间隔，别让迟到的帧把后面全挤住。
        var wait = lastPaint + gap - now;
        if (wait <= 0) {
            lastPaint = Math.max(lastPaint + gap, now);
            schedule(id, callback, 0);
        } else {
            lastPaint = lastPaint + gap;
            schedule(id, callback, wait);
        }
        return id;
    };

    window.cancelAnimationFrame = function foliaCancel(id) {
        var handle = handles.get(id);
        if (handle === undefined) return;
        handles.delete(id);
        // setTimeout 返回 number，原生 raf id 也是 number —— 两个都试一遍，
        // 试错没有副作用（另一个 API 对不属于自己的 id 是空操作）。
        clearTimeout(handle);
        nativeCancelRaf(handle);
    };

    /*
     * devicePixelRatio 上限。
     *
     * 在 WebView 里它是只读的，只能盖 getter。Three 的 setPixelRatio 会再乘自己的
     * 档位，所以这里只压上限，不动它的缩放逻辑。安卓高 DPR 屏按 2.5 倍画是这类
     * 场景掉帧的头号原因。
     */
    try {
        var ratio = window.devicePixelRatio || 1;
        Object.defineProperty(window, 'devicePixelRatio', {
            configurable: true,
            get: function readPixelRatio() {
                return policy.maxPixelRatio > 0 ? Math.min(ratio, policy.maxPixelRatio) : ratio;
            },
        });
    } catch (error) {
        console.warn('[rhine] 无法限制 devicePixelRatio', error);
    }

    /*
     * WebGL 上下文登记表。
     *
     * renderer 实例是模块私有变量，外面拿不到；从上下文反查不到什么有用的东西，
     * 但记下还在活的上下文可以给宿主一个「场景到底有没有在画」的依据（诊断用）。
     */
    var contexts = new Set();
    window.__FOLIA_RHINE_CONTEXTS__ = contexts;
    var nativeGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function foliaGetContext(type) {
        var context = nativeGetContext.apply(this, arguments);
        if (context && (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl')) {
            contexts.add(context);
            this.addEventListener('webglcontextlost', function onLost() {
                contexts.delete(context);
            });
        }
        return context;
    };

    /*
     * `SELECTING FILES...` 阶段的动画。
     *
     * 那一段（n=22 到 25.68，约 3.7 秒）原本只有打字机：一个文本节点被 slice()
     * 一点点补全，打完就静止等着，屏幕上只剩一行白字，跟前后两段（开屏有扫描线、
     * 入场有波浪）比显得空。这里不动它的打字逻辑，只在同一个节点上补一层：
     *
     *   - 正在打字时：给字末加一个光标块（CSS 伪元素做不到「跟住字符数」，用
     *     Attr 监听拿到当前文本长度，喂给 ::after 的 width）。
     *   - 打完之后：字本身开始呼吸，底下一条进度细线走完后一起淡出。
     *
     * 全部走 CSS animation（合成层），不占 JS 帧；节流器压到 12 帧时它照样顺滑。
     */
    function installSelectingAnimations() {
        if (!document.body || document.getElementById('folia-selecting-style')) return;

        var style = document.createElement('style');
        style.id = 'folia-selecting-style';
        style.textContent = [
            '@keyframes folia-caret { 0%,49% { opacity: 1 } 50%,100% { opacity: 0 } }',
            '@keyframes folia-breathe { 0%,100% { opacity: .62 } 50% { opacity: 1 } }',
            '@keyframes folia-sweep { from { transform: scaleX(0) } to { transform: scaleX(1) } }',
            /* 打字光标：挂在 .file-title 的文本节点后面。 */
            '.file-title[data-folia-typing="1"]::after {',
            '  content: ""; display: inline-block; width: .58em; height: 1em;',
            '  margin-left: .12em; vertical-align: -.12em;',
            '  background: currentColor; animation: folia-caret .9s steps(1) infinite;',
            '}',
            /* 打完：字呼吸，底下一道线扫过去。 */
            '.file-title[data-folia-done="1"] { animation: folia-breathe 1.5s ease-in-out infinite; }',
            '.file-title[data-folia-done="1"] .folia-sweep {',
            '  position: absolute; left: 0; right: 0; bottom: -.2em; height: 1px;',
            '  background: currentColor; opacity: .45; transform-origin: left center;',
            '  animation: folia-sweep .9s cubic-bezier(.2,.8,.2,1) 1 both;',
            '}',
            '.file-title { position: relative; }',
        ].join('\n');
        document.head.appendChild(style);

        /* 文本节点被 bundle 直接改 textContent，用 MutationObserver 跟它。 */
        var sweep = document.createElement('i');
        sweep.className = 'folia-sweep';
        var title = null;
        var target = 'SELECTING FILES...';
        var started = 0;

        var apply = function apply() {
            if (!title) return;
            /*
             * 只读**第一个文本子节点**，不能读 title.textContent。
             *
             * .file-title 里除了 "FILE NUMBER: " 这个文本节点，后面还有
             * <span id="selected-id">X-<span id="selected-code">001</span></span>。
             * 读整段 textContent 会得到 "SELECTING FILES...X-001"，永远不等于
             * 目标串，done 永远不成立（这就是第一版没挂上的原因）。
             */
            var node = null;
            for (var i = 0; i < title.childNodes.length; i += 1) {
                if (title.childNodes[i].nodeType === 3) { node = title.childNodes[i]; break; }
            }
            if (!node) return;
            var text = (node.textContent || '').trim();
            var typing = target.indexOf(text) === 0 && text.length > 0 && text.length < target.length;
            var done = text === target;
            title.dataset.foliaTyping = typing ? '1' : '0';
            if (done && title.dataset.foliaDone !== '1') {
                title.dataset.foliaDone = '1';
                // 真实时间：这个时刻只用于调试记录，不该跟着开屏倍速被放大。
                started = realNow();
                if (!title.contains(sweep)) title.appendChild(sweep);
            } else if (!done && title.dataset.foliaDone === '1') {
                delete title.dataset.foliaDone;
                if (sweep.parentNode) sweep.parentNode.removeChild(sweep);
            }
        };

        var bind = function bind() {
            var candidate = document.querySelector('.file-title');
            if (!candidate) return;
            if (candidate === title) return;
            title = candidate;
            new MutationObserver(apply).observe(title, { childList: true, characterData: true, subtree: true });
            bindObserver.disconnect();
            apply();
        };

        // .file-title 在 #archive-ui 里，而 #archive-ui 是 #stage 的兄弟 ——
        // 整棵 body 一起看，别只盯 #stage。
        var bindObserver = new MutationObserver(bind);
        bindObserver.observe(document.body, { childList: true, subtree: true });
        bind();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', installSelectingAnimations, { once: true });
    } else {
        installSelectingAnimations();
    }

    /** 宿主改策略的入口。返回生效后的整份策略。 */
    window.__FOLIA_RHINE_SET__ = function applyPolicy(patch) {
        if (!patch || typeof patch !== 'object') return policy;
        if (typeof patch.maxFps === 'number') policy.maxFps = Math.max(0, patch.maxFps);
        if (typeof patch.idleFps === 'number') policy.idleFps = Math.max(0, patch.idleFps);
        if (typeof patch.activeMs === 'number') policy.activeMs = Math.max(0, patch.activeMs);
        if (typeof patch.bootGraceMs === 'number') policy.bootGraceMs = Math.max(0, patch.bootGraceMs);
        if (typeof patch.maxPixelRatio === 'number') policy.maxPixelRatio = Math.max(0, patch.maxPixelRatio);
        /*
         * 开屏倍速。只记录，不重装：installTimelineRate 在加载时就按当时的倍速装好了，
         * 之后再改这个字段要重载 iframe 才生效。
         */
        if (typeof patch.bootSpeed === 'number' && isFinite(patch.bootSpeed) && patch.bootSpeed > 0) {
            policy.bootSpeed = patch.bootSpeed;
        }
        return policy;
    };
}());
