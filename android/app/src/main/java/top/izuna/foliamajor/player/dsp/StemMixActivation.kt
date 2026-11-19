package top.izuna.foliamajor.player.dsp

import kotlin.math.abs

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/StemMixActivation.kt
// 四轨混音到底要不要开：三级判据。
//
// 四轨混音是「按分轨出声」这条路的唯一实现 —— 清唱、伴奏、以及调音台里对**单条音轨**
// 的摆位（空间声场 / 逐轨电平 / 关掉某一轨）都靠它。但它不是免费的：每开一次要
// 建 4 个 MediaCodec、每块解 4 路，还要多几 MB 常驻。所以只在**真的需要分轨**时才开：
//
//   1. 开了「关闭人声 / 只留人声」（[VocalTrackMode] 非空）→ 必须混；
//      这是 A 的核心用途，原曲里拿不掉某一轨，只能播分轨。
//   2. 调音台要用到分轨：四轨里**有任意一轨的摆位非中性**（pan / width / levelDb
//      动过，或者干脆把某一轨关掉）→ 混（B）。判据比「空间声场开关开着」精确：
//      用户可能只是打开了那个面板、所有轨都还是默认值，那时既听不出区别、
//      也没必要付 4 个解码器的代价。
//   3. 其余情况（调音台没开，或开着但四轨全中性）→ **走原曲，不混**。
//      原曲本身就是四轨的和，再混一遍只是拿四份 AAC 近似值替换一条原始流。
//
// 判据是纯函数，音频线程每块调一次（只是读几个 float，不进循环）。

/** 判据结果：为什么要混（[NONE] 表示不混，走原曲）。 */
enum class StemMixReason {
    /** 没有任何理由用分轨：原曲直接播。 */
    NONE,

    /** 「关闭人声 / 只留人声」开着：必须按模式挑轨。 */
    VOCAL_MODE,

    /** 调音台对某几轨做了摆位调整：需要分轨才能做，且原曲里做不出来。 */
    SPATIAL_PLACEMENT,
}

object StemMixActivation {

    /** pan 差这么一点就算动过（-1 ~ 1 的滑杆，0.001 是人手抖不出来的量级）。 */
    private const val PAN_EPSILON = 0.001f

    /** width 差这么多就算动过（0 ~ 2；1 是原样）。 */
    private const val WIDTH_EPSILON = 0.001f

    /** 电平差这么多 dB 就算动过（-24 ~ +6；0 是原样）。 */
    private const val LEVEL_EPSILON = 0.01f

    /**
     * 三级判据。返回 [StemMixReason.NONE] 表示这一块该走原曲。
     *
     * @param mode     此刻的播放模式（「关闭人声」/ 「只留人声」/ 都没开）。
     * @param settings 四轨此刻的摆位设置（调音台写进来的；没有界面时是 NEUTRAL）。
     */
    fun reason(mode: VocalTrackMode?, settings: StemMixSettings): StemMixReason = when {
        // ① 用户要「少一轨 / 只留一轨」：原曲做不到，只能混分轨。
        mode != null -> StemMixReason.VOCAL_MODE
        // ② 调音台真的在动某一轨：同理，原曲做不到「只把鼓推左」。
        isSpatialPlacementActive(settings) -> StemMixReason.SPATIAL_PLACEMENT
        // ③ 其余情况：原曲就是四轨的和，没有任何理由再解一遍。
        else -> StemMixReason.NONE
    }

    /** 四轨里有没有任意一轨被调得不是默认值（含「某一轨被关掉」）。 */
    fun isSpatialPlacementActive(settings: StemMixSettings): Boolean =
        StemKind.ALL.any { isPlaced(settings.resolve(it)) }

    /**
     * 这一轨的摆位是不是非默认。
     *
     * 「关掉某一轨」（audible = false）也算：那同样只有分轨才能做到 —— 原曲里
     * 没有「去掉贝斯」这个操作。
     */
    fun isPlaced(stem: StemSpatialSettings): Boolean =
        !stem.audible ||
            abs(stem.pan) > PAN_EPSILON ||
            abs(stem.width - 1f) > WIDTH_EPSILON ||
            abs(stem.levelDb) > LEVEL_EPSILON
}
