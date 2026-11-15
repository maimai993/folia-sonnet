// mods/visualizer-jump/jumpCourse.mjs
// 小人的「跳」本身：照原版跳一跳那一枚棋子的三个拍子。纯计算，不碰 DOM。
//
// 几何（柱子怎么摆、两行怎么折、镜头怎么摇）在 client.mjs 的 `buildScene` 里；
// 这一层只回答「此刻这个棋子被压 / 拉到什么程度」。
//
// 原版的三拍（按住蓄力 → 松手 → 落地），一路只有竖直方向在变，棋子自己不翻也不转：
//   1. **蓄力**：按住的时候棋子被压矮（明显，但不是卡通那种压成饼）；
//   2. **腾空**：松手之后棋子被**拉长**（原版是拉长，不是压扁），快落地时收回原样；
//   3. **落地**：磕在柱顶上压一下，随即弹回。
// 上一版只有「压」没有「拉」，而且压到 0.68（短三成、横向补成 1.32 倍）——
// 那是卡通的极限挤压，原版远没这么夸张。这里三拍各自留一小截幅度。
//
// 除了棋子自己，还有两处跟着这一跳动（都在柱子上，见 resolveLandingBurst / resolvePillarSpring）：
//   - 落地那一瞬在柱顶铺一圈环、溅几粒尘——「落在**哪一根**上」一眼看得见；
//   - 柱子自己被踩沉下去，人一走就弹回来、再小幅振动几下——柱子受力，这一跳才有重量。

/**
 * 落地那一瞬的特效持续多久（秒）、飞散的尘有几粒。
 *
 * 短一点才像「磕了一下」：特效一长就变成落点上的一朵花，反而盖住小人。
 */
export const IMPACT_SECONDS = 0.36;
export const IMPACT_DUST = 6;

/*
 * 三拍的幅度（都是竖直缩放的增减量）：蓄力压多少、落地压多少、腾空拉长多少。
 * 三拍都只是「轻轻一下」——原版的棋子压 / 拉都是点到为止，压过头就成了卡通的橡皮人。
 */
export const SQUASH_CHARGE = 0.08;
export const SQUASH_IMPACT = 0.1;
export const STRETCH_AIR = 0.05;

/** 竖直缩放的两个端点：再怎么压也留着棋子的形状，再怎么拉也别成一根棍。 */
export const SQUASH_MIN = 0.88;
export const SQUASH_MAX = 1.07;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * 挤压 / 拉伸：返回**竖直方向的缩放**，1 是原样、<1 是压矮、>1 是拉长。
 * 横向由画小人的那一层按它补回来（见 jumpStage 的 `SQUASH_WIDTH_GAIN`）。
 *
 * `progress` 是一次跳跃里 0…1 的位置：0 起跳、1 落地。
 */
export const resolveHopSquash = (progress) => {
    const t = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
    /*
     * 三拍各占一小段，段与段之间留空档：`t = 0`（上一跳刚落地、站着没动）与
     * `t = 1`（这一跳落地）都得回到原样，否则起跳前后会平白多一下抖动。
     */
    // 蓄力：起跳前蹲一下。
    const charge = Math.exp(-Math.pow((t - 0.1) / 0.08, 2)) * SQUASH_CHARGE;
    // 落地：磕上去压一下。
    const impact = Math.exp(-Math.pow((t - 0.9) / 0.07, 2)) * SQUASH_IMPACT;
    // 腾空：被拉长，两头收回原样。
    const stretch = Math.sin(Math.PI * clamp((t - 0.16) / 0.72, 0, 1)) * STRETCH_AIR;
    return clamp(1 - charge - impact + stretch, SQUASH_MIN, SQUASH_MAX);
};

/**
 * 柱子被踩下去的那一套（都是固定量，幅度再由旋钮 `strength` 缩放）：
 *   - `SINK_CELLS`：踩到底时柱子沉下去多少（格，世界里的竖直一段）；
 *   - `SINK_SECONDS`：从刚沾上到沉到底用多久——短一点才像「磕」下去的；
 *   - `SPRING_PERIOD` / `SPRING_DAMPING`：起跳之后弹回来的周期与阻尼；
 *   - `SPRING_TAIL`：振动到这么久之后就当它停了（幅度早已小于半个像素）。
 */
export const SINK_CELLS = 0.45;
export const SINK_SECONDS = 0.09;
export const SPRING_PERIOD = 0.3;
export const SPRING_DAMPING = 7;
export const SPRING_TAIL = 1.4;

