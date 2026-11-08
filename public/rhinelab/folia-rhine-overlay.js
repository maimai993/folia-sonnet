/*
 * Folia 对 RhineLabUI 的运行时叠层。
 *
 * ## 只做一件事：把三维场景的信息运出去
 *
 * 用户要的是「整张展开的透明卡片变成 Folia 的歌词可视化」。可视化本身跑在宿主那一层
 * （应用自己的 VisualizerRenderer，自带 canvas），**不需要**把画面绕回三维场景。
 *
 * 所以这里不碰渲染，只负责两件宿主拿不到的事：
 *
 *   1. 每帧把卡片四角的投影矩形算出来送给宿主 —— 卡片在三维空间里，位置由相机投影
 *      决定，不跟屏幕尺寸成比例，宿主自己算不出来（写死比例换机型就错位）。
 *   2. 开关打开时把两个圆环藏掉 —— 环如果还画着，会和宿主那层可视化叠成双层图。
 *
 * ## 两个探针怎么来的
 *
 * Three 的 renderer / scene / mesh 全是模块私有变量（没有全局 THREE，
 * `window.__THREE__` 只是个版本号字符串），外部无路可达。tools/patch-rhine-bundle.mjs
 * 在 bundle 的两处锚点后各插一行回调，把 scene 和 rotation 递进来。
 */
