import React from 'react';
import * as THREE from 'three';
import type { AudioBands, Theme } from '../../../../types';
import { OrbitStage } from '../orbitStage';
import {
    SONIC_FLOATING_FRAGMENT,
    SONIC_FLOATING_VERTEX,
    SONIC_RIPPLE_MAX,
    SONIC_TERRAIN_FRAGMENT,
    SONIC_TERRAIN_VERTEX,
} from './sonicShaders';
import {
    deriveLayout,
    deriveTerrainSettings,
    deriveTheme,
    SONIC_DEFAULT_AMPLITUDE,
    SONIC_DEFAULT_DENSITY,
    SONIC_DEFAULT_DEPTH,
    SONIC_DEFAULT_GLOW,
    SONIC_DEFAULT_LOWER,
    SONIC_DEFAULT_RANGE,
    SONIC_DEFAULT_SHARPNESS,
    SONIC_DEFAULT_SMOOTHNESS,
} from './sonicTheme';

// src/components/visualizer/backgrounds/sonic/SonicBackground.tsx
//
// 音域回响（Sonic Topography）：一片由数万根发光柱子组成的地形，
// 8 个频段分别推动不同的起伏形态，低频起时中心的柱子整片抬起来。
//
// 移植自 Mineradio 的 sonic-topography-preset.js。只搬地形本体与漂浮方块，
// 不搬流星 / 拖尾（那两样是随机装饰，和音乐关系很弱，只多两倍 draw call）。
//
// 渲染方式和其它 3D 背景一致：WebGL canvas 只当离屏源，每帧 drawImage 到 2D canvas。
// 相机和町景 / 粒子 / 星河 / 安魂共用同一套轨道相机（backgrounds/orbitStage.ts）。

/** 同时最多几个涟漪。 */
const MAX_RIPPLES = SONIC_RIPPLE_MAX;
/** 一个涟漪活多久（秒）。 */
const RIPPLE_LIFETIME = 4.8;
/** 超过这个年龄开始淡出。 */
const RIPPLE_SOFT_FADE_START = 2.1;

/*
 * 频段平滑的时间常数（每秒趋近速率，越大越快）。
 *
 * 起得快、落得慢 —— 这是表头 / 压缩器的经典做法：鼓点打下来时立刻抬起来，
 * 打完之后慢慢退回去。两个都用同一个速率会显得「抽」：升的瞬间太快、
 * 落的时候又太生硬。
 *
 * 3.5 意味着时间常数约 0.29 秒：肉眼看到的是连续的起伏，而不是每帧重排。
 */
const BAND_RISE_RATE = 3.5;
const BAND_FALL_RATE = 2.2;

export interface SonicBackgroundProps {
    theme: Theme;
    audioBands?: AudioBands;
    /** 暂停时冻结时间轴。 */
    paused?: boolean;
    /** 地形密度 0..100。 */
    density?: number;
    /** 起伏幅度 0..100。50 是标定值。 */
    amplitude?: number;
    /** 地面范围 0..100。 */
    range?: number;
    /** 垂直位置 0..100。 */
    lower?: number;
    /** 景深 0..100。 */
    depth?: number;
    /** 亮度 0..100。 */
    glow?: number;
    /** 平滑度 0..100：静息形态更偏噪声还是更偏波纹。 */
    smoothness?: number;
    /** 锐利度 0..100：柱子侧面阴影的陡峭程度。 */
    sharpness?: number;
    /** 性能挡位，决定格数上限。 */
    quality?: string;
    /** 轨道相机。 */
    orbit?: boolean;
}

