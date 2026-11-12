import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { readGyroTiltEnabledForMode } from '../../../stores/useGyroSettingsStore';
import { GYRO_TILT_MAX_STEP, subscribeGyroTilt, type GyroTiltOffsets } from './gyroTilt';

// src/components/visualizer/backgrounds/orbitStage.ts
//
// 3D 背景共用的轨道相机：拖动转视角、双指捏合缩放、双击回到初始视角、闲置自动归位。
//
// 底层就是 three 的 OrbitControls —— 町景一直用的也是它（machi/engine/camera.ts 的
// MachiCamera），所以粒子、星河、町景三者的手感是同一套：同样的阻尼、同样的
// 一指转 / 双指缩、同样的触屏行为。以前粒子那套是自己写的 yaw/pitch 累加，
// 没有阻尼、没有惰性，和町景完全不一样，这是重复实现留下的问题。
//
// 和 MachiCamera 的区别只在于「构图」不同：町景是正交投影 + 场景给的一串构图点，
// 要按视口把招牌都框进去；粒子 / 星河是透视相机，站位是固定的。
// 拖拽、限制、归位这些与构图无关的部分两边一致，所以它们才是这里的内容。

/** 拖拽与归位的范围。数值与町景的 MACHI_CAMERA_LIMITS 一致，手感才对得上。 */
export const ORBIT_STAGE_LIMITS = {
    /** 方位角限制（弧度）。比町景窄一点：这两个背景是平面阵列，转太多会看到「背面」。 */
    azimuthRange: (60 * Math.PI) / 180,
    /** 俯仰角范围（弧度）。留出余量，不让相机翻到正上方 / 正下方。 */
    minElevation: (-35 * Math.PI) / 180,
    maxElevation: (52 * Math.PI) / 180,
    /** 缩放倍数范围。 */
    minZoom: 0.62,
    maxZoom: 2.6,
    /** 松手后多久回到初始视角（秒）。与町景的 8 秒一致。 */
    idleReturnSeconds: 8,
} as const;

/** 一道视角。azimuth / elevation 是弧度，zoom 是相对初始距离的倍数。 */
export interface OrbitView {
    azimuth: number;
    elevation: number;
    zoom: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export interface OrbitStageOptions {
    /** 初始距离（相机到目标点）。 */
    distance: number;
    /** 目标点，默认原点。 */
    target?: THREE.Vector3;
    /**
     * 松手后自动回到初始视角。
     *
     * 开着时（默认）用户转到某个角度，松手约 8 秒后镜头缓回初始视角 ——
     * 和町景一致；关掉时视角就停在用户放下的地方。
     */
    autoReturn?: boolean;
    /** 视角变了（每帧至少一次）。 */
    onChange?: () => void;
    /**
     * 这个舞台属于哪个背景（'particles' / 'sonic' …）。
     *
     * 用来查「这个背景自己有没有单独关掉陀螺仪」—— 同一个 OrbitStage 服务好几个背景，
     * 各背景的开关互不影响，所以必须由调用方告诉它是哪一个。
     * 不传就只看全局开关。
     */
    gyroMode?: string;
}

/**
 * 一台通用轨道相机。
 *
 * 用法：
 *   const stage = new OrbitStage(camera, { distance: 2.2 });
 *   stage.attach(hostElement);          // 接上拖拽
 *   stage.setDistance(2.6);             // 转屏时更新
 *   stage.update(dt);                   // 每帧
 *   stage.detach();                     // 卸载
 */
export class OrbitStage {
    private readonly camera: THREE.PerspectiveCamera;
    private readonly options: OrbitStageOptions;
    private controls: OrbitControls | null = null;
    private readonly target: THREE.Vector3;
    private distance: number;
    /** 正在被拖 / 正在惯性滑动。这时不动归位。 */
    private interacting = false;
    /** 松手后经过的秒数。 */
    private idleFor = 0;
    /** 正在缓回初始视角。 */
    private returning = false;
    /** 双击判定：上次按下的时刻与位置。 */
    private lastTapAt = 0;
    private lastTapX = 0;
    private lastTapY = 0;
    private disposed = false;