/**
 * 第 `index` 粒尘往哪个方向飞（单位圆上的一点）。
 *
 * 角度由序号算出来，不是每帧 `random`：随机的话拖动进度、暂停、导出会各画出一朵不同的花，
 * 而「同一秒永远是同一帧」是这一层的底线。纵向先压掉一半，剩下的压扁交给调用方
 * （柱顶是斜面，那一档由投影的 `sin` 给）。
 */
const rayAt = (index) => {
    const angle = (Math.PI * 2 * index) / IMPACT_DUST + 0.42;
    return { x: Math.cos(angle), y: Math.sin(angle) * 0.5 };
};

/**
 * 落地那一瞬的冲击：一圈铺开的环 + 几粒飞散的尘。
 *
 * 返回**归一化**的一份（`radius` 与尘的偏移都是「落点半径」的几成），像素由调用方乘上去。
 * 没有特效可画的时候（还没落地、或者已经散完）返回 `null`，调用方直接收起那一层——
 * 于是大部分帧里这一层是空的，不占节点。
 *
 * 同样只由时间算出来：落地时刻是时间表里现成的那一秒，不累加，
 * 拖动进度不会留下半开的环，暂停也不会把它冻在中途。
 */
export const resolveLandingBurst = (options = {}) => {
    const time = Number.isFinite(options.time) ? options.time : 0;
    const landTime = Number.isFinite(options.landTime) ? options.landTime : null;
    if (landTime === null) return null;
    const seconds = Math.max(0.05, Number(options.seconds) || IMPACT_SECONDS);
    const t = (time - landTime) / seconds;
    if (t < 0 || t > 1) return null;
    /*
     * 铺开：起步快、收尾慢（环被磕出去之后越铺越慢）；淡出：尾巴拖得住，环才不像一闪。
     * 起点不是 0.3 而是 0.62：环从「贴着落点」开始铺时头几帧只有几个像素，
     * 又正好整个人踩在那一点上，于是整圈被小人与影子盖住——看着就像没有环。
     */
    const spread = 1 - Math.pow(1 - t, 3);
    const fade = Math.pow(1 - t, 1.35);
    const dust = [];
    for (let index = 0; index < IMPACT_DUST; index += 1) {
        const ray = rayAt(index);
        // 每粒飞得一样快、远近差一点：全挤在同一个圆上就成了一圈珠子，不像溅开的尘。
        const reach = spread * (0.62 + 0.38 * ((index % 3) / 2));
        dust.push({ x: ray.x * reach, y: ray.y * reach, opacity: fade * 0.7 });
    }
    return {
        ring: { radius: 0.62 + 0.38 * spread, opacity: fade },
        dust,
    };
};

/**
 * 柱子此刻被压下去多少（格，**正数 = 往下**），三段：
 *   1. `pressTime` 之前：没人踩，纹丝不动；
 *   2. 踩着（`pressTime` → `releaseTime`）：很快沉到底，然后压着不动；
 *   3. `releaseTime` 之后：人一走就弹回来——冲过头一点，再做几下越来越小的振动，最后归零。
 *
 * `strength` 是旋钮「柱子弹性」：0 = 一步不动（老样子），1 = 默认这一沉一弹，2 = 夸张。
 * 起跳那一刻柱子还在最深处（`cos 0 = 1`），所以三段是**连续**的：人走、柱子弹，
 * 中间不会跳一下。
 *
 * 同样只由时刻算出来、不累加：拖进度、暂停、导出看到的都是同一帧。
 */
export const resolvePillarSpring = (options = {}) => {
    const strength = Math.max(0, Number(options.strength) || 0);
    if (strength <= 0) return 0;
    const time = Number.isFinite(options.time) ? options.time : 0;
    const press = Number.isFinite(options.pressTime) ? options.pressTime : null;
    if (press === null || time < press) return 0;
    const depth = SINK_CELLS * strength;
    const release = Number.isFinite(options.releaseTime) ? options.releaseTime : null;
    /*
     * 落脚与起跳是同一刻（第 0 根常常如此：他从上一行跨过来就接着往下跳）时，
     * 这一根等于没被踩过 —— 别让它凭空沉一下再弹回来。
     */
    if (release !== null && release <= press) return 0;
    if (release === null || time < release) {
        // 沉下去：起步最快、到底就停（落地那一下是「磕」下去的，不是慢慢压）。
        const t = clamp((time - press) / SINK_SECONDS, 0, 1);
        return depth * (1 - Math.pow(1 - t, 3));
    }
    const tau = time - release;
    if (tau > SPRING_TAIL) return 0;
    // 阻尼振动：从最深处起步往上弹，冲过头（负值 = 抬起）再回来，幅度一路衰减。
    const decay = Math.exp(-SPRING_DAMPING * tau);
    if (decay < 0.004) return 0;
    return depth * decay * Math.cos((2 * Math.PI * tau) / SPRING_PERIOD);
};
