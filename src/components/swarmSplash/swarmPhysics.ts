// src/components/swarmSplash/swarmPhysics.ts
// 群体光标的飞行物理：一群光标绕着一个目标点做轨道飞行（原型是「多光标建造」那类演示动画）。
//
// 只做纯计算，不碰 DOM、不碰 React：每帧由 canvas 循环调用 step()，算出的位置写进光标对象本身。
// 这样即使每帧都在动，也不会有一次 React 重渲染。

/** 一只光标。位置与速度是每帧改写的可变字段，不放进任何 state。 */
export type SwarmCursor = {
    id: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    /** 轨道半径偏移（每只不同，让群体变成一团而不是一个圈）。 */
    orbit: number;
    /** 切向速度系数：正的逆时针、负的顺时针，同一群里有正有负才像「一群」而不是一个转盘。 */
    spin: number;
    /** 径向扰动，制造个体的轻微游移。 */
    curl: number;
    /** 出生以来的秒数，用于淡入。 */
    age: number;
};

/** 一个点。 */
export type Point = { x: number; y: number };

export type SwarmField = {
    cursors: SwarmCursor[];
    /** 群体中心（每帧由调用方给：建造阶段是当前任务的落点）。 */
    target: Point;
    /** 已过去的秒数。 */
    time: number;
};

export type SwarmOptions = {
    /** 光标数量。移动端少一些：每只都要画横竖两条线 + 箭头，36 只在低端机上会掉帧。 */
    count: number;
    /** 轨道基准半径（像素）。 */
    radius: number;
    /** 出生点：屏幕外两侧，群体从边缘飞进来。 */
    spawn: { width: number; height: number };
    /** 可注入的随机源，测试用。 */
    random?: () => number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * 造一群光标：初始位置撒在目标周围，速度给 0 —— 头几帧它们会因为轨道力自己聚起来，
 * 比直接撒成一个规整的圆更自然。
 */
export const createSwarm = (options: SwarmOptions, target: Point = { x: 0, y: 0 }): SwarmField => {
    const random = options.random ?? Math.random;
    const cursors: SwarmCursor[] = [];
    for (let index = 0; index < options.count; index += 1) {
        const angle = random() * Math.PI * 2;
        const distance = options.radius * (0.4 + random() * 0.8);
        cursors.push({
            id: index,
            x: target.x + Math.cos(angle) * distance,
            y: target.y + Math.sin(angle) * distance,
            vx: 0,
            vy: 0,
            // 偏移在 ±radius 之间铺开：有的贴内圈、有的在外圈，群体才有厚度。
            orbit: (random() - 0.5) * options.radius * 2,
            // 三分之一反向：全同向看起来像刚体旋转。
            spin: random() < 0.34 ? -(0.6 + random() * 0.5) : 0.6 + random() * 0.5,
            curl: (random() - 0.5) * 2,
            age: 0,
        });
    }
    return { cursors, target, time: 0 };
};

/**
 * 推进一帧。
 *
 * 力度模型：切向速度让它绕着目标转，径向力把它拉向各自的轨道半径 —— 两股力合起来就是轨道飞行；
 * 目标点移动时整群会追过去（这正是「光标群跟着建造点走」的效果）。
 *
 * @param dt 秒。调用方要钳住上限，页面切回来时 dt 会是好几秒，一帧跳太远会炸。
 */
export const stepSwarm = (field: SwarmField, dt: number, radius: number): void => {
    const time = (field.time += dt);
    const o = field.target;
    // 呼吸：半径缓慢起伏，群体看起来在「喘气」。
    const breathe = 1 + 0.18 * Math.sin(time * 0.55);
    const swirl = Math.tanh(Math.cos(time * 0.11) * 3);

    for (const cursor of field.cursors) {
        cursor.age += dt;
        const dx = cursor.x - o.x;
        const dy = cursor.y - o.y;
        const distance = Math.hypot(dx, dy) || 0.01;
        const nx = dx / distance;
        const ny = dy / distance;
        const angle = Math.atan2(dy, dx);
        // 每只的轨道半径 = 基准 × 呼吸 × 个体波动 + 自身偏移。
        const orbitRadius = radius * breathe * (1 + 0.3 * Math.sin(3 * angle + time * 0.7)) + cursor.orbit * 0.55;
        // 切向：让它绕着走。离目标越远切向越弱，避免远处的手越转越飞。
        const tangential = 300 * (0.7 + cursor.spin * 0.2) * swirl;
        // 径向：把它拉回自己的轨道半径。
        const radial = clamp((orbitRadius - distance) * 4, -2600, 1400);
        const far = clamp((distance - orbitRadius) / 600, 0, 1);

        const forceX = -ny * tangential + nx * radial - ny * cursor.curl * 400 * far;
        const forceY = nx * tangential + ny * radial + nx * cursor.curl * 400 * far;

        // 半隐式欧拉：先加速度，再按阻尼收一下多余的动能。
        cursor.vx = (cursor.vx + forceX * dt) * 0.92;
        cursor.vy = (cursor.vy + forceY * dt) * 0.92;
        // 限速：不然个体偶尔会被径向力弹飞出去。
        const speed = Math.hypot(cursor.vx, cursor.vy);
        const maxSpeed = 2600;
        if (speed > maxSpeed) {
            cursor.vx = (cursor.vx / speed) * maxSpeed;
            cursor.vy = (cursor.vy / speed) * maxSpeed;
        }
        cursor.x += cursor.vx * dt;
        cursor.y += cursor.vy * dt;
    }
};

/**
 * 让某几只光标离开屏幕（动画收尾时用）。
 *
 * @returns 还没飞出去的光标数量；0 表示整群都走了。
 */
export const releaseSwarm = (field: SwarmField, dt: number, width: number, height: number): number => {
    let remaining = 0;
    for (const cursor of field.cursors) {
        // 朝最近的边飞。
        const dx = cursor.x < width / 2 ? -1 : 1;
        const dy = cursor.y < height / 2 ? -0.35 : 0.35;
        cursor.vx += dx * 2600 * dt;
        cursor.vy += dy * 2600 * dt;
        cursor.x += cursor.vx * dt;
        cursor.y += cursor.vy * dt;
        if (cursor.x > -120 && cursor.x < width + 120 && cursor.y > -120 && cursor.y < height + 120) {
            remaining += 1;
        }
    }
    return remaining;
};
