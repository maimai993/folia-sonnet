// src/components/visualizer/colorMix.ts
//
// 转发层，实现只有一份：src/utils/visualizer/colorMix.ts。
//
// 这两个文件曾经各存一份同样的色彩数学，然后各自长歪了 —— utils 那版丢了
// rememberBounded 的 undefined 兜底，于是同一首歌下不同的歌词样式可能算出不同的颜色。
// 现在统一走 utils：零依赖的色彩数学谁都能用，utils 也不该反向依赖 components。
//
// 保留这个文件是因为改动量最小、且不打断还在用旧路径的调用点；新代码直接 import
// `src/utils/visualizer/colorMix`。等旧调用点都换完，这个文件就可以删了。
export {
    colorWithAlpha,
    mixColors,
    parseColorChannels,
    resolveGlowColorStrength,
} from '../../utils/visualizer/colorMix';