    /*
     * 陀螺仪适配的偏移状态。
     *
     * target 是读数换算出来的目标偏移，applied 是当前实际叠上去的 ——
     * 两者分开是为了平滑：读数抖，直接照抄会让画面一帧一帧地跳。
     */
    private gyroTarget: GyroTiltOffsets = { azimuth: 0, elevation: 0 };
    private gyroApplied: GyroTiltOffsets = { azimuth: 0, elevation: 0 };
    private unsubscribeGyro: (() => void) | null = null;
    /**
     * ★ 用户摆好的视角（不含陀螺仪偏移）的相机位置。
     *
     * 每帧的流程：撤掉偏移（把这个位置写回去）→ controls.update()
     * （这时 controls 读到的是纯净的用户视角）→ 记下更新后的位置 → 贴上偏移。
     *
     * 用位置向量而不是「把偏移反过来加回去」：球坐标的 phi 有钳制、
     * theta 有边界，反推不回去，每帧差一点点，残留会越积越多，
     * 最后视角卡死在边界上、陀螺仪看着像失效了。
     */
    private userCamera: THREE.Vector3 | null = null;

    constructor(camera: THREE.PerspectiveCamera, options: OrbitStageOptions) {
        this.camera = camera;
        this.options = options;
        this.distance = options.distance;
        this.target = options.target?.clone() ?? new THREE.Vector3(0, 0, 0);
        // 先把相机摆到初始视角，避免第一帧之前画到原点。
        // 位置相对目标点算：星河这类的目标点不在世界原点。
        this.camera.position.copy(this.target).add(new THREE.Vector3(0, 0, options.distance));
        this.camera.lookAt(this.target);
    }

    /** 接上指针：拖拽旋转、双指缩放、双击归位、闲置自动归位。 */
    attach(element: HTMLElement) {
        if (this.controls || this.disposed) return;
        const controls = new OrbitControls(this.camera, element);
        controls.target.copy(this.target);
        /*
         * 这些数值与 MachiCamera.attach 里的一致：
         * 阻尼 0.08、旋转 0.55、缩放 0.8 —— 三个背景的拖拽手感因此完全相同。
         */
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.rotateSpeed = 0.55;
        controls.zoomSpeed = 0.8;
        // 平移关掉：粒子 / 星河是块平面阵列，拖走之后画面会空一半。
        controls.enablePan = false;
        controls.minDistance = this.distance * ORBIT_STAGE_LIMITS.minZoom;
        controls.maxDistance = this.distance * ORBIT_STAGE_LIMITS.maxZoom;
        controls.minPolarAngle = Math.PI / 2 - ORBIT_STAGE_LIMITS.maxElevation;
        controls.maxPolarAngle = Math.PI / 2 - ORBIT_STAGE_LIMITS.minElevation;
        controls.minAzimuthAngle = -ORBIT_STAGE_LIMITS.azimuthRange;
        controls.maxAzimuthAngle = ORBIT_STAGE_LIMITS.azimuthRange;
        /*
         * 触屏：一指转，双指缩放（不要平移 —— 见上）。
         * OrbitControls 默认的 TOUCH 里两指是「推拉平移」，这里改成「缩放」。
         */
        controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };

        controls.addEventListener('start', this.onStart);
        controls.addEventListener('end', this.onEnd);
        element.addEventListener('pointerdown', this.onPointerDown as EventListener);
        element.addEventListener('pointerup', this.onPointerUp);
        element.addEventListener('pointercancel', this.onPointerCancel);
        this.controls = controls;
        controls.update();
    }

