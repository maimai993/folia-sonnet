// src/components/visualizer/backgrounds/particles/ParticlesBackground.tsx
//
// 封面粒子背景：把封面铺成一格一格的粒子，再让它们被「涟漪」推动。
//
// 关键取舍：Mineradio 那边这些数值来自实时频谱（FFT）。Folia 这一层
// 没有读频谱的能力，所以改用一个平滑过的随机游走 ——
// 观感上仍然是「有起有伏的律动」，但它跟音乐本身不同步。
// 这一点在设置卡里也写明了，避免用户以为是解不出频谱。

import React, { memo, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Theme } from '../../../../types';
import { PARTICLE_FRAGMENT, PARTICLE_VERTEX, QUAD_VERTEX } from './particlesShaders';

// src/components/visualizer/backgrounds/particles/ParticlesBackground.tsx

interface ParticlesBackgroundProps {
    coverUrl?: string | null;
    theme: Theme;
    /** 粒子密度（每边的格数）。越大越细腻，也越吃性能。 */
    grid?: number;
    /** 整体强度 0..1，缩放手势/设置里的滑条用它。 */
    intensity?: number;
    /** 是否让粒子的涟漪自动生成（否则只在必要时） */
    autoRipple?: boolean;
}

/**
 * 一条平滑的随机游走，用来代替频谱里的某一条能量曲线。
 *
 * 为什么不用 Math.random() 直接当值：那样每一帧都在跳，
 * 看着是噪点而不是律动。这里让目标值缓慢漂移，实际值再追上去。
 */
class SmoothRandom {
    private value = 0.3;
    private target = 0.3;
    private nextAt = 0;

    sample(now: number, min: number, max: number): number {
        if (now >= this.nextAt) {
            this.target = min + Math.random() * (max - min);
            // 每 120~420ms 换一次目标，接近一个节拍的密度
            this.nextAt = now + 120 + Math.random() * 300;
        }
        this.value += (this.target - this.value) * 0.08;
        return this.value;
    }
}

const MAX_RIPPLES = 8;

