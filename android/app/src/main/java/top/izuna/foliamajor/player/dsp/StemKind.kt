package top.izuna.foliamajor.player.dsp

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/StemKind.kt
// SCNet 分出的四个音轨。顺序与 ScnetRunner.STEMS 一致，改这里要改那边。
//
// 清唱 = 人声轨、伴奏 = 鼓 + 贝斯 + 其他、全部 = 四轨一起，播放时都由
// StemMixProcessor 按模式实时混音，每个音轨一个文件。

enum class StemKind(val suffix: String) {
    DRUMS(".drums.m4a"),
    BASS(".bass.m4a"),
    OTHER(".other.m4a"),
    VOCALS(".vocals.m4a");

    companion object {
        val ALL: List<StemKind> = entries

        /** 伴奏 = 鼓 + 贝斯 + 其他；清唱 = 人声。 */
        fun forInstrumental(): List<StemKind> = listOf(DRUMS, BASS, OTHER)
    }
}