(function foliaRhineOverlay() {
    'use strict';

    var log = function log() {
        var args = Array.prototype.slice.call(arguments);
        args[0] = '[rhine-overlay] ' + args[0];
        console.log.apply(console, args);
    };

    /* —— 对外状态 —— */

    var state = {
        /** 宿主开关：叠层是否启用。 */
        enabled: false,
        /** 选中卡片的转动角度（弧度），bundle 里 `this.rotation` 的镜像。 */
        rotation: 0,
        /** 场景与目标 mesh。 */
        mountedScene: null,
        targets: null,
        hidden: false,
        /** 诊断计数。 */
        stats: { renders: 0, meshes: 0, rects: 0 },
    };
    window.__FOLIA_OVERLAY__ = state;

    /** 宿主改状态。 */
    window.__FOLIA_OVERLAY_SET__ = function applyOverlay(patch) {
        if (!patch || typeof patch !== 'object') return state;
        if (typeof patch.enabled === 'boolean') state.enabled = patch.enabled;
        return state;
    };

    /* —— 卡片屏幕范围 —— */

    /*
     * 卡片本体是 `.99 × .46` 的挤出体（见 bundle 里 createAssemblyModel 的
     * `new st(new ls(.99,.46), ...)`）。四个角一投影就是它的屏幕矩形。
     */
    var CARD_HALF_W = 0.99 / 2;
    var CARD_HALF_H = 0.46 / 2;
    var lastRectSent = '';

    /**
     * 把卡片矩形送出去。
     *
     * `renderer` 就是 bundle 里那个 viewer 实例（render 钩子的第二个参数），它带着
     * `projectCard(x, y)` —— 把卡片局部坐标投到容器像素坐标。
     *
     * 只在值真的变了才发：这函数跟着渲染循环跑，每帧都发会把主线程压满。
     */
    function publishCardRect(renderer) {
        if (window.parent === window) return;
        if (!renderer || typeof renderer.projectCard !== 'function') {
            // 钩子进来了但拿不到 projectCard：把原因带给宿主，别让它静默不显示。
            noteFailure(renderer ? 'projectCard 缺失' : 'renderer 未传入');
            return;
        }
        try {
            var tl = renderer.projectCard(-CARD_HALF_W, CARD_HALF_H);
            var br = renderer.projectCard(CARD_HALF_W, -CARD_HALF_H);
            if (!tl || !br) {
                noteFailure('projectCard 返回空');
                return;
            }
            var rect = {
                left: Math.min(tl[0], br[0]),
                top: Math.min(tl[1], br[1]),
                width: Math.abs(br[0] - tl[0]),
                height: Math.abs(br[1] - tl[1]),
            };
            if (!(rect.width > 1) || !(rect.height > 1)) {
                noteFailure('矩形过小 ' + JSON.stringify(rect));
                return;
            }
            // 量化到整像素：亚像素变化肉眼看不出来，但不量化就要一直发消息。
            var key = [rect.left, rect.top, rect.width, rect.height]
                .map(function round(value) { return Math.round(value); })
                .join(',');
            if (key === lastRectSent) return;
            lastRectSent = key;
            state.stats.rects += 1;
            window.parent.postMessage({ type: 'rhine-card-rect', rect: rect }, '*');
        } catch (error) {
            // projectCard 在场景还没建好时会抛；记下来，同一条只报一次。
            noteFailure('projectCard 抛错: ' + (error && error.message ? error.message : error));
        }
    }

    /** 失败原因只发一次，避免每帧刷屏。 */
    var lastFailure = '';
    function noteFailure(message) {
        if (message === lastFailure) return;
        lastFailure = message;
        state.stats.failure = message;
        console.warn('[rhine-overlay] ' + message);
        try {
            window.parent.postMessage({ type: 'rhine-card-rect-failed', reason: message }, '*');
        } catch (error) {
            // 宿主已卸载：忽略。
        }
    }

    /* —— 圆环 —— */

    /** 按 assemblyPart 找两个圆环：镜片组 + 内构。 */
    function collectTargets(scene) {
        var found = [];
        scene.traverse(function visit(object) {
            if (!object.isMesh) return;
            var part = (object.userData && object.userData.assemblyPart)
                || String(object.name || '').split('__')[0];
            if (part === 'optical-lenses' || part === 'optical-core') found.push(object);
        });
        return found;
    }

    /*
     * 藏圆环用 `visible`，不是把 mesh 摘掉。
     *
     * 摘掉会改变场景结构，bundle 自己的动画（入场、聚焦、主题切换）可能依赖这些
     * 对象还在；只关可见性最轻，也能原样恢复。
     */
    function hideRings() {
        state.targets.forEach(function hide(mesh) {
            if (mesh.userData.foliaOriginalVisible === undefined) {
                mesh.userData.foliaOriginalVisible = mesh.visible;
            }
            mesh.visible = false;
        });
        state.hidden = true;
        log('已隐藏两个圆环（%d 个 mesh）', state.targets.length);
    }

    function unhideRings() {
        (state.targets || []).forEach(function unhide(mesh) {
            if (mesh.userData.foliaOriginalVisible !== undefined) {
                mesh.visible = mesh.userData.foliaOriginalVisible;
                delete mesh.userData.foliaOriginalVisible;
            }
        });
        state.hidden = false;
        state.mountedScene = null;
        state.targets = null;
        log('圆环已恢复');
    }

    /* —— 钩子 —— */

    /** bundle 每次绘制回调进来：scene 是第一个参数，this 是 renderer。 */
    function onRender(scene, renderer) {
        state.stats.renders += 1;
        publishCardRect(renderer);

        if (!state.enabled) {
            if (state.hidden) unhideRings();
            return;
        }

        if (state.mountedScene !== scene) {
            state.mountedScene = scene;
            state.targets = collectTargets(scene);
            state.stats.meshes = state.targets.length;
            log('找到 %d 个圆环 mesh', state.targets.length);
        }

        if (state.targets && state.targets.length && !state.hidden) hideRings();
    }

    window.__FOLIA_OVERLAY_ON_RENDER__ = onRender;

    /**
     * 转动角度镜像。
     *
     * 只在值真的变了才往宿主发：这行在 60 帧的循环里跑，每帧都 postMessage 一次
     * 会把主线程压满。量化到千分之一弧度，肉眼看不出来，静止时一条消息都不发。
     */
    var lastRotationSent = null;
    window.__FOLIA_OVERLAY_ON_ROTATION__ = function onRotation(rotation) {
        state.rotation = rotation;
        if (window.parent === window) return;
        var quantized = Math.round(rotation * 1000);
        if (quantized === lastRotationSent) return;
        lastRotationSent = quantized;
        try {
            window.parent.postMessage({ type: 'rhine-rotation', rotation }, '*');
        } catch (error) {
            // 跨域 / 宿主已卸载：忽略。
        }
    };

    log('已安装（等待 render 回调）');
}());