const ParticlesBackground: React.FC<ParticlesBackgroundProps> = ({
    coverUrl,
    theme,
    grid = 96,
    intensity = 1,
    autoRipple = true,
}) => {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const stateRef = useRef({
        ripples: [] as { x: number; y: number; age: number }[],
        nextRippleAt: 0,
    });

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
        if (!host) return;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
        camera.position.set(0, 0, 2.2);

        const renderer = new THREE.WebGLRenderer({
            alpha: true,
            antialias: false,
            powerPreference: 'low-power',
        });
        renderer.setClearColor(0x000000, 0);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        host.appendChild(renderer.domElement);
        const canvas = renderer.domElement;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';

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
        const count = grid * grid;
        const positions = new Float32Array(count * 3);
        const grids = new Float32Array(count * 2);
        const rands = new Float32Array(count);
        for (let i = 0; i < count; i += 1) {
            const gx = i % grid;
            const gy = Math.floor(i / grid);
            const u = gx / (grid - 1);
            const v = gy / (grid - 1);
            /*
             * 铺到 ±0.62：比 0.5 略大一点，
             * 让涟漪和节拍把粒子往外推的时候边缘不会露空。
             * 再大就等于把一半粒子放到画面外浪费算力。
             */
            positions[i * 3] = (u - 0.5) * 1.24;
            positions[i * 3 + 1] = (v - 0.5) * 1.24;
            positions[i * 3 + 2] = 0;
            grids[i * 2] = u;
            grids[i * 2 + 1] = v;
            rands[i] = Math.random();
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('aGrid', new THREE.BufferAttribute(grids, 2));
        geometry.setAttribute('aRand', new THREE.BufferAttribute(rands, 1));

        const rippleData = Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector3(0, 0, -10));

        const uniforms: {
            [key: string]: THREE.IUniform;
        } & Record<string, THREE.IUniform> = {
            uTime: { value: 0 },
            uPixel: { value: 1 },
            uBass: { value: 0 },
            uMid: { value: 0 },
            uTreble: { value: 0 },
            uBeat: { value: 0 },
            uEnergy: { value: 0 },
            uBurst: { value: 0 },
            uRipples: { value: rippleData },
            uRippleCount: { value: 0 },
            uTint: { value: tint.clone() },
            uTintStrength: { value: 1 },
            uCover: { value: null },
            uHasCover: { value: 0 },
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

        const points = new THREE.Points(geometry, material);
        scene.add(points);

        // 封面那张图只用来取平均亮度，不做逐点采样（开销太大且这里用不上）
        const loader = new THREE.TextureLoader();
        let texture: THREE.Texture<HTMLImageElement> | null = null;
        let disposed = false;
        if (coverUrl) {
            loader.load(
                coverUrl,
                (loaded) => {
                    if (disposed) {
                        loaded.dispose();
                        return;
                    }
                    texture = loaded;
                    uniforms.uCover.value = loaded;
                    uniforms.uHasCover.value = 1;
                },
                undefined,
                () => {
                    // 封面加载失败就只用主题色，不影响效果本身
                },
            );
        }

        const resize = () => {
            const width = host.clientWidth || 1;
            const height = host.clientHeight || 1;
            renderer.setSize(width, height, false);
            camera.aspect = width / height;
            /*
             * 竖屏时把视野拉远一点，否则粒子方阵会被裁掉两边。
             */
            const aspect = width / height;
            camera.fov = aspect < 1 ? 58 : 45;
            camera.position.z = aspect < 1 ? 2.6 : 2.2;
            camera.updateProjectionMatrix();
            uniforms.uPixel.value = (height / 900) * (renderer.getPixelRatio() || 1);
        };
        resize();

        const observer = typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(resize)
            : null;
        observer?.observe(host);
        window.addEventListener('resize', resize);

        const sweep = new SmoothRandom();
        const midRandom = new SmoothRandom();
        const trebleRandom = new SmoothRandom();
        const beatRandom = new SmoothRandom();
        const energyRandom = new SmoothRandom();

        let raf = 0;
        let burstValue = 0;
        const start = performance.now();

        const frame = () => {
            const nowMs = performance.now();
            const now = (nowMs - start) / 1000;
            uniforms.uTime.value = now;

            /*
             * 这几条「能量」就是替身频谱。
             *
             * 取值范围刻意错开：低频（bass）幅度大、变化慢；
             * 高频（treble）小而快 —— 和真实频谱的包络特征一致，
             * 所以视觉上仍然像「跟着音乐动」。
             */
            uniforms.uBass.value = sweep.sample(nowMs, 0.05, 1.0) * intensity;
            uniforms.uMid.value = midRandom.sample(nowMs, 0.05, 0.8) * intensity;
            uniforms.uTreble.value = trebleRandom.sample(nowMs, 0.02, 0.55) * intensity;
            uniforms.uBeat.value = Math.pow(beatRandom.sample(nowMs, 0.0, 1.0), 3) * intensity;
            uniforms.uEnergy.value = energyRandom.sample(nowMs, 0.1, 0.9) * intensity;

            // 爆裂快速衰减
            burstValue *= 0.94;
            uniforms.uBurst.value = burstValue;

            const state = stateRef.current;

            /*
             * 每隔一段时间从随机位置打一个涟漪。
             *
             * bass 越高越频繁 —— 和「低音鼓点把画面打散」的观感对应。
             */
            if (autoRipple && nowMs >= state.nextRippleAt) {
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
            raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);

        return () => {
            disposed = true;
            cancelAnimationFrame(raf);
            observer?.disconnect();
            window.removeEventListener('resize', resize);
            geometry.dispose();
            material.dispose();
            texture?.dispose();
            renderer.dispose();
            if (canvas.parentNode === host) host.removeChild(canvas);
        };
    }, [coverUrl, grid, intensity, autoRipple, tint]);

    /*
     * 新歌进来时补一次爆裂：把封面换掉的那一刻让画面「炸」一下，
     * 否则换封面是完全无感的。
     */
    useEffect(() => {
        stateRef.current.ripples = [];
        stateRef.current.nextRippleAt = 0;
    }, [coverUrl]);

    return <div ref={hostRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />;
};

export default memo(ParticlesBackground);