const SonicBackground: React.FC<SonicBackgroundProps> = ({
    theme,
    audioBands,
    paused = false,
    density = SONIC_DEFAULT_DENSITY,
    amplitude = SONIC_DEFAULT_AMPLITUDE,
    range = SONIC_DEFAULT_RANGE,
    lower = SONIC_DEFAULT_LOWER,
    depth = SONIC_DEFAULT_DEPTH,
    glow = SONIC_DEFAULT_GLOW,
    smoothness = SONIC_DEFAULT_SMOOTHNESS,
    sharpness = SONIC_DEFAULT_SHARPNESS,
    quality,
    orbit = true,
}) => {
    const hostRef = React.useRef<HTMLDivElement | null>(null);
    const mirrorRef = React.useRef<HTMLCanvasElement | null>(null);

    /*
     * 主题里只有这三个颜色要进着色器，且随时会变。
     * 单独提出来当依赖，避免整个 theme 对象换引用就重建整片地形
     * （重建 = 重新生成两万多个实例矩阵，会卡一下）。
     */
    const primaryColor = theme.primaryColor;
    const secondaryColor = theme.secondaryColor;
    const accentColor = theme.accentColor;

    React.useEffect(() => {
        const host = hostRef.current;
        const mirror = mirrorRef.current;
        if (!host || !mirror) return undefined;
        const mirrorCtx = mirror.getContext('2d');
        if (!mirrorCtx) return undefined;

        const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
        renderer.setClearColor(0x000000, 0);
        renderer.setPixelRatio(1);
        const canvas = renderer.domElement;
        canvas.width = 1;
        canvas.height = 1;

        const scene = new THREE.Scene();

        /*
         * 相机：贴地往前看的「俯冲」视角。
         *
         * ★ 别把机位抬高，也别拉远 —— 这个距离是调好的，用户认可了当前构图。
         *
         * Mineradio 那边地形是铺在地面上的（root 的 y 是负的，见 deriveLayout），
         * 相机几乎贴着地面、稍微俯一点往前看 —— 所以柱子从近到远层层叠起来，
         * 像一片起伏的原野。
         *
         * 早先写成 y=14 / z=26 的高空俯视 + target 抬到 -6，等于把相机架在
         * 地形上方往下看，柱子被压成一片扁平的「墙」，完全不是那个感觉。
         *
         * 现在：相机在 y≈2.2、z≈13 偏后，target 落在 y≈-5.2 的地形中段，
         * 俯角只有十几度 —— 这就是原版那个「趴在地平线上看地形」的机位。
         */
        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
        const terrainTarget = new THREE.Vector3(0, -5.2, -7);
        camera.position.set(0, 2.2, 13);
        camera.lookAt(terrainTarget);

        const sonicTheme = deriveTheme(primaryColor, secondaryColor, accentColor);

        /* ---------- 地形 ---------- */
        const settings = deriveTerrainSettings(density, quality);

        const terrainUniforms = {
            uTime: { value: 0 },
            uSubBass: { value: 0 },
            uBass: { value: 0 },
            uLowMid: { value: 0 },
            uMid: { value: 0 },
            uHighMid: { value: 0 },
            uPresence: { value: 0 },
            uBrilliance: { value: 0 },
            uAir: { value: 0 },
            uWarmth: { value: 0 },
            uBrightness: { value: 0 },
            uSharpness: { value: sharpness / 100 },
            uSmoothness: { value: smoothness / 100 },
            uDensity: { value: density / 100 },
            uEnergy: { value: 0 },
            uAmplitude: { value: 1 },
            uRipples: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, -100, 0)) },
            uBaseColor1: { value: sonicTheme.base1 },
            uBaseColor2: { value: sonicTheme.base2 },
            uFogColor: { value: sonicTheme.fog },
            uCoolCore: { value: sonicTheme.coolCore },
            uCoolEdge: { value: sonicTheme.coolEdge },
            uWarmCore: { value: sonicTheme.warmCore },
            uWarmEdge: { value: sonicTheme.warmEdge },
            uRippleColor: { value: sonicTheme.ripple },
            uGlowIntensity: { value: glow / 68 },
        };

        const terrainGeometry = new THREE.BoxGeometry(settings.boxWidth, 1, settings.boxWidth);
        const terrainMaterial = new THREE.ShaderMaterial({
            uniforms: terrainUniforms,
            vertexShader: SONIC_TERRAIN_VERTEX,
            fragmentShader: SONIC_TERRAIN_FRAGMENT,
            transparent: true,
            depthWrite: true,
            depthTest: true,
        });
        const terrain = new THREE.InstancedMesh(terrainGeometry, terrainMaterial, settings.instanceCount);
        terrain.frustumCulled = false;

        const matrix = new THREE.Matrix4();
        const offset = (settings.gridSize * settings.spacing) / 2;
        let index = 0;
        for (let x = 0; x < settings.gridSize; x += 1) {
            for (let z = 0; z < settings.gridSize; z += 1) {
                matrix.makeTranslation(x * settings.spacing - offset, 0.5, z * settings.spacing - offset);
                terrain.setMatrixAt(index, matrix);
                index += 1;
            }
        }
        terrain.instanceMatrix.needsUpdate = true;

        /* ---------- 漂浮方块 ---------- */
        const floatingUniforms = {
            ...terrainUniforms,
            uPulse: { value: 0 },
        };
        const FLOATING_COUNT = 80;
        const floatingGeometry = new THREE.BoxGeometry(1, 1, 1);
        const floatingMaterial = new THREE.ShaderMaterial({
            uniforms: floatingUniforms,
            vertexShader: SONIC_FLOATING_VERTEX,
            fragmentShader: SONIC_FLOATING_FRAGMENT,
            transparent: true,
            depthWrite: false,
            depthTest: true,
        });
        const floating = new THREE.InstancedMesh(floatingGeometry, floatingMaterial, FLOATING_COUNT);
        floating.frustumCulled = false;

        /* 每个方块的轨道参数（原版同一套确定性公式）。 */
        const floatingData = Array.from({ length: FLOATING_COUNT }, (_, i) => {
            const ring = i / FLOATING_COUNT;
            const angle = ring * Math.PI * 2 * 5 + Math.sin(i * 12.9898) * 0.7;
            const radius = 14 + ((i * 37) % 62);
            const height = 6 + ((i * 17) % 19);
            return {
                x: Math.cos(angle) * radius,
                z: Math.sin(angle) * radius,
                y: height,
                baseScale: 0.75 + ((i * 11) % 9) * 0.05,
                phase: i * 0.73,
                rotationSpeed: 0.18 + ((i * 7) % 10) * 0.035,
            };
        });

        const root = new THREE.Group();
        root.add(terrain);
        root.add(floating);
        scene.add(root);

        /* ---------- 布局 ---------- */
        const layout = deriveLayout(range, lower, depth);
        root.scale.setScalar(layout.scale);
        root.position.set(0, layout.y, layout.z);

        /* ---------- 涟漪状态 ---------- */
        const ripples = Array.from({ length: MAX_RIPPLES }, () => ({
            x: 0, z: 0, start: -100, strength: 0, white: false,
        }));
        let rippleCursor = 0;
        const addRipple = (x: number, z: number, strength: number, white = false) => {
            const ripple = ripples[rippleCursor];
            rippleCursor = (rippleCursor + 1) % MAX_RIPPLES;
            ripple.x = x;
            ripple.z = z;
            ripple.start = sonicTime;
            ripple.strength = strength;
            ripple.white = white;
        };

        /* ---------- 视口 ---------- */
        let width = 1;
        let height = 1;

        let stage: OrbitStage | null = null;
        if (orbit) {
            stage = new OrbitStage(camera, {
                // 让舞台知道自己是「音域回响」，好查这个背景单独的陀螺仪开关。
                gyroMode: 'sonic',
                /*
                 * 距离要和上面那个机位对得上：相机 (0,2.2,13) 到 target (0,-5.2,-7)
                 * 的实际距离约 21.9。写成 30 会让 OrbitStage 以为基准更远，
                 * 一拖动镜头就整体后退，画面突然缩小。
                 */
                distance: camera.position.distanceTo(terrainTarget),
                target: terrainTarget,
            });
            stage.attach(host);
        }

        const resize = () => {
            const rect = host.getBoundingClientRect();
            width = Math.max(1, Math.round(rect.width));
            height = Math.max(1, Math.round(rect.height));
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            renderer.setSize(width, height, false);
            mirror.width = Math.max(1, Math.round(width * dpr));
            mirror.height = Math.max(1, Math.round(height * dpr));
            camera.aspect = width / height;
            camera.fov = height > width ? 58 : 45;
            camera.updateProjectionMatrix();
        };

        const resizeObserver = typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(() => resize())
            : null;
        resizeObserver?.observe(host);
        window.addEventListener('resize', resize);
        resize();

        /* ---------- 动画 ---------- */
        let sonicTime = 0;
        let lastTime = 0;
        let raf = 0;
        let disposed = false;
        let lastBass = 0;
        let ampPulse = 0;
        /*
         * 频段的平滑状态。
         *
         * ★ 必须平滑，否则地形会「一帧一个样」。
         *
         * 原生频谱每帧给的是瞬时读数，相邻两帧的差值可以很大（鼓点、齿音、
         * 频谱分析的窗长都让它跳）。早先这里是把读数直接写进 uniform 的：
         *   uBass.value = b
         * 于是每一帧地形的高度分布都在重算，眼睛看到的就是「一直在重排、
         * 突然一下就变」，完全没有随音乐起伏的过渡感。
         *
         * 现在每个频段都过一层指数平滑（上下用不同时间常数：起得快、落得慢，
         * 这是压缩器/表头的经典做法，听感上才「跟得上」而不「抽」）。
         */
        const bandState = {
            subBass: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0,
            presence: 0, brilliance: 0, air: 0, warmth: 0, brightness: 0, energy: 0,
        };
        /** 平滑一步：rise 追上快、fall 退得慢。 */
        const smoothBand = (current: number, target: number, dt: number) => {
            const rate = target > current ? BAND_RISE_RATE : BAND_FALL_RATE;
            return current + (target - current) * (1 - Math.exp(-rate * dt));
        };
        const dummy = new THREE.Object3D();

        const syncRipples = () => {
            const arr = terrainUniforms.uRipples.value as THREE.Vector4[];
            for (let i = 0; i < MAX_RIPPLES; i += 1) {
                const ripple = ripples[i];
                const age = sonicTime - ripple.start;
                const active = ripple.strength > 0.001 && age >= 0 && age < RIPPLE_LIFETIME;
                if (!active) {
                    arr[i].set(0, 0, -100, 0);
                    continue;
                }
                const fadeT = (age - RIPPLE_SOFT_FADE_START) / (RIPPLE_LIFETIME - RIPPLE_SOFT_FADE_START);
                const fade = 1 - Math.min(1, Math.max(0, fadeT));
                const strength = ripple.strength * fade;
                arr[i].set(ripple.x, ripple.z, ripple.start, ripple.white ? -strength : strength);
            }
        };

        /** 幅度滑条 → 实际倍数。50 是标定值，往上按平方放大（原版同一公式）。 */
        const amplitudeMultiplier = amplitude <= 50
            ? amplitude / 50
            : 1 + ((amplitude - 50) / 50) ** 2 * 14;

        const frame = (timestamp: number) => {
            raf = window.requestAnimationFrame(frame);
            if (disposed) return;

            const dt = lastTime === 0 ? 0 : Math.min(0.05, (timestamp - lastTime) / 1000);
            lastTime = timestamp;
            if (!paused) sonicTime += dt;
            if (stage) stage.update(dt);

            const bass = audioBands?.bass.get() ?? -1;
            const mid = audioBands?.mid.get() ?? -1;
            const treble = audioBands?.treble.get() ?? -1;
            const hasLive = !paused && Number.isFinite(bass) && bass >= 0;

            /*
             * 频段映射。
             *
             * 我们只有 bass/mid/treble 三段（原生频谱桥给的就是这三个），
             * 原版有 8 段。这里用相邻频段的差值近似拆出来：
             *   subBass  ≈ bass 的更慢、更低的成分（用 bass 本身压一档）
             *   bass     = bass
             *   lowMid   = bass 与 mid 之间
             *   mid      = mid
             *   highMid  = mid 与 treble 之间
             *   presence / brilliance / air = treble 的递增段
             * 这样 8 个格子都有东西驱动，地形不会有一半是死的。
             */
            if (hasLive) {
                const b = Math.max(0, Math.min(1, bass / 255));
                const m = Math.max(0, Math.min(1, mid / 255));
                const t = Math.max(0, Math.min(1, treble / 255));

                /*
                 * 先算出这一帧 8 个频段的目标值，再统一过平滑。
                 * 顺序很重要：要拿**平滑后**的 bass 去判涟漪，否则涟漪
                 * 也会跟着瞬时读数乱触发。
                 */
                bandState.subBass = smoothBand(bandState.subBass, b * 0.85, dt);
                bandState.bass = smoothBand(bandState.bass, b, dt);
                bandState.lowMid = smoothBand(bandState.lowMid, b * 0.5 + m * 0.5, dt);
                bandState.mid = smoothBand(bandState.mid, m, dt);
                bandState.highMid = smoothBand(bandState.highMid, m * 0.5 + t * 0.5, dt);
                bandState.presence = smoothBand(bandState.presence, t * 0.85, dt);
                bandState.brilliance = smoothBand(bandState.brilliance, t * 0.7, dt);
                bandState.air = smoothBand(bandState.air, t * 0.55, dt);
                bandState.warmth = smoothBand(bandState.warmth, b * 0.6, dt);
                bandState.brightness = smoothBand(bandState.brightness, t, dt);
                bandState.energy = smoothBand(bandState.energy, b * 0.5 + m * 0.3 + t * 0.2, dt);

                terrainUniforms.uSubBass.value = bandState.subBass;
                terrainUniforms.uBass.value = bandState.bass;
                terrainUniforms.uLowMid.value = bandState.lowMid;
                terrainUniforms.uMid.value = bandState.mid;
                terrainUniforms.uHighMid.value = bandState.highMid;
                terrainUniforms.uPresence.value = bandState.presence;
                terrainUniforms.uBrilliance.value = bandState.brilliance;
                terrainUniforms.uAir.value = bandState.air;
                terrainUniforms.uWarmth.value = bandState.warmth;
                terrainUniforms.uBrightness.value = bandState.brightness;
                terrainUniforms.uEnergy.value = bandState.energy;

                /* 低频上升沿打一个涟漪，位置随机落在地形里（用平滑后的值判）。 */
                const rise = Math.max(0, bandState.bass - lastBass);
                lastBass = bandState.bass;
                if (rise > 0.05) {
                    const spread = settings.gridSize * settings.spacing * 0.4;
                    addRipple(
                        (Math.random() - 0.5) * spread,
                        (Math.random() - 0.5) * spread,
                        Math.min(1, rise * 3.4),
                        rise > 0.16,
                    );
                }

                ampPulse += (bandState.bass * 0.12 - ampPulse) * (1 - Math.exp(-6 * dt));
            } else {
                /*
                 * 没有实时频谱（暂停 / 没在播）：让平滑状态也慢慢退到零。
                 * 直接写 0 会让恢复播放的瞬间有一个「从地面弹起来」的突变。
                 */
                const decay = 1 - Math.exp(-BAND_FALL_RATE * dt);
                bandState.subBass += (0 - bandState.subBass) * decay;
                bandState.bass += (0 - bandState.bass) * decay;
                bandState.lowMid += (0 - bandState.lowMid) * decay;
                bandState.mid += (0 - bandState.mid) * decay;
                bandState.highMid += (0 - bandState.highMid) * decay;
                bandState.presence += (0 - bandState.presence) * decay;
                bandState.brilliance += (0 - bandState.brilliance) * decay;
                bandState.air += (0 - bandState.air) * decay;
                bandState.warmth += (0 - bandState.warmth) * decay;
                bandState.brightness += (0 - bandState.brightness) * decay;
                bandState.energy += (0 - bandState.energy) * decay;

                terrainUniforms.uSubBass.value = bandState.subBass;
                terrainUniforms.uBass.value = bandState.bass;
                terrainUniforms.uLowMid.value = bandState.lowMid;
                terrainUniforms.uMid.value = bandState.mid;
                terrainUniforms.uHighMid.value = bandState.highMid;
                terrainUniforms.uPresence.value = bandState.presence;
                terrainUniforms.uBrilliance.value = bandState.brilliance;
                terrainUniforms.uAir.value = bandState.air;
                terrainUniforms.uWarmth.value = bandState.warmth;
                terrainUniforms.uBrightness.value = bandState.brightness;
                terrainUniforms.uEnergy.value = bandState.energy;
                lastBass = bandState.bass;
                ampPulse += (0 - ampPulse) * (1 - Math.exp(-6 * dt));
            }

            terrainUniforms.uTime.value = sonicTime;
            /*
             * 强度：把幅度滑条的倍数和低频脉冲合起来。
             *
             * 下限给 0.18 —— 暂停时地形要保留静息起伏，整片压平就成一块平板了。
             */
            terrainUniforms.uAmplitude.value = Math.max(0.18, amplitudeMultiplier * (1 + ampPulse));
            terrainUniforms.uSharpness.value = sharpness / 100;
            terrainUniforms.uSmoothness.value = smoothness / 100;
            floatingUniforms.uTime.value = sonicTime;
            floatingUniforms.uPulse.value = hasLive ? Math.max(0, Math.min(1, ampPulse * 3)) : 0;

            syncRipples();

            /* 漂浮方块：缓慢升降 + 自转。暂停时也保持静止姿态。 */
            for (let i = 0; i < FLOATING_COUNT; i += 1) {
                const data = floatingData[i];
                const bob = paused ? 0 : Math.sin(sonicTime * 0.5 + data.phase) * 1.6;
                dummy.position.set(data.x, data.y + bob, data.z);
                dummy.rotation.set(
                    paused ? 0 : sonicTime * data.rotationSpeed * 0.5 + data.phase,
                    paused ? 0 : sonicTime * data.rotationSpeed,
                    0,
                );
                dummy.scale.setScalar(data.baseScale * (1 + ampPulse));
                dummy.updateMatrix();
                floating.setMatrixAt(i, dummy.matrix);
            }
            floating.instanceMatrix.needsUpdate = true;

            renderer.render(scene, camera);
            mirrorCtx.clearRect(0, 0, mirror.width, mirror.height);
            mirrorCtx.drawImage(canvas, 0, 0, mirror.width, mirror.height);
        };
        raf = window.requestAnimationFrame(frame);

        return () => {
            disposed = true;
            cancelAnimationFrame(raf);
            resizeObserver?.disconnect();
            window.removeEventListener('resize', resize);
            stage?.detach();
            terrainGeometry.dispose();
            terrainMaterial.dispose();
            floatingGeometry.dispose();
            floatingMaterial.dispose();
            renderer.dispose();
        };
    }, [
        audioBands, paused, density, amplitude, range, lower, depth,
        glow, smoothness, sharpness, quality, orbit,
        primaryColor, secondaryColor, accentColor,
    ]);

    /*
     * ★ 上屏的镜像 canvas 必须同时 pointer-events-none。
     *
     * OrbitStage 的拖动监听挂在 host 这个 div 上，而 canvas 铺满了 host 的整个
     * 面积 —— canvas 自己不设 pointer-events-none 就会把 pointerdown 全吃掉，
     * host 永远收不到事件，拖动于是「完全没反应」。
     */
    return (
        <div ref={hostRef} className="absolute inset-0 z-0 h-full w-full">
            <canvas ref={mirrorRef} className="pointer-events-none h-full w-full" />
        </div>
    );
};

export default React.memo(SonicBackground);