    /** 转屏或基准变化时更新初始距离，保持当前的相对缩放。 */
    setDistance(distance: number) {
        if (distance <= 0 || Math.abs(distance - this.distance) < 1e-4) return;
        const current = this.camera.position.distanceTo(this.target);
        const ratio = current / this.distance;
        this.distance = distance;
        if (this.controls) {
            this.controls.minDistance = distance * ORBIT_STAGE_LIMITS.minZoom;
            this.controls.maxDistance = distance * ORBIT_STAGE_LIMITS.maxZoom;
        }
        // 让相机按同样的比例跟过去，否则转屏时画面会突然拉近 / 推远。
        const next = clamp(distance * ratio, distance * ORBIT_STAGE_LIMITS.minZoom, distance * ORBIT_STAGE_LIMITS.maxZoom);
        const direction = this.camera.position.clone().sub(this.target).normalize();
        this.camera.position.copy(this.target).addScaledVector(direction, next);
    }

    /** 立刻回到初始视角（不带缓动）。 */
    reset() {
        this.returning = false;
        this.idleFor = 0;
        this.camera.position.copy(this.target).add(new THREE.Vector3(0, 0, this.distance));
        this.camera.lookAt(this.target);
        this.controls?.target.copy(this.target);
        this.controls?.update();
        this.options.onChange?.();
    }

    /** 平滑回到初始视角，走缓动（双击用它）。 */
    recenter() {
        if (!this.controls) {
            this.reset();
            return;
        }
        this.returning = true;
        this.idleFor = 0;
    }

    /** 当前是否停在初始视角（差得很小）。 */
    isAtHome(): boolean {
        const offset = this.camera.position.clone().sub(this.target);
        const distance = offset.length();
        const azimuth = Math.atan2(offset.x, offset.z);
        const elevation = Math.asin(clamp(offset.y / Math.max(1e-5, distance), -1, 1));
        return Math.abs(azimuth) < 0.02
            && Math.abs(elevation) < 0.02
            && Math.abs(distance - this.distance) < this.distance * 0.02;
    }

    /** 每帧推进：阻尼、闲置计时、归位缓动。 */
    update(dt: number) {
        if (this.disposed) return;
        const controls = this.controls;
        if (controls) {
            /*
             * 归位：把相机和目标点都往初始位置插值。
             *
             * 用指数趋近而不是线性，帧率变化时观感一致。
             * 速度比拖拽的阻尼慢一些 —— 回正是一段看得见的动画，不是瞬间跳回去。
             */
            if (this.returning) {
                /*
                 * 归位期间同样要先撤掉陀螺仪偏移。
                 *
                 * 不撤的话，camera.position 里带着偏移，lerp 归位的起点就是偏的，
                 * 归到位之后下一帧的 controls.update() 又把偏移当成用户视角吸进去 ——
                 * 双击回正之后视角会莫名其妙地歪一边。
                 */
                this.clearGyroOffset(controls.target);
                const t = 1 - Math.exp(-5.2 * Math.min(0.1, Math.max(0, dt)));
                this.camera.position.lerp(this.target.clone().add(new THREE.Vector3(0, 0, this.distance)), t);
                controls.target.lerp(this.target, t);
                controls.update();
                this.userCamera = this.camera.position.clone();
                if (this.isAtHome()) {
                    this.returning = false;
                    this.idleFor = 0;
                }
                this.options.onChange?.();
                return;
            }
            /*
             * ★ 撤掉上一帧的陀螺仪偏移，再让 controls 更新。
             *
             * OrbitControls 的 update() 是从 **camera.position** 反推自己的球坐标的
             * （它不知道偏移这件事）。所以只要我们把偏移写进 camera.position，
             * 下一次 update() 就会把这份偏移当成「用户转出来的视角」吸收进去 ——
             * 于是每帧多吸一次，视角一路往一个方向跑、最后顶到边界，
             * 用户的拖动也会被立刻拽回去（「可以拖动但是还是会被陀螺仪强制拉」）。
             *
             * 顺序必须是：撤掉旧偏移 → controls.update() → 记下纯用户视角
             * → 加上新偏移。
             */
            this.clearGyroOffset(controls.target);
            controls.update();
            /*
             * 记下「纯用户视角」的相机位置，供下一帧撤销偏移时写回。
             * controls.update() 刚算完，这时相机位置就是用户拖出来的那份。
             */
            this.userCamera = this.camera.position.clone();
            /*
             * 陀螺仪适配：把手机构图倾斜叠在轨道视角上。
             *
             * 它只是「叠在」用户摆好的视角之上，不改 controls 自己的状态 ——
             * 所以松手、回正、双击归位这些行为都不受影响；关掉开关时偏移
             * 自己缓回零，镜头就回到原来的机位。
             *
             * 全局开关见 stores/useGyroSettingsStore，四个 3D 背景共用一份。
             */
            this.stepGyroTilt(dt);
            /*
             * ★ 没有「闲置自动回正」。
             *
             * 早先抄町景的做法：松手 8 秒后镜头自己缓回初始视角。但那是在
             * 用户明确想把视角停在某处时很烦人的行为 —— 刚看好的角度过一会儿
             * 自己跑了。现在视角只在用户双击时归位（见 recenter），放着不动就
             * 一直是用户自己摆的那个角度。
             */
            this.options.onChange?.();
        }
    }

