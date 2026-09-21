// src/types/ponder.ts
// 「思索」教程系统的跨层合同：目标注册、场景 DSL、编译产物。
//
// 放在 types 而不是 components/ponder 下，是因为 store（离散会话状态）、utils（锚点解析与
// 时间线编译）、hooks（悬停与长按状态机）和组件层都要引用同一批类型；任何一边单独持有都会
// 让另外三边反向依赖它。
//
// 这里只有类型和字面量常量，没有 DOM、没有 animejs —— vitest 跑在 node 环境（vitest.config.ts:17），
// 依赖这份合同的纯函数必须能在没有 window 的情况下被单测。

/** 可教学区域。新增一个 target 要同时在这里登记 id，注册表才认。 */
export type PonderTargetId =
    | 'panel-slide'
    | 'command-palette-help'
    | 'bottom-bar-offset'
    | 'control-slots'
    | 'shuffle'
    | 'volume';

/** 悬停提示的三档可见性。 */
export type PonderHintVisibility = 'always' | 'unseen' | 'off';

export const PONDER_HINT_VISIBILITY_VALUES: readonly PonderHintVisibility[] = ['always', 'unseen', 'off'];

export const isPonderHintVisibility = (value: unknown): value is PonderHintVisibility => (
    typeof value === 'string' && (PONDER_HINT_VISIBILITY_VALUES as readonly string[]).includes(value)
);

/**
 * 视口坐标下的矩形，单位 px。骨架层画的每个框最终都是它。
 *
 * radius 是从真实元素上量来的 border-radius 原样字符串：圆形按钮要得到圆形骨架，
 * 靠的是量而不是靠场景脚本去描述形状 —— 描述一遍就会和真实组件走散。
 */
export type PonderRect = {
    left: number;
    top: number;
    width: number;
    height: number;
    radius?: string;
};

/** 按视口比例表达的矩形，给进入时不在 DOM 里的元素用。anchorX/anchorY 决定 left/top 是边还是中心。 */
export type PonderViewportRect = {
    left: number;
    top: number;
    width: number;
    height: number;
    anchorX?: 'left' | 'center' | 'right';
    anchorY?: 'top' | 'center' | 'bottom';
};

/** 锚在某个骨架框上的一个点：归一化坐标 + 像素偏移。光标和字幕的落点都用它。 */
export type PonderAnchorPoint = {
    anchor: string;
    /** 0..1，默认 0.5 */
    x?: number;
    /** 0..1，默认 0.5 */
    y?: number;
    offset?: { x?: number; y?: number };
};

/**
 * 一个骨架框的来源。
 *
 * `dom` 是「按真实 DOM 矩形生成骨架」那条决定的落点：进入瞬间量一次，之后不再订阅。
 * `derived` 给那些量不到、但几何完全由另一个框确定的东西（滑轨宽度写死、判定线在按钮左 36px）；
 * 推导比查询稳，还不受目标元素显隐状态影响。
 * `synthetic` 给进入时根本不在场的元素（尚未打开的命令面板、音量面板）。
 */
/**
 * 骨架框画成什么样。纯色块读起来像色块，不像界面 —— 角色决定它的边框、内部纹理和标签位置。
 */
export type PonderAnchorRole =
    /** 一个面板/容器，画成带标题栏和几行占位内容的面。 */
    | 'surface'
    /** 一个可按的控件，画成圆角实心小块。 */
    | 'control'
    /** 一条轨道/滑槽，画成细长的胶囊。 */
    | 'rail'
    /** 一条判定线/刻度，画成一根竖线，不画框。 */
    | 'marker';

type PonderAnchorCommon = {
    /** 骨架上给这个框标的名字。不给就不标。 */
    labelKey?: string;
    /** 默认 'control'。 */
    role?: PonderAnchorRole;
    /**
     * 标签放哪。默认 surface 放框内左上，其余放框上方。
     * 互相嵌套的框（按钮和包着它的滑轨）必须显式错开，否则两个标签会叠在一起。
     */
    labelPlacement?: 'above' | 'below' | 'inside';
};

