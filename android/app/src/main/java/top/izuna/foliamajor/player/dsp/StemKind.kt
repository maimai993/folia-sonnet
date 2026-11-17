package top.izuna.foliamajor.player.dsp

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/StemKind.kt
// SCNet 分出的四个音轨。顺序与 ScnetRunner.STEMS 一致，改这里要改那边。
//
// 与 VocalTrackMode 的分工：VocalTrackMode 是「播放器此刻只装一个分离结果」的
// 两轨换源路径（伴奏 / 清唱）；StemKind 是「四个音轨各自可摆位、一起混」的
// 空间声场路径。前者继续用旧文件名，后者每个音轨一个文件。

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
