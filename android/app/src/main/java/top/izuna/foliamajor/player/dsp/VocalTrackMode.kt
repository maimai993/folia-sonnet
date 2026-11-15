package top.izuna.foliamajor.player.dsp

/**
 * 一次分离会同时写出两首：去掉人声的伴奏、只留人声的清唱。
 *
 * 为什么一起写：两样都要跑同一遍 SCNet 推理（几个窗口的 CPU 大头），
 * 分开生成就是同一首歌跑两遍模型。多写一路 AAC 的代价不到 5%。
 * 伴奏沿用旧文件名 `.m4a`，老缓存不用重算。
 *
 * 单独放在顶层而不是 InstrumentalStore 里：NativeEqualizerState 是 public，
 * 它要返回这个类型，internal object 的嵌套类型会把它自己也「染」成 internal。
 */
enum class VocalTrackMode(val suffix: String) {
    INSTRUMENTAL(".m4a"),
    VOCAL(".vocal.m4a"),
}
