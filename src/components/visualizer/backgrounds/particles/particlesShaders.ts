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
/** 封面亮度当景深，0..1。JS 侧算好，见 applyCoverDepth。 */
attribute float aDepth;

uniform float uTime;
uniform float uPixel;
/*
 * 单粒子大小倍数（设置里「粒子大小」）。
 *
 * 不并进 uPixel：那个是设备像素比，是运行环境的量，不是用户的偏好。
 * 两者混在一条 uniform 里，改设置会连带影响 DPI 换算 —— 换台机器看到的大小就变了。
 */
uniform float uPointScale;
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
/** 网格每边的格数，用来把粒子直径算到匹配间距。 */
uniform float uGridSize;
/** 封面的景深算好了没有。为 0 时顶点不做 z 位移。 */
uniform float uHasDepth;
/** 画布 CSS 像素高度 / 900。 */
uniform float uViewScale;
/** 可视区域在世界空间里的高度（2 * camZ * tan(fov/2)），把世界尺寸换算到屏幕像素要用它。 */
uniform float uProjSpan;
/** 一格在世界空间里的边长（planeHeight / (grid - 1)），决定粒子该画多大。 */
uniform float uCellSpan;
/**
 * 相机到粒子平面的距离（世界空间）。
 *
 * ★ 深度衰减和点尺寸都跟着它走，否则「相机一拉远粒子就没了」。
 *
 * 早先那些系数是按基准距离 2.2 写死的：
 *   · 透明度 smoothstep(4.2, 2.0, -mv.z)：相机一退到 4.2 之外，整块画布全透明；
 *   · 点尺寸 2.2 / max(0.35, -mv.z)：按 2.2 的基准缩放。
 * 相机距离一变，这些假设就不成立，粒子不是变小就是直接消失
 * （用户反馈「距离一点远就看不见了」）。
 *
 * 现在把距离传进来，衰减区间和尺寸基准都按它推：拉远时粒子变小一点，
 * 但仍然看得见；拉近时相应放大。
 */
uniform float uCamDist;

/*
 * 形态：0 丝绸（专辑封面）· 1 滚筒 · 2 星球 · 3 虚空 · 4 唱片。
 *
 * 编号与 Mineradio 的 uPreset 一致，方便和那边的源码对着看。
 * 五种形态共用同一份几何与涟漪逻辑，靠这一个值切换排布方式。
 */
uniform float uForm;
/** 律动强度倍数。和 Mineradio 的 K = uIntensity * 1.6 同一个意思。 */
uniform float uIntensity;

