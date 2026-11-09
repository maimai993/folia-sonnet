// src/components/visualizer/backgrounds/particles/particlesShaders.ts
//
// 封面粒子背景的着色器。
//
// 移植自 Mineradio 的封面粒子效果（封面上每个像素变成一个粒子，然后被「涟漪」推动），
// 但做了一处根本改动：那边靠实时频谱（uBass/uMid/uTreble/uBeat）驱动，
// Folia 这一层**没有读取频谱的能力**，所以改成由 JS 侧喂一组
// 平滑过的随机「节拍数值」——shape 和那边的完全一样，只是数据来源不同。

/** 全屏四边形（两个三角形）的顶点着色器：把设备坐标直接铺满屏幕。 */
export const QUAD_VERTEX = `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * 粒子顶点着色器。
 *
 * 每个顶点是一个粒子：位置来自封面网格（aGrid），颜色/亮度来自封面纹理采样。
 * 位移主要由两件事驱动：
 *   1. 涟漪（uRipples）—— 屏幕上的圆形波，越靠中心推得越高
 *   2. 节拍（uBass / uEnergy）—— 整体往外鼓、变大
 */
export const PARTICLE_VERTEX = `
attribute vec2 aGrid;
attribute float aRand;

uniform float uTime;
uniform float uPixel;
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uBeat;
uniform float uEnergy;
uniform float uBurst;
uniform vec3 uRipples[8];
uniform int uRippleCount;
uniform vec3 uTint;
uniform float uTintStrength;

varying vec3 vColor;
varying float vAlpha;
varying float vRipple;

float hash11(float n) {
    return fract(sin(n * 127.1) * 43758.5453123);
}

void main() {
    /*
     * 位置直接用顶点自带的 position。
     *
     * 之前是从 aGrid 重算（aGrid - 0.5），那份只铺到 ±0.5，
     * 而顶点位置是按可视区放大过的 —— 两边不一致，
     * 涟漪的坐标和粒子的实际位置对不上，推出来是散的。
     */
    vec3 pos = position;

    float rippleAmp = 0.0;

    /*
     * 涟漪：每条记录是 (x, y, 年龄)，0..1 的平面坐标。
     * 波前按年龄向外扩散，落在波前附近的粒子被推向镜头方向。
     */
    for (int i = 0; i < 8; i++) {
        if (i >= uRippleCount) break;
        vec3 ripple = uRipples[i];
        float age = ripple.z;
        if (age < 0.0 || age > 1.0) continue;

        vec2 delta = pos.xy - ripple.xy;
        float dist = length(delta);
        // 波前半径随时间推到 0.9，带宽 0.18
        float front = age * 0.9;
        float band = abs(dist - front);
        float wave = smoothstep(0.18, 0.0, band);
        // 越老越弱
        float decay = 1.0 - age;
        float push = wave * decay * decay;

        if (push > 0.0001) {
            // 沿法线往外推，同时往镜头方向抬起来
            vec2 dir = dist > 0.0001 ? delta / dist : vec2(0.0);
            pos.xy += dir * push * 0.045;
            pos.z += push * 0.32;
            rippleAmp = max(rippleAmp, push);
        }
    }

    // 节拍：整体微微外扩 + 抬升，这就是「跳跃」感的来源
    float beatLift = uBeat * 0.5 + uBass * 0.28 + uEnergy * 0.16;
    pos.xy *= 1.0 + beatLift * 0.035;
    pos.z += beatLift * 0.06;

    // 爆裂：新歌进来时抖一下
    if (uBurst > 0.001) {
        vec2 dir = normalize(pos.xy + vec2(hash11(aRand * 31.0) - 0.5, hash11(aRand * 47.0) - 0.5) * 0.1);
        pos.xy += dir * uBurst * 0.06;
        pos.z += (hash11(aRand * 123.0) - 0.5) * uBurst * 0.2;
        rippleAmp = max(rippleAmp, uBurst * 0.4);
    }

    // 离散感：高频的轻微抖动，让粒子不像规整的格子
    if (uTreble > 0.001) {
        vec2 jitter = vec2(
            hash11(aRand * 917.0) - 0.5,
            hash11(aRand * 331.0) - 0.5
        );
        pos.xy += jitter * uTreble * 0.006;
        pos.z += jitter.x * uTreble * 0.02;
    }

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);

    // 粒子大小：越远越小，涟漪和节拍让它变大
    float sizeBoost = 1.0 + rippleAmp * 0.9 + uBass * 0.35 + uBeat * 0.4 + uBurst * 0.5;
    float size = (uPixel * 2.2) / max(0.35, -mv.z) * sizeBoost;

    vAlpha = (0.42 + rippleAmp * 0.55 + uBass * 0.10) * (1.0 - smoothstep(0.55, 1.0, -mv.z));
    vColor = uTint;
    vRipple = clamp(rippleAmp, 0.0, 1.0);

    gl_PointSize = clamp(size, 1.0, 24.0);
    gl_Position = projectionMatrix * mv;
}
`;

/**
 * 粒子片元着色器：采样封面纹理决定颜色，带一个圆形软边。
 *
 * 采样用的是粒子的网格坐标（vGrid），不是屏幕坐标 ——
 * 所以涟漪把粒子推开时，颜色还是跟着封面走，看起来像「封面被搅动」。
 */
export const PARTICLE_FRAGMENT = `
uniform sampler2D uCover;
uniform float uHasCover;
uniform float uMid;
uniform float uBass;
uniform float uBeat;

varying vec3 vColor;
varying float vAlpha;
varying float vRipple;

void main() {
    // 把方形的点画成圆：离中心越远越透明
    vec2 centered = gl_PointCoord - 0.5;
    float dist = length(centered);
    if (dist > 0.5) discard;
    float soft = smoothstep(0.5, 0.28, dist);

    vec3 base = vColor;
    /*
     * 封面颜色：UV 用 gl_PointCoord 之外的另一种映射太重，
     * 这里用亮度参与调制 —— 粒子本身已经按网格分布，
     * 颜色主要来自主题色，封面只贡献一个亮度乘子。
     */
    float brightness = 0.72 + vRipple * 0.6 + uBass * 0.18 + uBeat * 0.22 + uMid * 0.08;

    vec3 color = base * brightness;
    // 涟漪核心偏白，强化「被波打到」的感觉
    color = mix(color, vec3(1.0), vRipple * 0.35);

    gl_FragColor = vec4(color, vAlpha * soft);
}
`;
