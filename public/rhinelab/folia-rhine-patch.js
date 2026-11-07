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

    var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
        activeMs: 900,
        /** devicePixelRatio 上限；0 = 不压。 */
        maxPixelRatio: 1.5,
    };
    window.__FOLIA_RHINE__ = policy;

    /* —— 活动期判定 —— */
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

    function targetFps() {
        return moving ? policy.maxFps : policy.idleFps;
    }

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
        var now = performance.now();
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

    /** 宿主改策略的入口。返回生效后的整份策略。 */
    window.__FOLIA_RHINE_SET__ = function applyPolicy(patch) {
        if (!patch || typeof patch !== 'object') return policy;
        if (typeof patch.maxFps === 'number') policy.maxFps = Math.max(0, patch.maxFps);
        if (typeof patch.idleFps === 'number') policy.idleFps = Math.max(0, patch.idleFps);
        if (typeof patch.activeMs === 'number') policy.activeMs = Math.max(0, patch.activeMs);
        if (typeof patch.maxPixelRatio === 'number') policy.maxPixelRatio = Math.max(0, patch.maxPixelRatio);
        return policy;
    };
}());