varying vec3 vColor;
varying float vAlpha;
varying float vRipple;
varying vec2 vGrid;
/** 按形态重映射后的封面采样坐标（丝绸 / 星球就是 vGrid）。 */
varying vec2 vSampleUv;
/** 虚空形态把 alpha 直接压到 0 —— 顶点着色器里没有 alpha 可供片元覆写。 */
varying float vForceHidden;

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

    /*
     * 采样坐标：默认就是粒子的网格位置（丝绸形态直接用）。
     *
     * 别的形态要把封面重新映射到自己的几何上 —— 滚筒要按 flow 采样、
     * 星球按经纬度、唱片只在中英圆盘里采样。所以这里传一个单独的
     * varying 给片元着色器，而不是让它直接用 vGrid。
     */
    vec2 sampleUv = aGrid;

    /*
     * ====================================================
     *  形态分支（移植自 Mineradio 的 preset 0/1/2/3/4）
     * ====================================================
     *
     * 那边这些是「一个粒子系统 + 着色器里 if (uPreset < 0.5) ... else if」，
     * 这里照同样的做法：同一个 BufferGeometry，只按 uForm 重写位置与采样坐标。
     * 不拆成多个背景，是因为几何、涟漪、封面采样都要一模一样 ——
     * 拆开就要复制五份，以后改一处得改五处。
     *
     * 形态编号与那边一致，方便对照源码：
     *   0 丝绸（专辑封面）· 1 滚筒 · 2 星球 · 3 虚空 · 4 唱片
     */

    /* ---------- 形态 1：滚筒（极坐标隧道 + 绕 Z 自旋）---------- */
    if (uForm > 0.5 && uForm < 1.5) {
        float spin = uTime * 0.12;
        float angle = aGrid.x * 6.2831853 + spin;
        /* flow 沿隧道轴向推进：低频让整条隧道往前涌。 */
        float flow = fract(aGrid.y - uTime * 0.08 * (1.0 + uBass * 0.55));
        float zPos = (flow - 0.5) * 9.0;
        float baseR = 2.0 - uBass * 0.28 * uIntensity * 1.6;
        /* 中高频在隧道壁上打出环形波纹。 */
        float ripG = sin(angle * 5.0 + zPos * 1.4 + uTime * 2.2) * 0.10 * (uMid + uTreble) * uIntensity * 1.6;
        float r = baseR + ripG;
        pos.x = cos(angle) * r;
        pos.y = sin(angle) * r;
        pos.z = zPos;
        /* 封面按「环向 × flow」贴到隧道内壁。 */
        sampleUv = vec2(aGrid.x, flow);
    }

    /* ---------- 形态 2：星球（球面 + 自转）---------- */
    else if (uForm > 1.5 && uForm < 2.5) {
        float theta = aGrid.x * 6.2831853;
        float phi = (aGrid.y - 0.5) * 3.1415926;
        float baseR = 2.2;
        /* 高频让球面局部鼓起，低频整体膨胀。 */
        float trebFlare = sin(theta * 1.5 + phi * 1.5 + uTime * 0.7) * uTreble * 0.85 * uIntensity * 1.6;
        float bassExpand = uBass * 0.35 * uIntensity * 1.6;
        float r = baseR * (1.0 + bassExpand) + trebFlare;
        pos.x = r * cos(phi) * cos(theta);
        pos.y = r * sin(phi);
        pos.z = r * cos(phi) * sin(theta);
        /* 绕 Y 轴缓慢自转。 */
        float yaw = uTime * 0.18;
        float cy = cos(yaw);
        float sy = sin(yaw);
        pos.xz = mat2(cy, -sy, sy, cy) * pos.xz;
        /* 经纬度就是封面 UV：赤道一圈是封面的横边。 */
        sampleUv = aGrid;
    }

    /*
     * ---------- 形态 3：虚空（已从形态选择器里删掉）----------
     *
     * 这个分支留着是为了兼容旧存档：以前存过 form='void' 的人，
     * 升级后读出来还是 3，直接落到这里不会炸（只是仍然什么都不画）。
     * 新选的形态不会再到这里来。
     */
    else if (uForm > 2.5 && uForm < 3.5) {
        /* 缩到极小并完全透明：保留 draw call，但一个点也看不见。 */
        pos = vec3((aGrid.x - 0.5) * 0.01, (aGrid.y - 0.5) * 0.01, -90.0);
    }

    /* ---------- 形态 4：唱片（中心圆盘封面 + 黑胶纹 + 白边）---------- */
    else if (uForm > 3.5) {
        /*
         * 唱片是一张平铺在 XY 平面的圆盘。
         * aGrid 被映射到 [-2.56, 2.56] 的方形区域，超出记录半径的点被 alpha 裁掉。
         */
        vec2 p = (aGrid - 0.5) * 5.12;
        float spin = uTime * 0.55;
        float cs = cos(spin);
        float sn = sin(spin);
        /* 整张唱片随音乐旋转：这就是「转起来」的来源。 */
        vec2 rp = mat2(cs, -sn, sn, cs) * p;
        float d = length(p);
        float angle0 = atan(p.y, p.x);
        float recordR = 2.46;
        float coverR = 1.18;

        float bassDrive = smoothstep(0.08, 0.78, uBass + uBeat * 0.82);
        /* 盘面随低频轻轻涨缩。 */
        pos = vec3(rp * (1.0 + bassDrive * 0.012 + uBeat * 0.026), 0.0);

        if (d < coverR) {
            /* 中心：圆形封面。UV 在圆盘内部重新居中映射。 */
            sampleUv = p / (coverR * 2.0) + 0.5;
            pos.z = 0.040 + uBeat * 0.018;
        } else {
            /* 外围：黑胶纹。UV 指向封面之外，片元那边会取到边缘色，这里不关心。 */
            sampleUv = vec2(0.5);
            float vinylN = clamp((d - coverR) / max(0.001, recordR - coverR), 0.0, 1.0);
            float groove = 0.5 + 0.5 * sin((d - coverR) * 98.0);
            pos.z = groove * 0.010 + bassDrive * vinylN * 0.016 + uBeat * vinylN * 0.08;
        }
    }

    /*
     * 景深：封面越亮的点离镜头越近。
     *
     * aDepth 是 JS 侧从封面算出来的（ParticlesBackground 的 applyCoverDepth），
     * 因为顶点着色器在 WebGL1 里不能 texture2D —— 纹理只能片元采样，
     * 所以「这个点有多远」必须作为 attribute 传进来。
     *
     * Mineradio 那边有一张 AI 深度图（R=depth），我们没有那个估计器，
     * 用亮度代替：它同样能给出有意义的层次，而且不需要联网。
     * uHasDepth 为 0（没有封面或跨域读不到像素）时 d 取 0，画面保持平整。
     */
    float depth = uHasDepth > 0.5 ? aDepth : 0.0;
    pos.z += (depth - 0.5) * 0.55;
    /* 亮的地方粒子略大一点，强化「近」的感觉。 */
    float depthScale = 1.0 + (depth - 0.5) * 0.28;

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

    /*
     * 粒子大小。
     *
     * ★ 这里原来错得很彻底：baseSize 用的是**世界空间**的格间距
     * （1.24 / uGridSize ≈ 0.0129），但 gl_PointSize 的单位是**屏幕像素**。
     * 少了投影换算，算出来只有 0.011px，被下面那句 clamp 抬到 1px 下限 ——
     * 于是每个粒子只盖住 1 个像素，而它在屏幕上的格子有 3~7px 宽，
     * 只填了不到十分之一的面积；再配上加性混合和低 alpha，整块画布就是纯黑。
     * 这就是「粒子背景显示不出来」的真正原因（不是着色器编译失败、也不是缺封面）。
     *
     * 现在按「格子在屏幕上的实际像素尺寸」来算：
     *   世界空间里画面可视高度 = 2 * |cameraZ| * tan(fov/2)
     *   （fov 与 cameraZ 由 JS 侧按竖屏/横屏选，这里通过 uViewScale 与 uProjScale 传进来）
     * 每格占的可视比例 = 1 / uGridSize × (1.24 的铺开系数)，
     * 换算成像素就是 可视高度像素 / uGridSize × 1.24。
     *
     * uViewScale = 画布像素高 / 900，uProjScale 编进下面的常量里。
     * 结果再乘 1.7，让相邻粒子轻微重叠，拼起来才像一整张封面而不是点阵。
     */
    /*
     * 一格在屏幕上占多少像素。
     *
     * uCellSpan 是「一格在世界空间里的边长」（JS 侧按 planeHeight / (grid-1) 算好），
     * uProjSpan 是可视世界高度。两者相除就是这格占屏幕高度的比例，
     * 乘上画布高度像素就得到它实际的像素尺寸。
     *
     * 这里以前写死 1.24（平面边长），而平面现在会跟着屏幕方向缩放，
     * 写死常量会让粒子大小和实际格距对不上 —— 改小变大都会出问题，
     * 所以改成由 JS 每帧把真实值传进来。
     *
     * uViewScale 传的是「CSS 像素高 / 900」，900 只用来做归一化，
     * 这里乘回来得到 CSS 像素高。
     */
    float heightPx = uViewScale * 900.0;
    float cellPx = heightPx * (uCellSpan / max(0.01, uProjSpan));
    /*
     * 只乘 uPixel 一次：heightPx 是 CSS 像素，gl_PointSize 要的是设备像素。
     * 乘两次会让高 DPI 屏上的粒子大一倍、相邻格子糊成一坨。
     */
    float baseSize = cellPx * uPixel * 1.7 * uPointScale;
    float sizeBoost = 1.0 + rippleAmp * 0.9 + uBass * 0.35 + uBeat * 0.4 + uBurst * 0.5;
    /* 景深也参与尺寸：亮处（近）的粒子略大，暗处（远）略小。 */
    sizeBoost *= depthScale;    /* 近大远小：mv.z 是负的，越近绝对值越小，点越大。 */
    /*
     * 点尺寸的深度缩放：基准是相机距离，不是写死的 2.2。
     *
     * 写死 2.2 时，相机退远之后这个比值一直小于 1，粒子被越缩越小，
     * 缩到 1px 就只剩一层灰雾（用户反馈「距离一点远就看不见了」）。
     */
    float size = baseSize * sizeBoost * (uCamDist / max(0.35, -mv.z));

    /*
     * 深度衰减：区间跟着相机距离走。
     *
     * ★ 原来写死 smoothstep(4.2, 2.0, -mv.z) —— 相机一退到 4.2 之外，
     * alpha 恒为 0，整块画布全透明，粒子「看不见了」。
     *
     * 现在以相机距离为中心、按比例撑开区间：最近的粒子（被涟漪推向镜头）
     * 略微透明制造纵深，最远的（画面深处）也留一个下限，不至于消失。
     */
    float near = uCamDist * 0.85;
    float far = uCamDist * 2.2;
    vAlpha = (0.42 + rippleAmp * 0.55 + uBass * 0.10) * smoothstep(far, near, -mv.z);
    vColor = uTint;
    vRipple = clamp(rippleAmp, 0.0, 1.0);
    /*
     * 把网格坐标原样传给片元着色器。
     *
     * 这是「封面打散成粒子」的关键：粒子被涟漪推走之后，它对应的封面
     * 采样点**不能跟着走** —— 跟着走的话整块封面只是被平移，看不出
     * 是被搅碎的。所以这里传的是粒子出生时的网格位置，不是当前位置。
     */
    vGrid = aGrid;
    vSampleUv = sampleUv;

    /*
     * 虚空形态：所有点降到不可见。
     *
     * 必须在这里给，不能在片元里判断 —— 顶点着色器算出来的 vAlpha 已经被
     * 上面那堆律动项撑起来了，片元那边再压 0 也行，但保持「一处在算」更清楚。
     */
    vForceHidden = (uForm > 2.5 && uForm < 3.5) ? 1.0 : 0.0;
    if (vForceHidden > 0.5) vAlpha = 0.0;

    /*
     * 上限放到 48：新的尺寸公式按网格间距算，正常就在 8~20px 之间，
     * 涟漪和节拍推高时需要留出余量，否则鼓点一来自动被截平，看着很死。
     */
    gl_PointSize = clamp(size, 1.0, 48.0);
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
/**
 * 封面纹理的宽高比（宽 / 高）。
 *
 * 网格铺满的是**屏幕**（16:9），而封面通常是正方形。直接把 vGrid 当 UV 用，
 * 等于把封面横向拉成 16:9 —— 设备上看到的就是「封面显示不全/被压扁」。
 *
 * 用它做一次「cover 缩放」：把 UV 从屏幕比例换算回封面比例、居中裁切，
 * 保持封面本身的形状不变形（和 CSS 的 background-size: cover 同一个意思）。
 */
