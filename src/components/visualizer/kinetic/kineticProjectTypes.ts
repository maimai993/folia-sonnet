// src/components/visualizer/kinetic/kineticProjectTypes.ts
// 文字PV 原版工程快照的字段形状：宿主与渲染页共用，存进 kineticProjectMemory 的就是它。

/** 原版引擎能接受、且确实影响画面的那些字段。 */
export type KineticProjectSnapshot = {
    /** 歌词 LRC 文本。 */
    lyrics?: string;
    /** 编辑时宿主的原始 LRC：仅同一源歌词可还原手工改词，旧存档无此字段不覆盖宿主。 */
    sourceLyrics?: string;
    /** 原版样式 id（'noir' 等）。 */
    style?: string;
    /** 随机种子：决定布局编排。 */
    seed?: number;
    /** 构图比例（'16:9' / '9:16' / '1:1' 等）。 */
    aspect?: string;
    /** 设计分辨率短边。 */
    res?: number;
    /** 引擎出帧帧率。 */
    fps?: number;
    /** 特效强度开关（motion / glitch / chroma / decor / density / texture …）。 */
    fx?: Record<string, unknown>;
    /** 时间轴（bpm / offset / lineScale / lineTimes）。 */
    timing?: Record<string, unknown>;
    /** 配色（bg / fg / sub / accent / ghostA / ghostB + enabled / accentOn）。 */
    colors?: Record<string, unknown>;
    /** 字体角色（display / serif / body）。 */
    fonts?: Record<string, unknown>;
    /** folia 主题的 AI 关键字高亮色。 */
    wordColors?: { word: string; color: string }[];
    /** 逐行覆盖（布局、切数、种子锁定等）。 */
    overrides?: Record<string, unknown>;
    /** 语言。 */
    lang?: string;
    /**
     * 编辑台算好的完整排版（J.plan 的输出）。
     *
     * 必须存下来。只存上面的参数是不够的：J.plan 依赖音频 beats、背景使用历史、
     * 随机历史、逐行锁定的顺序这些运行时状态，同样的参数在播放页重算一遍结果会变 ——
     * 那就是「编辑完是好的，重启之后完全不一样」的原因。
     * 存了这份 plan，重启后播放页直接照它画，和编辑台里看到的一模一样。
     *
     * 数据量比其余字段大一个量级（含整份 cuts），所以单独放，读取失败也不影响别的字段。
     */
    plan?: Record<string, unknown>;
};