export type PonderAnchorSource = PonderAnchorCommon & (
    | { kind: 'dom'; selector: string; fallback?: PonderViewportRect }
    | { kind: 'synthetic'; rect: PonderViewportRect }
    | {
          kind: 'derived';
          from: string;
          /** 四边各自外扩的 px，可为负。 */
          expand?: { left?: number; right?: number; top?: number; bottom?: number };
          /** 给了 at + size 就只取 from 上的一个点，再按 size 画框。 */
          at?: PonderAnchorPoint;
          size?: { width: number; height: number };
      }
);

type PonderStepBase = {
    id: string;
    /** true = 与上一步同时开始，而不是接在它后面。字幕配动作全靠它。 */
    withPrevious?: boolean;
    /** true = 这一步的起点是一个关键帧，进度条上画刻度，←/→ 跳到它。 */
    keyframe?: boolean;
};

/**
 * 场景原语。
 *
 * `drag` 和 `highlight` 是在 caption / cursor / keypress / pausePoint 四个之外加的：
 * 面板滑动和底栏拖高两个场景的主体就是拖，而 `highlight` 是「这个框现在重要」的唯一表达方式 ——
 * 骨架框本身是静态的，没有它就只有光标在动、看不出在动谁。
 */
export type PonderStep =
    | (PonderStepBase & {
          kind: 'caption';
          textKey: string;
          at: PonderAnchorPoint | 'bottom';
          durationMs: number;
          /**
           * 从字幕引一条线指向这个点，并在终点画一个小圈。
           * 原版 Ponder 的说明文字总是连着它在讲的那个东西 —— 没有这条线，
           * 一段居中的字幕和画面上五个框之间就没有任何对应关系。
           */
          pointTo?: PonderAnchorPoint;
      })
    | (PonderStepBase & {
          kind: 'cursor';
          to: PonderAnchorPoint;
          from?: PonderAnchorPoint;
          durationMs: number;
          ease?: string;
          press?: 'down' | 'up' | 'tap';
      })
    | (PonderStepBase & { kind: 'drag'; from: PonderAnchorPoint; to: PonderAnchorPoint; durationMs: number; ease?: string })
    | (PonderStepBase & { kind: 'keypress'; keys: string[]; at: PonderAnchorPoint | 'bottom'; durationMs: number })
    | (PonderStepBase & { kind: 'highlight'; anchor: string; intensity?: [number, number]; durationMs: number })
    /** pausePoint：短暂停留后自动继续。必然是关键帧，不需要显式写 keyframe。 */
    | (PonderStepBase & { kind: 'pause'; dwellMs?: number });

/** pausePoint 的默认停留时长。留给读字幕，短了会逼着人倒回去重看。 */
export const PONDER_DEFAULT_DWELL_MS = 1400;

/** 一段场景跑完后、显示「下一章」卡片之前的停顿。 */
export const PONDER_DEFAULT_LOOP_DELAY_MS = 600;

/**
 * 高亮填充的最大不透明度。
 *
 * DSL 里的 intensity 是 0..1 的「有多亮」，落到画面上要乘这个系数：直接用 1.0 画主题色
 * 会得到一整块纯色，骨架就不再是骨架了。
 */
export const PONDER_HIGHLIGHT_MAX_OPACITY = 0.3;

export type PonderSceneScript = {
    id: string;
    titleKey: string;
    anchors: Record<string, PonderAnchorSource>;
    steps: PonderStep[];
    loopDelayMs?: number;
};

export type PonderTargetDefinition = {
    id: PonderTargetId;
    /** i18n key，标题栏「⌨ 思索 · <名称>」和命令面板列表共用。 */
    titleKey: string;
    /**
     * 悬停命中用的选择器。`null` 表示这个目标在真实 DOM 里没有稳定落点，
     * 只能从命令面板的思索列表进入。
     */
    hoverSelector: string | null;
    /**
     * 此刻教它有没有意义。必须和被教组件自己的启用判断读同一个真源，
     * 否则会出现「面板已展开、滑动手势本身是关的，却还在提示教它」。
     */
    isAvailable?: () => boolean;
    scenes: PonderSceneScript[];
};

/** compilePonderScene 的产物：铺平后的时间线，不含任何动画库概念。 */
export type PonderTimelineEntry = { step: PonderStep; atMs: number; durationMs: number };

export type PonderKeyframe = { stepId: string; atMs: number };

export type PonderTimelinePlan = {
    totalMs: number;
    entries: PonderTimelineEntry[];
    keyframes: PonderKeyframe[];
};