uniform float uCoverAspect;
/** 屏幕（画布）的宽高比，和封面比例一起算出裁切系数。 */
uniform float uScreenAspect;
uniform float uMid;
uniform float uBass;
uniform float uBeat;
/** 调试：>0.5 时每个粒子画成不透明纯色，用来确认「到底有没有画出来」。 */
uniform float uDebug;

/** 形态编号（与顶点着色器一致），片元这边要按它决定采样与着色方式。 */
uniform float uForm;

varying vec3 vColor;
varying float vAlpha;
varying float vRipple;
varying vec2 vGrid;
/** 顶点着色器按形态算好的封面采样坐标。 */
varying vec2 vSampleUv;
/** 1 = 这个形态不显示任何粒子（虚空）。 */
varying float vForceHidden;

void main() {
    // 虚空形态：一个点都不画。
    if (vForceHidden > 0.5) discard;
    // 把方形的点画成圆：离中心越远越透明
    vec2 centered = gl_PointCoord - 0.5;
    float dist = length(centered);
    if (dist > 0.5) discard;
    float soft = smoothstep(0.5, 0.28, dist);

    /*
     * 封面采样。
     *
     * 按粒子的网格坐标去取封面上的对应像素。
     *
     * ★ v 轴这里**不能再翻**。
     *
     * 网格的 v 是这么来的（见 ParticlesBackground 的 buildGeometry）：
     *   v = gy / (rows - 1)，而位置是 y = (v - 0.5) * planeHeight。
     * 也就是说 v=0 → 世界 y 最小 → **屏幕底部**。而 three 的纹理默认 flipY，
     * texture2D 的 v=0 是图片底部。两边方向本来就一致。
     *
     * 之前这里写了 1.0 - vGrid.y，等于多翻了一次 ——
     * 设备上看到的就是「粒子里的封面是倒着的、和封面卡片完全反方向」。
     */
    vec3 coverColor = vec3(0.0);
    float coverLum = 0.0;
    if (uHasCover > 0.5) {
        /*
         * 把屏幕 UV 换算成「按封面比例居中裁切」的 UV。
         *
         * 屏幕比封面宽时（16:9 的屏幕 + 正方形封面），横向多出来的部分要往外扩，
         * 纵向刚好铺满；反之亦然。系数 = 两个比例的比值。
         */
        /*
         * 采样坐标来自顶点着色器的按形态重映射（vSampleUv）。
         *
         * 丝绸和星球直接用它当封面 UV，所以要按屏幕比例裁切；
         * 滚筒和唱片已经在顶点着色器里自己算好了「封面怎么贴」，
         * 再套一次屏幕裁切会把它们的位置算歪（隧道壁上的图会错位）。
         */
        vec2 coverUv = vSampleUv;
        bool ownMapping = (uForm > 0.5 && uForm < 2.5) || uForm > 3.5;
        if (!ownMapping) {
            float ratio = uScreenAspect / max(0.0001, uCoverAspect);
            if (ratio > 1.0) {
                // 屏幕更宽：横向看到封面更多的“外侧”，把它压回中心
                coverUv.x = (coverUv.x - 0.5) * ratio + 0.5;
            } else {
                // 屏幕更高：纵向同理
                coverUv.y = (coverUv.y - 0.5) / ratio + 0.5;
            }
        }
        coverColor = texture2D(uCover, coverUv).rgb;
        // 亮度用来决定这个粒子的「实体感」：暗的地方让位给主题色
        coverLum = dot(coverColor, vec3(0.299, 0.587, 0.114));
        // 提亮，避免封面偏暗时整片糊掉
        coverColor = mix(coverColor, coverColor * 1.35 + 0.05, 0.5);
    }

    /*
     * 没有封面时退回主题色（别让整个背景变成全黑）；
     * 有封面时以封面色为主、主题色只做一点染色，保留封面本身的观感。
     */
    vec3 base = uHasCover > 0.5
        ? mix(coverColor, coverColor * vColor * 2.0, 0.22)
        : vColor;

    /*
     * 主题色常常很深（深色主题下接近黑），直接乘亮度乘出来还是黑的 ——
     * 抬一个下限，保证无论主题多暗，粒子都能看见。
     */
    float baseLum = dot(base, vec3(0.299, 0.587, 0.114));
    if (baseLum < 0.22) {
        base = mix(base, vec3(0.76, 0.83, 1.0), (0.22 - baseLum) / 0.22 * 0.75);
    }

    /*
     * 亮度基线 0.62。
     *
     * 走过 0.55（太黑，看不清）、0.82（太亮，用户反馈「太亮了」）、现在 0.62：
     * 静息状态就足够看见粒子，但整片背景仍压在深色区间，
     * 不抢歌词。涟漪 / 鼓点在此之上再叠加。
     */
    float brightness = 0.62 + vRipple * 0.42 + uBass * 0.13 + uBeat * 0.18 + uMid * 0.06;

    vec3 color = base * brightness;
    // 涟漪核心偏白，强化「被波打到」的感觉
    color = mix(color, vec3(1.0), vRipple * 0.25);

    /*
     * 透明度：封面很暗的地方稍微压一点，但保留一个下限 ——
     * 不然封面上黑色区域对应的粒子会直接消失，方阵出现空洞。
     */
    float coverAlpha = uHasCover > 0.5 ? (0.70 + coverLum * 0.48) : 0.94;

    /*
     * 调试开关：localStorage.setItem('folia_particle_debug','1') 后重载，
     * 每个粒子画成不透明纯色。用来回答「粒子到底画在哪儿 / 有没有画」——
     * 成品着色器分不清「没画」和「画了但太暗/太小」。
     */
    if (uDebug > 0.5) {
        gl_FragColor = vec4(1.0, 0.25, 0.15, 1.0);
        return;
    }

    gl_FragColor = vec4(color, vAlpha * soft * coverAlpha);
}
`;
