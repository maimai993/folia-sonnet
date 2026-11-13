// src/services/mvRequirement.ts
//
// 「有没有哪一款背景要求画面」这一件事的中立入口。
//
// 背景样式不认识任何一家视频站：它要说的只是「我这款样式需要画面」。谁提供画面、
// 开关叫什么、登录态怎么样，全是视频层自己的事。所以这里只留一个登记位 ——
// 视频层启动时把自己的 setter 挂上来，样式只往这里写一个布尔值。
//
// 以前是样式直接 import 那一家的 store：一个纯视觉组件于是知道了那家平台的名字，
// 那份目录规则（平台名只待在自己的文件夹里）就守不住了。

type Setter = (required: boolean) => void;

let sink: Setter | null = null;

/** 视频层挂上来；返回一个摘掉的函数。 */
export const registerMvRequirementSink = (setter: Setter): (() => void) => {
    sink = setter;
    return () => {
        if (sink === setter) sink = null;
    };
};

/**
 * 样式要求 / 不再要求画面。
 *
 * 视频层还没挂上来时什么都不做 —— 那种情况只会发生在它根本没加载的平台上，
 * 那时也没有画面可要求。
 */
export const setMvRequiredByStyle = (required: boolean): void => {
    sink?.(required);
};
