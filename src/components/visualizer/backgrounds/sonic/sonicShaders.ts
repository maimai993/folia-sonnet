// src/components/visualizer/backgrounds/sonic/sonicShaders.ts
//
// 音域回响（Sonic Topography）的地形着色器。
//
// 移植自 Mineradio 的 sonic-topography-preset.js（那边是 yin-yizhen/sonic-topography 1.1.1
// 的视觉层）。核心是一块**实例化的柱状地形**：每个实例是一根单位立方体柱，
// 顶点着色器在实例的格心采样噪声算出这根柱子该多高，然后按高度拉伸。
//
// 我们这边只保留地形本体（地形 + 浮动方块两块），不搬流星与拖尾：
// 那两样在那边基本是「随机背景装饰」，和音乐的关系很弱，搬过来只会多两份 draw call。
//
// 频段驱动是这套东西的灵魂，原版分 8 段（subBass / bass / lowMid / mid / highMid /
// presence / brilliance / air），每段推动不同形态的地形起伏：
//   · subBass —— 中心圆域整体抬升
//   · bass    —— 中心一圈「峰」，带噪声扰动边界
//   · lowMid  —— 全图起伏的底噪
//   · mid     —— 一条流动的「河」
//   · highMid —— 外围稀疏的尖刺
//   · presence/brilliance/air —— 顶面闪烁

/** 同时存在的最多涟漪数。与那边的 RIPPLE_MAX 一致。 */
export const SONIC_RIPPLE_MAX = 10;

export const SONIC_TERRAIN_VERTEX = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uSubBass;
uniform float uBass;
uniform float uLowMid;
uniform float uMid;
uniform float uHighMid;
uniform float uSmoothness;
uniform float uDensity;
uniform float uEnergy;
uniform float uAmplitude;
uniform vec4 uRipples[${SONIC_RIPPLE_MAX}];

varying vec2 vUv;
varying float vElevation;
varying float vDistance;
varying vec2 vRippleAnim;
varying vec3 vNormal;
varying float vRelativeY;
varying vec2 vInstancePos;

/* 2D simplex 噪声（原版同一份实现）。 */
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec2 mod289(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}
vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}
float snoise(vec2 v){
    const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
    vec2 i=floor(v+dot(v,C.yy));
    vec2 x0=v-i+dot(i,C.xx);
    vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);
    vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1;
    i=mod289(i);
    vec3 p=permute(permute(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));
    vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);
    m=m*m; m=m*m;
    vec3 x=2.0*fract(p*C.www)-1.0;
    vec3 h=abs(x)-0.5;
    vec3 ox=floor(x+0.5);
    vec3 a0=x-ox;
    m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
    vec3 g;
    g.x=a0.x*x0.x+h.x*x0.y;
    g.yz=a0.yz*x12.xz+h.yz*x12.yw;
    return 130.0*dot(m,g);
}
float random(vec2 st){return fract(sin(dot(st.xy,vec2(12.9898,78.233)))*43758.5453123);}

