// src/components/visualizer/backgrounds/particles/ParticlesBackground.tsx
//
// 封面粒子背景：把封面铺成一格一格的粒子，再让它们被「涟漪」推动。
//
// Mineradio 那边这些数值来自实时频谱（FFT）。Folia 这里现在也接了真实频谱：
// audioBands 由 usePlaybackVisualizerBridge 每帧写入，Web Audio 与原生播放
// 两条路都会喂到同一组 MotionValue（原生那一路由 nativeSpectrumBridge 补齐）。
//
// 没有音频信号时才退回平滑随机游走 —— 那只是「没在放歌时的呼吸感」，
// 不再冒充频谱。

import React, { memo, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { AudioBands, Theme } from '../../../../types';
import { PARTICLE_FRAGMENT, PARTICLE_VERTEX, QUAD_VERTEX } from './particlesShaders';
import { OrbitStage } from '../orbitStage';
import { FORM_CAMERA_SCALE, FORM_INDEX, type ParticlesConcreteForm } from './forms';
import { applyCoverDepthToGeometry, buildParticleGrid } from './geometry';
import { loadCoverTexture, type CoverUniforms } from './coverLoader';

// src/components/visualizer/backgrounds/particles/ParticlesBackground.tsx

interface ParticlesBackgroundProps {
    coverUrl?: string | null;
    theme: Theme;
    /**
     * 形态：同一套粒子几何的四种排布（丝绸 · 滚筒 · 星球 · 唱片）。
     *
     * 已经是**解析之后**的形态：「自动」在 entry.tsx 里按 seed 挑好了。
     */
    form?: ParticlesConcreteForm;    /** 实时频段（0..255）。有它就让粒子跟着音乐动。 */
    audioBands?: AudioBands;
    /** 粒子密度（每边的格数）。越大越细腻，也越吃性能。 */
    grid?: number;
    /** 整体强度 0..1，缩放手势/设置里的滑条用它。 */
    intensity?: number;
    /** 是否让粒子的涟漪自动生成（否则只在必要时） */
    autoRipple?: boolean;
    /** 粒子大小倍数（Mineradio 的 uPointScale）。 */
    pointScale?: number;
    /** 主题色染色强度 0..1（Mineradio 的 uTintStrength 默认 0，我们默认保留 1）。 */
    tintStrength?: number;
    /**
     * 播放器是否暂停。
     *
     * 暂停时整块画面要**完全静止**：没有波纹、没有起伏、没有爆裂。
     * 光看「有没有频谱数据」不够 —— 原生播放暂停后还会把最后一帧的频谱
     * 留在那里（值不是 -1，只是不再变化），于是 hasLive 恒为真，
     * 涟漪照旧按定时器往外出。这就是「暂停还有分散的波纹」。
     */
    paused?: boolean;
    /**
     * 3D 舞台：拖动转视角、双指缩放、双击回到初始视角。
     *
     * 和町景共用同一套轨道相机（backgrounds/orbitStage.ts，底层是 OrbitControls），
     * 所以三者的拖拽手感、阻尼、闲置归位完全一致。
     */
    orbit?: boolean;
}

const MAX_RIPPLES = 8;

const ParticlesBackground: React.FC<ParticlesBackgroundProps> = ({
    coverUrl,
    theme,
    form = 'silk',
    audioBands,
    grid = 96,
    intensity = 1,
    autoRipple = true,
    pointScale = 1,
    tintStrength = 1,
    paused = false,
    orbit,
}) => {
    const hostRef = useRef<HTMLDivElement | null>(null);
    /*
     * 真正上屏的是这张 2D canvas（WebGL 只当离屏源，原因见下面 frame 里的注释）。
     * React 托管它，所以它从一开始就在 DOM 里，不像 three 动态创建的 canvas 那样不上屏。
     */
    const mirrorRef = useRef<HTMLCanvasElement | null>(null);
    const stateRef = useRef({
        ripples: [] as { x: number; y: number; age: number }[],
        nextRippleAt: 0,
    });
    /*
     * ★ paused 走 ref，不进主 effect 的依赖。
     *
     * 放进依赖的代价是每次暂停/继续都整块重建 3D 场景 —— 相机回到初始机位、
     * 涟漪清空、着色器重编。用户看到的就是「一暂停视角马上回正、效果马上消失」，
     * 而他要的是音乐停下来之后画面自己慢慢平静。
     */
    const pausedRef = useRef(paused);
    pausedRef.current = paused;    /*
     * 舞台的基准 FOV 与相机距离（横屏 45/2.2，竖屏 58/2.6）。
     *
     * 自由相机在这上面叠加俯仰/偏航/FOV，所以这两个值要在 resize 里更新、
     * 每帧读出来用，不能直接写死进 camera —— 那样一转屏基准就丢了。
     */
    const baseFovRef = useRef(45);
    const baseDistanceRef = useRef(2.2);

    /*
     * 主题色转成线性空间的一个近似值。
     *
     * 直接拿 hex 当颜色用会偏亮 —— three.js 的材质默认在 sRGB 下工作，
     * 这里手动压一下，让粒子在深色背景上不会糊成一片白。
     */
    const tint = useMemo(() => {
        const hex = theme?.accentColor || theme?.primaryColor || '#8ab4f8';
        const color = new THREE.Color(hex);
        return color;
    }, [theme?.accentColor, theme?.primaryColor]);

    useEffect(() => {
        const host = hostRef.current;
        const mirror = mirrorRef.current;
        if (!host || !mirror) return;
        const mirrorCtx = mirror.getContext('2d');
        if (!mirrorCtx) return;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
        /*
         * 初始站位按形态给：用单位阵的距离，真正的基准在下面的 resize 里按
         * 视口方向和形态一起算（见 FORM_CAMERA_SCALE）。这里只保证第一帧
         * 不会把相机摆在几何体内侧。
         */
        camera.position.set(0, 0, 2.2 * (FORM_CAMERA_SCALE[form] ?? 1));

        const renderer = new THREE.WebGLRenderer({
            /*
             * ★ alpha 必须是 false。这是「粒子背景显示不出来」的最终根因。
             *
             * 同目录能正常显示的背景（SoraBackground）用的是
             *   twgl.getContext(canvas, { alpha: false, ... })
             * 而粒子这边一直开着 alpha: true。设备实测结论：
             *   - 粒子每帧都在正常绘制（drawArrays 之后立刻 readPixels 能读到
             *     11.5 万个不透明像素，toDataURL 也能拿到完整画面）
             *   - 但屏幕上看不到任何东西
             * 原因就是 Android WebView 的合成器不把 alpha 通道的 WebGL 图层
             * 合成上屏 —— 渲染再对也没用。
             *
             * 关掉 alpha 后 canvas 是不透明图层，合成器正常处理。
             * 代价是背景不再是透明的：下面用不透明黑垫底，粒子是加性混合，
             * 黑底不影响观感，也正好和播放页的底色一致。
             */
            alpha: false,
            preserveDrawingBuffer: true,
            antialias: false,
            powerPreference: 'low-power',
        });
        /*
         * ★ clear alpha 用 1 而不是 0。
         *
         * 设备实测：粒子确实每帧都在画（drawArrays 之后立刻 readPixels 能读到
         * 11.5 万个不透明像素，toDataURL 也能拿到完整画面），但屏幕上看不到。
         * Android WebView 的合成器会把「整层 clear alpha = 0 的 WebGL 图层」
         * 当成全透明而直接跳过，于是不管里面画了什么都不会上屏。
         *
         * 铺一层不透明的黑垫底（和播放页的背景色一致），合成器才会正常合成这一层。
         * 粒子是加性混合，黑底不影响它们的观感。
         */
        renderer.setClearColor(0x000000, 1);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        const canvas = renderer.domElement;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        canvas.style.pointerEvents = 'none';
        /*
         * WebGL canvas 不进 DOM：它只当离屏绘图源用（见下面 frame 里的 drawImage）。
         * 留在 DOM 里也不会显示，反而多一层合成。
         */

        /*
         * 粒子网格。
         *
         * aGrid 是 0..1 的平面坐标（决定位置与 UV），
         * aRand 是每个粒子固定的随机数，用来打散抖动方向 ——
         * 没有它的话所有粒子会朝同一个方向抖，看着很假。
         *
         * 位置范围是 -0.5..0.5（不是 -1..1）：
         * 相机在 z=2.2、fov 45 时，画面上能看到的半高只有
         * 2.2 * tan(22.5°) ≈ 0.91 —— 用 ±1 的话四周整整一圈粒子
         * 都在画面外，看上去就是「什么都没有」。
         */
        /*
         * 方阵在「世界空间」里铺多大。
         *
         * 在 resize() 里按当前的 fov / 相机距离 / 宽高比算好，几何按它生成。
         * 不写死常量，是因为可视范围随屏幕方向变：横屏可视半高
         * 2.2*tan22.5°≈0.91，竖屏 2.6*tan29°≈1.44，差了一半多。
         */
        let planeWidth = 1.24;
        let planeHeight = 1.24;
        let points: THREE.Points | null = null;
        /*
         * ★ 网格按宽高比自适应，横纵格数不再相等。
         *
         * 原来固定 grid×grid。可视区是 16:9，横向 96 格塞进 1067px、
         * 纵向 96 格塞进 480px —— 横向格距是纵向的 2.2 倍。
         * 而 gl_PointSize 只有一个值、画出来是正圆，
         * 结果就是「横向稀、纵向密」，整屏看着是一条条竖纹（实测现象）。
         *
         * 改成横纵各自按屏幕比例算格数：纵向固定 grid 格，
         * 横向 = grid × aspect。这样每格在屏幕上是正方形，
         * 粒子就是正圆且疏密一致，铺满整屏后拼成一张连续的封面。
         */
        const colsFor = (aspectRatio: number) => Math.max(8, Math.round(grid * aspectRatio));
        let cols = grid;
        const rows = grid;

        const buildGeometry = (nextCols: number, nextRows: number) => (
            buildParticleGrid(nextCols, nextRows, planeWidth, planeHeight)
        );

        const initial = buildGeometry(cols, rows);
        const positionBuffer = initial.pos;
        const gridBuffer = initial.grid;
        const randBuffer = initial.rand;
        const depthBuffer = initial.depth;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positionBuffer, 3));
        geometry.setAttribute('aGrid', new THREE.BufferAttribute(gridBuffer, 2));
        geometry.setAttribute('aRand', new THREE.BufferAttribute(randBuffer, 1));
        geometry.setAttribute('aDepth', new THREE.BufferAttribute(depthBuffer, 1));

        /**
         * 从封面算景深写进 aDepth（实现与注释见 ./geometry.ts）。
         *
         * 成功才打开 uHasDepth —— 读不到像素时保持平面，
         * 而不是拿一堆 0 去驱动 z 位移。
         */
        const applyCoverDepth = (source: CanvasImageSource | undefined, target: THREE.BufferGeometry) => {
            if (applyCoverDepthToGeometry(source, target)) {
                uniforms.uHasDepth.value = 1;
            }
        };


        const rippleData = Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector3(0, 0, -10));

        const uniforms: {
            [key: string]: THREE.IUniform;
        } & Record<string, THREE.IUniform> = {
            uTime: { value: 0 },
            uPixel: { value: 1 },
            uPointScale: { value: pointScale },
            uBass: { value: 0 },
            uMid: { value: 0 },
            uTreble: { value: 0 },
            uBeat: { value: 0 },
            uEnergy: { value: 0 },
            uBurst: { value: 0 },
            uRipples: { value: rippleData },
            uRippleCount: { value: 0 },
            uTint: { value: tint.clone() },
            uTintStrength: { value: tintStrength },
            uCover: { value: null },
            uHasCover: { value: 0 },
            /** 封面景深算好了没有。为 0 时顶点不做 z 位移，画面是平的。 */
            uHasDepth: { value: 0 },
            // 封面宽高比与屏幕宽高比：着色器按这两个值做「cover 缩放」，别让封面变形。
            uCoverAspect: { value: 1 },
            uScreenAspect: { value: 1 },
            // 调试开关：localStorage 里放 folia_particle_debug=1 就画成不透明纯色。
            uDebug: {
                value: (() => {
                    try {
                        return window.localStorage.getItem('folia_particle_debug') === '1' ? 1 : 0;
                    } catch {
                        return 0;
                    }
                })(),
            },
            uGridSize: { value: grid },
            uViewScale: { value: 1 },
            /*
             * 可视区域在世界空间里的高度。镜头参数一变就要重算，
             * 否则粒子尺寸会按旧视野算，竖屏/横屏切换后大小就不对了。
             */
            uProjSpan: { value: 1 },
            // 一格在世界空间里的边长，供着色器算粒子直径（见 resize 里更新）。
            uCellSpan: { value: 1 },
            // 相机到粒子平面的距离：深度衰减与点尺寸的基准（见 particlesShaders.ts）。
            uCamDist: { value: baseDistanceRef.current },
            /** 形态：0 丝绸 · 1 滚筒 · 2 星球 · 3 虚空 · 4 唱片（与 Mineradio 的 uPreset 编号一致）。 */
            uForm: { value: FORM_INDEX[form] ?? 0 },
            /** 律动强度倍数，对应 Mineradio 的 K = uIntensity * 1.6。 */
            uIntensity: { value: intensity },
        };

        const material = new THREE.ShaderMaterial({
            vertexShader: PARTICLE_VERTEX,
            fragmentShader: PARTICLE_FRAGMENT,
            uniforms,
            transparent: true,
            depthWrite: false,
            depthTest: false,
            blending: THREE.AdditiveBlending,
        });

        points = new THREE.Points(geometry, material);
        scene.add(points);

        /*
         * 封面纹理：每个粒子的颜色都从它上面按网格坐标取。
         *
         * 以前这里写着「只用来取平均亮度，不做逐点采样」，于是
         * uCover 传进去却从没被采样过 —— 整个背景只有主题色的圆点，
         * 看不出是封面。现在片元着色器真的按 vGrid 去取像素了。
         */
        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin('anonymous');
        let texture: THREE.Texture<HTMLImageElement> | null = null;
        /*
         * 解出来的封面图本身。
         *
         * 留着它是因为几何体重建（转屏、分屏）之后景深要重算，
         * 而那时只能从这张图重新取像素 —— 纹理对象不提供像素读取。
         */
        let coverImage: CanvasImageSource | undefined;
        let disposed = false;
        /*
         * 封面失败会退避重试几次（见 coverLoader.ts）：部分平台的封面地址是临时
         * 签名 URL，偶尔 403 / 超时，一次拿不到不该就整场没有封面。
         */
        let cancelCoverLoad: (() => void) | null = null;
        if (coverUrl) {
            // 装载细节在 coverLoader.ts（含 #294 的退避重试与失败日志）；这里只提供场景里的东西。
            cancelCoverLoad = loadCoverTexture({
                url: coverUrl,
                loader,
                uniforms: uniforms as unknown as CoverUniforms,
                isDisposed: () => disposed,
                onTexture: (loaded) => { texture = loaded as unknown as THREE.Texture<HTMLImageElement>; },
                onImage: (image) => { coverImage = image; },
                applyDepth: (image) => applyCoverDepth(image, geometry),
            });
        }

        /*
         * 轨道相机：和町景共用同一套（backgrounds/orbitStage.ts，底层 OrbitControls）。
         * 关着 orbit 时不建 —— 那是「静态背景」的用法，没有拖动。
         */
        let stage: OrbitStage | null = null;
        if (orbit) {
            stage = new OrbitStage(camera, {
                distance: baseDistanceRef.current,
                // 让舞台知道自己是「封面粒子」，好查这个背景单独的陀螺仪开关。
                gyroMode: 'particles',
                onChange: () => {
                    /*
                     * 相机动了，可视世界高度与相机距离都得跟着重算 ——
                     * 着色器靠它们把格间距换算成屏幕像素、按距离算粒子大小与透明度。
                     * 这里不每帧算，只在真正变化时同步一次。
                     */
                    const halfFov = (camera.fov / 2) * (Math.PI / 180);
                    const distance = camera.position.length();
                    uniforms.uProjSpan.value = 2 * distance * Math.tan(halfFov);
                    uniforms.uCamDist.value = distance;
                },
            });
            stage.attach(host);
        }

        const resize = () => {
            const width = host.clientWidth || 1;
            const height = host.clientHeight || 1;
            renderer.setSize(width, height, false);
            camera.aspect = width / height;
            /*
             * 竖屏时把视野拉远一点，否则粒子方阵会被裁掉两边。
             *
             * 这两个值只是**基准**：轨道相机会在它上面叠加用户转的视角与缩放
             * （backgrounds/orbitStage.ts），所以这里写基准、不写死到 camera 上。
             */
            /*
             * 竖屏时把视野拉远一点，否则粒子方阵会被裁掉两边。
             *
             * 这两个值只是**基准**：轨道相机会在它上面叠加用户转的视角与缩放
             * （backgrounds/orbitStage.ts），所以这里写基准、不写死到 camera 上。
             */
            const aspect = width / height;
            baseFovRef.current = aspect < 1 ? 58 : 45;
            /*
             * ★ 基准距离要跟着形态走。
             *
             * 2.2 是给「丝绸」那层平面阵列算的（点几乎都铺在 z≈0）。可另外几种形态
             * 的几何尺度完全不同：
             *   · 滚筒 z 跨 ±4.5、半径 2.0 —— 用 2.2 的距离，隧道直接穿到相机脸上，
             *     看上去就是一片会动的糊，完全没有「往里钻」的纵深感；
             *   · 星球半径 2.2 —— 距离 2.2 等于把相机贴在球面上，只看得到一小块。
             * 所以按形态给不同的倍数，让每种都能被完整框住、并留出透视纵深。
             */
            const formScale = FORM_CAMERA_SCALE[form] ?? 1;
            baseDistanceRef.current = (aspect < 1 ? 2.6 : 2.2) * formScale;
            camera.fov = baseFovRef.current;
            camera.updateProjectionMatrix();
            /*
             * 转屏时把基准距离告诉轨道相机。
             *
             * 它内部按比例换算当前的缩放，所以从竖屏转到横屏不会突然拉近。
             */
            stage?.setDistance(baseDistanceRef.current);
            /*
             * 粒子尺寸按「逻辑像素」算，所以这里只取像素比；
             * 画布的实际高度由 uViewScale 承担（以 900 为基准归一）。
             *
             * 以前 uPixel = (height / 900) * pixelRatio 同时当成两者用，
             * 高分辨率屏上点会小得看不见。
             */
            uniforms.uPixel.value = renderer.getPixelRatio() || 1;
            uniforms.uViewScale.value = height / 900;
            /*
             * 可视世界高度：2 * camZ * tan(fov/2)。
             *
             * 着色器要靠它把「世界空间里的格间距」换算成屏幕像素 ——
             * 漏掉这一步正是粒子只有 1px、整块画布全黑的原因。
             * 竖屏 fov 58 / z 2.6 与横屏 45 / 2.2 差别不小，所以必须每帧参数变化时重算。
             */
            const halfFovRad = (camera.fov / 2) * (Math.PI / 180);
            const visibleHeight = 2 * camera.position.z * Math.tan(halfFovRad);
            const visibleWidth = visibleHeight * camera.aspect;
            uniforms.uProjSpan.value = visibleHeight;
            // 相机距离：深度衰减与点尺寸的基准（见 particlesShaders.ts 的 uCamDist）。
            uniforms.uCamDist.value = camera.position.length();
            /*
             * 屏幕宽高比给着色器：它要和封面宽高比一起算出「cover 缩放」的裁切系数，
             * 不然正方形封面会被铺满屏幕的方阵横向拉成 16:9（就是「封面显示不全」）。
             */
            uniforms.uScreenAspect.value = camera.aspect;
            /*
             * 方阵要铺满可视区：高度取可视高（略放宽 2% 防边缘露空），
             * 宽度跟着 aspect 走。这样横屏竖屏都是满的，
             * 不会出现「中间一个小方块」（写死 1.24 时的实测现象）。
             */
            planeHeight = visibleHeight * 1.02;
            planeWidth = visibleWidth * 1.02;
            /*
             * 一格的边长。
             *
             * 网格现在横纵格数不一样（横向 = grid × aspect），
             * 所以两边的格距天然相等，取哪个都行 —— 用纵向的即可。
             * 着色器按它算粒子直径，粒子就是正圆、疏密一致。
             */
            uniforms.uCellSpan.value = planeHeight / Math.max(1, rows - 1);
            /*
             * 网格要按新的宽高比重建：横纵格数都变了，顶点总数也变了，
             * 只改 position 的数值不够（属性长度对不上）。
             *
             * 重建代价是每个方向变化时才发生一次（转屏、分屏），
             * 不在每帧路径上。
             */
            const nextCols = colsFor(camera.aspect);
            const nextRows = rows;
            if (nextCols !== cols || geometry.getAttribute('position')?.count !== nextCols * nextRows) {
                cols = nextCols;
                const built = buildGeometry(cols, nextRows);
                geometry.setAttribute('position', new THREE.BufferAttribute(built.pos, 3));
                geometry.setAttribute('aGrid', new THREE.BufferAttribute(built.grid, 2));
                geometry.setAttribute('aRand', new THREE.BufferAttribute(built.rand, 1));
                geometry.setAttribute('aDepth', new THREE.BufferAttribute(built.depth, 1));
                geometry.setDrawRange(0, built.total);
                /*
                 * 顶点数变了，景深也得重算 —— 否则转屏 / 分屏之后
                 * 新顶上来的那片粒子全是 depth=0（平的），画面一半有起伏一半没有。
                 */
                if (uniforms.uHasDepth.value > 0.5 && coverImage) {
                    applyCoverDepth(coverImage, geometry);
                }
            } else {
                const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
                if (posAttr) {
                    const arr = posAttr.array as Float32Array;
                    for (let i = 0; i < cols * nextRows; i += 1) {
                        const gx = i % cols;
                        const gy = Math.floor(i / cols);
                        arr[i * 3] = ((cols > 1 ? gx / (cols - 1) : 0) - 0.5) * planeWidth;
                        arr[i * 3 + 1] = ((nextRows > 1 ? gy / (nextRows - 1) : 0) - 0.5) * planeHeight;
                        arr[i * 3 + 2] = 0;
                    }
                    posAttr.needsUpdate = true;
                }
            }
            /*
             * 上屏用那张 2D canvas 的尺寸跟着走。它按 CSS 尺寸 × 像素比开，
             * 这样 drawImage 是一次 1:1 拷贝，不会被浏览器缩放糊掉。
             */
            const dpr = renderer.getPixelRatio() || 1;
            mirror.width = Math.max(1, Math.round(width * dpr));
            mirror.height = Math.max(1, Math.round(height * dpr));
        };
        resize();

        const observer = typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(resize)
            : null;
        observer?.observe(host);
        window.addEventListener('resize', resize);

        let raf = 0;
        let burstValue = 0;
        /** 暂停时冻结的时间轴（秒）。见 frame 里那段注释。 */
        let frozenAt = 0;
        /** 上一帧的时刻，用来算相机插值的 dt。0 表示还没有上一帧。 */
        let lastFrameMs = 0;
        /** 上一次的 bass，用来算「起音」（onset）—— 相邻两帧的差分就是一个鼓点。 */
        let lastBass = 0;
        /** 频段的平滑值：真实频谱每帧都在抖，直接喂给着色器会闪。 */
        const smoothed = { bass: 0, mid: 0, treble: 0, beat: 0, energy: 0 };
        const start = performance.now();

        /*
         * 读一个 0..255 的频段值，归一化到 0..1。
         *
         * audioBands 里是 MotionValue（不是普通数字）—— 它们由
         * usePlaybackVisualizerBridge 每帧 set()，这里同步读 .get()，
         * 所以粒子能跟上每一帧，而不是被 React 渲染节流。
         */
        const readBand = (mv: { get: () => number } | undefined): number => {
            if (!mv) return -1;
            const value = mv.get();
            if (!Number.isFinite(value) || value <= 0) return -1;
            return Math.max(0, Math.min(1, value / 255));
        };

        const frame = () => {
            const nowMs = performance.now();
            /* 这一帧的时长（秒，上限 0.05）：相机阻尼、频谱衰减、爆裂衰减都要用它。 */
            const frameDt = lastFrameMs === 0 ? 0 : Math.min(0.05, (nowMs - lastFrameMs) / 1000);
            lastFrameMs = nowMs;
            /*
             * 时间冻结：暂停时 uTime 不再推进。
             *
             * 着色器里 drift / 呼吸这类动画全靠 uTime 驱动。暂停了却还在给它
             * 递增的时间，画面就一直在缓慢流动 —— 那是「暂停了但背景还在动」
             * 的最后一处来源，也是唯一不来自频谱的一处。
             * frozenAt 记下暂停那一刻的时间，整段暂停期间一直用它。
             */
            if (!pausedRef.current) frozenAt = (nowMs - start) / 1000;
            uniforms.uTime.value = frozenAt;

            /*
             * 轨道相机：每帧推进阻尼与闲置归位。
             *
             * 暂停时也照常推进 —— 转视角是用户的动作，不是动画。
             * 若暂停就冻住相机，暂停状态下就没法看背面，那很怪。
             */
            if (stage) {
                stage.update(frameDt);
            }

            const liveBass = readBand(audioBands?.bass);
            const liveMid = readBand(audioBands?.mid);
            const liveTreble = readBand(audioBands?.treble);
            const liveEnergy = readBand(audioBands?.lowMid);
            /*
             * 有没有真实信号。
             *
             * 两个条件都要：有数据，而且**没有暂停**。
             *
             * 只看数据是不够的：原生播放暂停之后，最后一帧的频谱会一直留在
             * 那里（值不是 -1，只是不再变化），hasLive 于是恒为真 ——
             * 涟漪按定时器继续往外冒，就是用户说的「暂停还有分散的波纹」。
             * 暂停时不管是哪种数据，都当作没有声音。
             */
            const hasLive = !pausedRef.current && liveBass >= 0;

            /*
             * 真实频谱优先。
             *
             * 之前这里完全用平滑随机游走「冒充」频谱（Mineradio 那边读的是 FFT），
             * 观感是有起伏，但跟音乐不同步，用户看到的是一团自己乱动的东西。
             *
             * 现在 Web Audio 与原生播放两条路都把频段喂进 audioBands，
             * 所以先用真值；只有没信号（暂停、没在播、频谱还没起来）时，
             * 才退回随机游走 —— 那是「静止时的呼吸感」，不再冒充频谱。
             */
            if (hasLive) {
                /*
                 * 起音（onset）：低频一上扬就是一个鼓点。
                 *
                 * 直接用 bass 的差分算，比随机值更贴近真实节拍 ——
                 * 下限 0.08 是为了滤掉常态波动，别让每个小抖动都算一击。
                 */
                const rise = Math.max(0, liveBass - lastBass);
                lastBass = liveBass;
                const onset = Math.min(1, rise * 6);
                if (onset > 0.08) burstValue = Math.max(burstValue, onset * 0.85);

                /* 平滑：快升慢降，鼓点要「啪」地亮起来，再慢慢落回去。 */
                const follow = (current: number, target: number) => (
                    target > current ? current + (target - current) * 0.55 : current + (target - current) * 0.12
                );
                smoothed.bass = follow(smoothed.bass, liveBass);
                smoothed.mid = follow(smoothed.mid, liveMid >= 0 ? liveMid : liveBass * 0.6);
                smoothed.treble = follow(smoothed.treble, liveTreble >= 0 ? liveTreble : liveBass * 0.35);
                smoothed.energy = follow(smoothed.energy, liveEnergy >= 0 ? liveEnergy : liveBass * 0.8);
                smoothed.beat = follow(smoothed.beat, onset);

                uniforms.uBass.value = smoothed.bass * intensity;
                uniforms.uMid.value = smoothed.mid * intensity;
                uniforms.uTreble.value = smoothed.treble * intensity;
                uniforms.uBeat.value = Math.pow(smoothed.beat, 1.5) * intensity;
                uniforms.uEnergy.value = smoothed.energy * intensity;
            } else {
                /*
                 * 没有信号：静下来，但要**慢慢地**静下来。
                 *
                 * 早先这里是一组平滑随机游走，让画面没放歌时也「有起伏」——
                 * 用户看到背景在动却没音乐，第一反应是「我没播放怎么还有波纹」。
                 * 但直接归零又走向另一个极端：暂停那一瞬间画面「啪」地塌平，
                 * 像被切断，而不是音乐停下来之后的余韵。
                 *
                 * 所以分两条路：暂停 → 衰减，让已经起来的起伏自己落回平静；
                 * 真的没信号 → 立刻归零（那时画面本就该静止）。
                 */
                const fade = pausedRef.current ? Math.exp(-4.5 * frameDt) : 0;
                lastBass *= fade;
                smoothed.bass *= fade;
                smoothed.mid *= fade;
                smoothed.treble *= fade;
                smoothed.beat *= fade;
                smoothed.energy *= fade;
                uniforms.uBass.value = smoothed.bass * intensity;
                uniforms.uMid.value = smoothed.mid * intensity;
                uniforms.uTreble.value = smoothed.treble * intensity;
                uniforms.uBeat.value = Math.pow(smoothed.beat, 1.5) * intensity;
                uniforms.uEnergy.value = smoothed.energy * intensity;
            }

            /*
             * 爆裂衰减。
             *
             * 暂停时不再硬归零 —— 那样暂停的那一帧画面是「咔嚓」断掉的。
             * 改成衰减得更快一点（0.86/帧 对 0.94/帧），大约半秒收干净：
             * 看起来是最后一个鼓点自己散掉，而不是被人按停。
             */
            burstValue *= pausedRef.current ? 0.86 : 0.94;
            if (burstValue < 1e-4) burstValue = 0;
            uniforms.uBurst.value = burstValue;

            const state = stateRef.current;

            /*
             * 从随机位置打一个涟漪，只在**真的有声音**时。
             *
             * bass 越高越频繁 —— 和「低音鼓点把画面打散」的观感对应。
             *
             * 这里必须要求 hasLive：原先只要是 autoRipple 就按定时器一直发，
             * 于是没有播放的时候画面也不停在冒波纹 —— 用户看到的
             * 「我都没播放怎么还有波纹」就是它。
             * 涟漪应该是声音的结果，不是时间的函数。
             */
            if (autoRipple && hasLive && nowMs >= state.nextRippleAt) {
                const bass = uniforms.uBass.value;
                state.nextRippleAt = nowMs + (1200 - bass * 900) * (0.6 + Math.random() * 0.8);
                state.ripples.push({
                    x: (Math.random() - 0.5) * 1.6,
                    y: (Math.random() - 0.5) * 1.6,
                    age: 0,
                });
                if (state.ripples.length > MAX_RIPPLES) state.ripples.shift();
            }

            // 推进涟漪年龄，老的丢掉
            state.ripples = state.ripples.filter((ripple) => {
                ripple.age += 0.012 + uniforms.uBass.value * 0.01;
                return ripple.age <= 1;
            });

            for (let i = 0; i < MAX_RIPPLES; i += 1) {
                const ripple = state.ripples[i];
                if (ripple) {
                    rippleData[i].set(ripple.x, ripple.y, ripple.age);
                } else {
                    rippleData[i].set(0, 0, -10);
                }
            }
            uniforms.uRippleCount.value = state.ripples.length;

            renderer.render(scene, camera);

            /*
             * ★ 把 WebGL 的结果拷到一张 2D canvas 上再显示。
             *
             * 这是这台设备上唯一能上屏的做法，原因已经用 adb 完全验证过：
             *
             *   - 粒子的渲染从来都是对的：在 drawArrays 之后立刻 readPixels
             *     能读到 11.5 万个不透明像素，toDataURL 拿到的图又亮又满
             *     （avgLum 47 / maxLum 254 / 23% 像素亮度 > 64）。
             *   - 但同一个 canvas 元素放在这个位置（overflow-hidden 里、
             *     多层 absolute 嵌套）就是不上屏。试过 alpha:true/false、
             *     preserveDrawingBuffer、各种 z-index 与层叠上下文，
             *     全部无效。
             *   - 反过来，把同一份内容画到 2D canvas、或者变成 <img>，
             *     立刻就能看见。
             *
             * 所以这里保留 WebGL 做渲染，只把它当成离屏的绘图源，
             * 每帧 drawImage 到一张由 React 托管的 2D canvas 上。
             */
            if (mirrorCtx) {
                mirrorCtx.drawImage(canvas, 0, 0, mirror.width, mirror.height);
            }

            raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);

        return () => {
            disposed = true;
            cancelCoverLoad?.();
            cancelAnimationFrame(raf);
            observer?.disconnect();
            window.removeEventListener('resize', resize);
            // 轨道相机挂在 host 上，要先摘掉再销毁渲染器。
            stage?.detach();
            geometry.dispose();
            material.dispose();
            texture?.dispose();
            renderer.dispose();
            if (canvas.parentNode === host) host.removeChild(canvas);
        };
    /*
     * ★ form 必须在依赖里。
     *
     * uForm 决定顶点着色器走哪个分支（丝/隧道/星球/虚空/唱片），而且不同形态对
     * sampleUv 的映射也不一样 —— 它只在初始化时读一次。早先漏在依赖外面，
     * 于是切了形态之后画面还是上一个形态，要关掉背景再打开才生效。
     */
    }, [coverUrl, grid, intensity, autoRipple, tint, audioBands, orbit, pointScale, tintStrength, form]);

    /*
     * 新歌进来时补一次爆裂：把封面换掉的那一刻让画面「炸」一下，
     * 否则换封面是完全无感的。
     */
    useEffect(() => {
        stateRef.current.ripples = [];
        stateRef.current.nextRippleAt = 0;
    }, [coverUrl]);

    /*
     * 容器绝对定位铺满，**接收**指针；里面上屏的那张 canvas 不接收。
     *
     * ★ 别给 host 加 pointer-events-none。
     *
     * OrbitStage 的拖动监听挂在 host 上，host 一旦 pointer-events-none，
     * 它自己的 pointerdown 就永远不会触发 —— 表现就是「拖动完全没反应」。
     * 该关掉事件的是铺满整个 host 的 canvas，否则它也会抢走 pointerdown。
     *
     * 上屏的是里面那张 2D canvas（mirror），three 的 WebGL canvas 只当离屏源。
     * 这个分工不是随便定的 —— 设备实测：WebGL canvas 放在这个位置就是不上屏
     * （alpha、preserveDrawingBuffer、z-index 全试过），而同一份内容画到
     * 2D canvas 上立刻可见。详见上面 frame 循环里的注释。
     */
    return (
        <div ref={hostRef} className="absolute inset-0 z-0 h-full w-full">
            <canvas ref={mirrorRef} className="pointer-events-none h-full w-full" />
        </div>
    );
};

export default memo(ParticlesBackground);
