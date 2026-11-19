package top.izuna.foliamajor.player.dsp

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/StemMixSettings.kt
// 四轨混音这一路自己的设置：每个音轨的摆位、要不要响。
//
// 为什么单独一个文件、而不是塞进 EqSettings：EQ / 压缩 / 混响那条链做的是「整首混音」
// 的音色，这里做的是「这首歌由哪几轨、各在哪个位置组成」。四轨是空的（这首歌没拆过）
// 时这些值完全不存在，两者的生命周期不一样。
//
// 现在这四个值还没有界面：只有 NEUTRAL（原样、全响）。PLAYBACK_MODES 说明它在
// 整个链上的位置 —— 调音台那半（母带 / 空间 / 工作室 / 修复）由 #431 另行落地，
// 不要在这里加回去。

/**
 * 单条音轨的摆位。
 *
 * @param audible 这一轨参不参与混音（关掉就是「这条轨不要」）。
 * @param pan     声像，-1 全左、0 居中、1 全右（等功率）。
 * @param width   这一轨自己的 M/S 宽度，0 单声道、1 原样、2 加倍。
 * @param levelDb 这一轨的电平，-24 ~ +6 dB。
 */
class StemSpatialSettings(
    val audible: Boolean = true,
    val pan: Float = 0f,
    val width: Float = 1f,
    val levelDb: Float = 0f,
) {
    companion object {
        val NEUTRAL = StemSpatialSettings()
    }
}

/**
 * 四轨混音的设置：每个音轨各一份摆位。
 *
 * [resolve] 是音频线程每块调的那个：返回这一轨此刻该用的摆位。
 */
class StemMixSettings(
    val drums: StemSpatialSettings = StemSpatialSettings.NEUTRAL,
    val bass: StemSpatialSettings = StemSpatialSettings.NEUTRAL,
    val other: StemSpatialSettings = StemSpatialSettings.NEUTRAL,
    val vocals: StemSpatialSettings = StemSpatialSettings.NEUTRAL,
) {

    /** 这一轨此刻的摆位；四轨都是原样，离线调参时改这里。 */
    fun resolve(kind: StemKind): StemSpatialSettings = when (kind) {
        StemKind.DRUMS -> drums
        StemKind.BASS -> bass
        StemKind.OTHER -> other
        StemKind.VOCALS -> vocals
    }

    /** 四轨都原样全响：此时混音就是原曲的近似，不需要额外处理。 */
    fun isNeutral(): Boolean = StemKind.ALL.all { resolve(it) === StemSpatialSettings.NEUTRAL }

    companion object {
        val NEUTRAL = StemMixSettings()

        /**
         * 「空间声场」的自动摆位。
         *
         * 不做花哨的移动：鼓与「其他」稍稍拉开、贝斯收窄、人声居中 —— 这是让四轨
         * 听上去不糊的最小一组值，用户可调的范围见 [StemSpatialSettings] 的注释。
         */
        val AUTO_STEMS: Map<StemKind, StemSpatialSettings> = mapOf(
            StemKind.DRUMS to StemSpatialSettings(audible = true, pan = 0f, width = 1.35f, levelDb = 0f),
            StemKind.BASS to StemSpatialSettings(audible = true, pan = 0f, width = 0.85f, levelDb = 0f),
            StemKind.OTHER to StemSpatialSettings(audible = true, pan = 0f, width = 1.2f, levelDb = 0f),
            StemKind.VOCALS to StemSpatialSettings(audible = true, pan = 0f, width = 1f, levelDb = 0f),
        )
    }
}