void main(){
    vUv = uv;
    vNormal = normal;

    /*
     * 实例矩阵的第 4 列就是这根柱子的世界位置。
     * 地形是 XZ 平面上的方阵，所以只看 xz。
     */
    vec4 instancePos = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec2 pos2D = instancePos.xz;
    vInstancePos = pos2D;
    float centerDist = length(pos2D);
    vDistance = centerDist;
    float rnd = random(pos2D);

    /* ---------- 静息形态：没有音乐时也要有起伏的底噪 ---------- */
    vec2 movingPos = pos2D * 0.05 + vec2(uTime * 0.1, uTime * 0.05);
    float baseNoise = (snoise(movingPos) + 1.0) * 0.5;
    float wave = sin(pos2D.x * 0.15 + pos2D.y * 0.1 - uTime * 0.6) * 0.5 + 0.5;
    /* 越靠外越低：地形收在一个圆盘里，边缘不能突然断。 */
    float globalFalloff = smoothstep(60.0, 30.0, centerDist);
    float idleElevation = mix(baseNoise, wave, uSmoothness * 0.5 + 0.2) * 0.8 * globalFalloff;

    /* ---------- 频段驱动 ---------- */
    float subRegion = smoothstep(25.0, 0.0, centerDist);
    float subLift = uSubBass * subRegion * 5.0;

    float bassNoise = snoise(pos2D * 0.1 - vec2(0.0, uTime * 0.2));
    float bassRegion = smoothstep(35.0, 5.0, centerDist + bassNoise * 5.0);
    float bassLift = uBass * bassRegion * (smoothstep(0.0, 1.0, rnd + uDensity * 0.5)) * 4.0;

    float lowMidNoise = snoise(pos2D * 0.05 + vec2(uTime * 0.1, 0.0));
    float lowMidLift = uLowMid * (lowMidNoise * 0.5 + 0.5) * 2.5;

    /* 一条「河」：斜向流动的正弦带。 */
    float riverFlow = sin(pos2D.x * 0.2 + pos2D.y * 0.2 + snoise(pos2D * 0.1) * 2.0 - uTime * 2.0);
    float midLift = uMid * max(0.0, riverFlow) * 3.0;

    float highMidRegion = smoothstep(10.0, 45.0, centerDist);
    float highMidLift = 0.0;
    /* 只有 20% 的柱子会长成高频尖刺，全都会显得像刷子。 */
    if (fract(rnd * 13.3) > 0.8) {
        highMidLift = uHighMid * highMidRegion * fract(rnd * 7.7) * 2.5;
    }

    float audioElevation = subLift + bassLift + lowMidLift + midLift + highMidLift;
    /* 1% 的柱子额外吃 energy：随机的高塔。 */
    if (rnd > 0.99) {
        audioElevation += uEnergy * 5.0;
    }
    audioElevation *= globalFalloff;
    audioElevation = max(0.0, audioElevation - 0.2);
    audioElevation *= uAmplitude;

    float elevation = idleElevation + audioElevation;

    /* ---------- 涟漪 ---------- */
    float rippleElevation = 0.0;
    float rippleIntensityNormal = 0.0;
    float rippleIntensityWhite = 0.0;
    for (int i = 0; i < ${SONIC_RIPPLE_MAX}; i++) {
        vec4 rd = uRipples[i];
        if (rd.w != 0.0) {
            /* w 的符号区分两种涟漪：正 = 普通（暖色），负 = 白色（爆点）。 */
            float strength = abs(rd.w);
            bool whiteRipple = rd.w < 0.0;
            float dist = length(pos2D - rd.xy);
            float timeSince = uTime - rd.z;
            float curSpeed = whiteRipple ? 18.0 : 13.0;
            float curWidth = whiteRipple ? 1.35 : 5.5;
            float curFadeDist = whiteRipple ? 12.0 : 26.0;
            float elevationScale = whiteRipple ? 1.15 : 3.35;
            float waveRadius = timeSince * curSpeed;
            float d = dist - waveRadius;
            float rippleWave = exp(-d * d / curWidth);
            float fade = exp(-waveRadius / curFadeDist);
            float lifeFade = 1.0 - smoothstep(2.10, 4.80, timeSince);
            float rPulse = rippleWave * fade * lifeFade * strength;
            rippleElevation += rPulse * elevationScale;
            if (whiteRipple) {
                rippleIntensityWhite += rPulse;
            } else {
                rippleIntensityNormal += rPulse;
            }
        }
    }

    elevation += rippleElevation;
    vRippleAnim = vec2(clamp(rippleIntensityNormal, 0.0, 1.0), clamp(rippleIntensityWhite, 0.0, 1.0));
    vElevation = elevation;

    /*
     * 拉伸柱子。
     *
     * position.y 在 BoxGeometry(height=1) 上是 [-0.5, 0.5]，先换成 [0, 1]
     * 再乘上总高度，得到一根从 0 长到 elevation 的柱子。
     */
    float yPos = position.y + 0.5;
    vRelativeY = yPos;
    float totalHeight = 1.0 + elevation;
    vec3 pos = position;
    pos.y = -0.5 + yPos * totalHeight;

    vec4 worldPosition = modelMatrix * instanceMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

export const SONIC_TERRAIN_FRAGMENT = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uPresence;
uniform float uBrilliance;
uniform float uAir;
uniform float uWarmth;
uniform float uBrightness;
uniform float uSharpness;
uniform vec3 uBaseColor1;
uniform vec3 uBaseColor2;
uniform vec3 uFogColor;
uniform vec3 uCoolCore;
uniform vec3 uCoolEdge;
uniform vec3 uWarmCore;
uniform vec3 uWarmEdge;
uniform vec3 uRippleColor;
uniform float uGlowIntensity;

varying vec2 vUv;
varying float vElevation;
varying float vDistance;
varying vec2 vRippleAnim;
varying vec3 vNormal;
varying float vRelativeY;
varying vec2 vInstancePos;

float random(vec2 st){return fract(sin(dot(st.xy,vec2(12.9898,78.233)))*43758.5453123);}

void main(){
    /* 只有顶面发光：侧面保持深色的「柱身」，这是地形读起来有厚度感的关键。 */
    bool isTop = vNormal.y > 0.5;
    float distFromTop = 1.0 - vRelativeY;
    float rnd = random(vInstancePos);
    float centerDist = length(vInstancePos);
    float normElevation = clamp(vElevation / 8.0, 0.0, 1.0);

    vec3 cBase1 = uBaseColor1;
    vec3 cBase2 = uBaseColor2;

    /* 冷暖分区：uWarmth 越大越暖，同时中心偏暖、外围偏冷。 */
    float warmBlend = smoothstep(0.0, 1.0, uWarmth * 1.5 + (0.5 - centerDist / 80.0));
    vec3 zoneCore = mix(uCoolCore, uWarmCore, warmBlend);
    vec3 zoneEdge = mix(uCoolEdge, uWarmEdge, warmBlend);
    vec3 targetGlow = mix(zoneCore, zoneEdge, fract(rnd * 11.0));

    float distFade = 1.0 - smoothstep(40.0, 75.0, centerDist);
    vec3 brightCool = mix(uCoolCore, vec3(1.0), 0.24);
    targetGlow = mix(targetGlow, brightCool, uBrightness * 0.6);

    vec3 currentGlow = mix(cBase2, targetGlow, normElevation) * uGlowIntensity * distFade;
    /* 涟漪把柱顶染成相应的颜色：普通涟漪是青色，白色涟漪直冲纯白。 */
    currentGlow = mix(currentGlow, uRippleColor, clamp(vRippleAnim.x * 0.82, 0.0, 0.72));
    currentGlow = mix(currentGlow, vec3(1.0), vRippleAnim.y);

    vec3 bodyColor = mix(cBase1, cBase2, vRelativeY * distFade);

    vec3 finalColor;
    if (isTop) {
        float topIntensity = smoothstep(0.0, 0.4, normElevation);
        float twinkleDistFalloff = smoothstep(60.0, 30.0, centerDist);
        /* 矮柱子的闪烁不受距离影响（远处的星点也需要闪），高柱子按距离收。 */
        float twinkleMultiplier = mix(twinkleDistFalloff, 1.0, smoothstep(0.01, 0.1, normElevation));

        /* 低的柱子里，5% 会在高频上闪。 */
        if (fract(rnd * 31.0) > 0.95 && normElevation < 0.1) {
            topIntensity += uAir * 2.0 * twinkleMultiplier;
        }

        finalColor = mix(cBase2, currentGlow, topIntensity);

        /* 柱顶描边：UV 靠近四边时提亮。 */
        float edgeX = smoothstep(0.05, 0.01, vUv.x) + smoothstep(0.95, 0.99, vUv.x);
        float edgeY = smoothstep(0.05, 0.01, vUv.y) + smoothstep(0.95, 0.99, vUv.y);
        float edge = min(edgeX + edgeY, 1.0);
        finalColor += currentGlow * edge * 0.8 * (topIntensity + 0.3);

        /* presence 越高，越多柱顶在闪。 */
        float flashChance = smoothstep(0.3, 1.0, uPresence);
        if (fract(rnd * 53.0) > 0.98 - flashChance * 0.1) {
            float flashSync = sin(uTime * 40.0 + rnd * 100.0) * 0.5 + 0.5;
            finalColor += mix(vec3(1.0), vec3(0.5, 1.0, 1.0), rnd) * flashSync * uPresence * (1.0 + uSharpness * 2.0) * twinkleMultiplier;
        }
        if (edge > 0.5 && fract(rnd * 89.0 + uTime * 2.0) > 0.98) {
            finalColor += vec3(1.0) * uBrilliance * 3.0 * twinkleMultiplier;
        }
    } else {
        /* 侧面：只有顶部附近发亮，往下是柱身。 */
        float verticalFalloff = mix(1.0, 3.0, uSharpness);
        float sideGlow = smoothstep(0.5 / verticalFalloff, 0.0, distFromTop) * normElevation;
        if (normElevation < 0.02) sideGlow = 0.0;
        finalColor = mix(bodyColor, currentGlow, sideGlow * 1.5);

        float rimGlow = smoothstep(0.03, 0.0, distFromTop) * normElevation;
        finalColor += currentGlow * rimGlow;
    }

    finalColor += uRippleColor * vRippleAnim.x * 0.86;
    finalColor += vec3(1.0) * vRippleAnim.y * 1.2;

    /* 空气透视 + 圆形收边：地形边缘融进背景色，不出现硬切。 */
    float aerialFog = smoothstep(30.0, 65.0, vDistance);
    vec3 atmosphericColor = mix(cBase1, cBase2, 0.4);
    finalColor = mix(finalColor, atmosphericColor, aerialFog * 0.35);

    float alphaFade = 1.0 - smoothstep(55.0, 78.0, vDistance);
    float alphaBlend = 1.0 - alphaFade;
    finalColor = mix(finalColor, uFogColor, alphaBlend * 0.45);

    gl_FragColor = vec4(finalColor, alphaFade);
}
`;

/**
 * 漂浮方块：围绕地形缓慢升降、自转的小立方体。
 *
 * 和地形共用同一套频段与配色 uniform（原版直接复用了 makeTerrainUniforms 再补一个
 * uPulse），所以这里也只多一个 uPulse。
 */
export const SONIC_FLOATING_VERTEX = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uPulse;

varying vec3 vNormal;
varying float vPulse;

void main(){
    vNormal = normalize(normalMatrix * normal);
    vPulse = uPulse;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

export const SONIC_FLOATING_FRAGMENT = /* glsl */`
precision highp float;

uniform vec3 uCoolCore;
uniform vec3 uWarmCore;
uniform vec3 uRippleColor;
uniform float uGlowIntensity;

varying vec3 vNormal;
varying float vPulse;

void main(){
    /* 简单的定向光：正面亮、背面暗，让方块有体积感。 */
    float lit = clamp(dot(normalize(vNormal), normalize(vec3(0.4, 0.8, 0.5))) * 0.5 + 0.5, 0.0, 1.0);
    vec3 tint = mix(uCoolCore, uWarmCore, vPulse);
    vec3 col = tint * (0.35 + lit * 1.25) * uGlowIntensity + uRippleColor * vPulse * 0.25;
    gl_FragColor = vec4(col, 0.55 + lit * 0.35);
}
`;