    /**
     * 陀螺仪适配：把手机倾斜叠到相机上。
     *
     * 只改相机的方位角 / 极角，**不动** controls 的 target 和距离 ——
     * 缩放和归位逻辑因此完全不受影响。偏移每帧往里追一点（读数抖，直接
     * 照抄会一跳一跳），关掉开关或读数归零时也自然缓回原机位。
     *
     * 方位角在 OrbitControls 的 min/maxAzimuthAngle 之外还可能被用户拖到边界，
     * 叠加后不重新夹取：夹了会让「拖到边界 + 歪手机」时手感变硬。这里只保证
     * 极角不穿过两极（穿过去画面会翻滚）。
     */
    private stepGyroTilt(dt: number) {
        const controls = this.controls;
        if (!controls) return;

        const enabled = readGyroTiltEnabledForMode(this.options.gyroMode);
        if (!enabled) {
            /*
             * 关掉时把目标归零，让偏移自己缓回去。
             * 退订放在目标归零之后：读数不再进来，但缓动还要继续跑。
             */
            this.gyroTarget.azimuth = 0;
            this.gyroTarget.elevation = 0;
            if (this.unsubscribeGyro) {
                this.unsubscribeGyro();
                this.unsubscribeGyro = null;
            }
        } else if (!this.unsubscribeGyro) {
            this.unsubscribeGyro = subscribeGyroTilt((offsets) => {
                this.gyroTarget.azimuth = offsets.azimuth;
                this.gyroTarget.elevation = offsets.elevation;
            });
        }

        /*
         * 撤掉旧偏移这件事由 update() 在 controls.update() 之前做了
         * （见那里的注释：controls 是从 camera.position 反推球坐标的，
         *  偏移留在那里会被它当成用户视角吸收进去）。
         *
         * 所以下面**无条件**把当前的 applied 贴回去 —— 哪怕偏移没在变，
         * 也要把刚才撤掉的那一份补上，否则偏移会凭空消失。
         */
        const moving = Math.abs(this.gyroTarget.azimuth - this.gyroApplied.azimuth) > 1e-4
            || Math.abs(this.gyroTarget.elevation - this.gyroApplied.elevation) > 1e-4;

        /*
         * ★ 用户正在拖的时候不叠加偏移。
         *
         * 拖动是明确的动作，这一刻手机怎么歪都不该跟它抢方向盘 ——
         * 用户反馈「可以拖动但是还是会被陀螺仪强制拉」，正是这个。
         * 拖动期间目标压到零（偏移淡回），松手之后重新读数、从零开始贴。
         */
        if (this.interacting) {
            this.gyroTarget.azimuth = 0;
            this.gyroTarget.elevation = 0;
        }

        /*
         * 指数趋近 + 单帧步长上限：读数突变时不会一下子把镜头甩出去。
         *
         * ★ 3.6（约 0.28 秒的跟随时间常数）。
         *
         * 走过 9.0（太跟手，噪声全进画面）、2.6（稳但显得迟钝，
         * 用户反馈「根本看不出来」）、现在 3.6：读数本身已经被低通滤过一遍，
         * 这里不必再压得那么慢，倾斜手机时画面能及时跟上。
         */
        const t = 1 - Math.exp(-3.6 * Math.min(0.1, Math.max(0, dt)));
        const follow = (current: number, target: number) => {
            const next = current + (target - current) * t;
            const step = next - current;
            return current + Math.min(GYRO_TILT_MAX_STEP, Math.max(-GYRO_TILT_MAX_STEP, step));
        };
        if (moving) {
            this.gyroApplied.azimuth = follow(this.gyroApplied.azimuth, this.gyroTarget.azimuth);
            this.gyroApplied.elevation = follow(this.gyroApplied.elevation, this.gyroTarget.elevation);
        }

        this.applyGyroOffset(this.gyroApplied.azimuth, this.gyroApplied.elevation);
        this.options.onChange?.();
    }

    /**
     * 撤掉相机上的陀螺仪偏移，让它回到 controls 自己的视角。
     *
     * 必须在 controls.update() **之前**调用：controls 是从 camera.position
     * 反推球坐标的，偏移留在那里就会被当成用户转出来的视角吸收进去
     * （每一帧吸一次 → 视角越跑越远 → 拖动被强行拽回）。
     */
    private clearGyroOffset(target: THREE.Vector3) {
        if (!this.userCamera) return;
        this.camera.position.copy(this.userCamera);
        this.camera.lookAt(target);
    }
    /**
     * 把偏移贴到相机上。
     *
     * 不改 controls 的任何状态：偏移只存在于 camera.position 上，
     * 而它每帧都会被下一次 update() 之前先撤掉。
     */
    private applyGyroOffset(azimuth: number, elevation: number) {
        const offset = this.camera.position.clone().sub(this.target);
        const spherical = new THREE.Spherical().setFromVector3(offset);
        spherical.theta += azimuth;
        spherical.phi = Math.min(Math.PI - 0.05, Math.max(0.05, spherical.phi - elevation));
        this.camera.position.copy(this.target).add(offset.setFromSpherical(spherical));
        this.camera.lookAt(this.target);
    }

    detach() {
        if (this.disposed) return;
        this.disposed = true;
        this.unsubscribeGyro?.();
        this.unsubscribeGyro = null;
        const element = this.controls?.domElement;
        element?.removeEventListener('pointerdown', this.onPointerDown as EventListener);
        element?.removeEventListener('pointerup', this.onPointerUp);
        element?.removeEventListener('pointercancel', this.onPointerCancel);
        this.controls?.removeEventListener('start', this.onStart);
        this.controls?.removeEventListener('end', this.onEnd);
        this.controls?.dispose();
        this.controls = null;
    }

    private readonly onStart = () => {
        this.interacting = true;
        this.returning = false;
        this.idleFor = 0;
    };

    private readonly onEnd = () => {
        this.interacting = false;
        this.idleFor = 0;
    };

    /**
     * 双击归位。
     *
     * OrbitControls 自己处理一指点按（旋转的起点），但它不知道「双击」这个手势，
     * 所以这里只补这一层：两次按下在 300 ms 内、位置相差 14 px 以内就算双击。
     * 缩放不在这里做 —— 双指捏合是 OrbitControls 的 TOUCH.DOLLY_ROTATE，
     * 它自己按距离比例改相机距离，这边再算一遍就会双倍缩放。
     */
    private readonly onPointerDown = (event: PointerEvent) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        const now = performance.now();
        const near = Math.abs(event.clientX - this.lastTapX) <= 14 && Math.abs(event.clientY - this.lastTapY) <= 14;
        const quick = now - this.lastTapAt > 0 && now - this.lastTapAt <= 300;
        if (near && quick) {
            this.recenter();
            this.lastTapAt = 0;
            return;
        }
        this.lastTapAt = now;
        this.lastTapX = event.clientX;
        this.lastTapY = event.clientY;
    };

    private readonly onPointerUp = () => undefined;

    private readonly onPointerCancel = () => {
        this.interacting = false;
    };
}
