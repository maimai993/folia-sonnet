package top.izuna.foliamajor.player.dsp

import kotlin.math.abs

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/TenBandEq.kt
// 一套十段均衡器 —— 前置与后置共用同一份实现。
//
// 为什么抽出来：调音台里有两个十段（压缩之前的前置 EQ、压缩之后的后置 EQ），
// 两者只是挂的位置不同，滤波与增益的逻辑一模一样。写两遍的话，将来改 Q 的映射
// 或补偿增益时一定会漏掉一处，听感上就变成「前后两个 EQ 曲线不一样」。
//
// 两种曲线形状：
//   · GEQ（图形均衡）—— 首段 lowshelf、末段 highshelf、中间 peaking，Q 固定 1.4。
//     这是 Web 侧 `connectAudioEqualizerGraph` 的做法，也是老用户听惯的那条曲线。
//   · PEQ（参数均衡）—— 十段全部 peaking，Q 由滑杆给（0.3 ~ 8）。
//     窄 Q 只动一个音，宽 Q 会连带邻居，适合修共振而不是调音色。
//
// 线程：只在音频渲染线程上调用。系数只在参数真的变了的那一块重算（判重在 [update] 里），
// 拖滑杆时每块一次 cos/sin，静止时零开销。

class TenBandEq {

    private val bands = Array(EQ_BAND_COUNT) { BiquadFilter() }

    private var sampleRate = 0
    private var globalGain = 1f

    /** 上一次算系数用的参数：一样就跳过重算。 */
    private val lastGains = FloatArray(EQ_BAND_COUNT) { Float.NaN }
    private var lastMode = -1
    private var lastQ = Float.NaN
    private var lastGlobalGainDb = Float.NaN

    fun configure(sampleRate: Int) {
        this.sampleRate = sampleRate
        lastGains.fill(Float.NaN)
        lastMode = -1
        lastQ = Float.NaN
        lastGlobalGainDb = Float.NaN
        reset()
    }

    /** seek / flush / 开关切换：清掉滤波器状态，否则新位置的头几毫秒会带着旧的尾巴。 */
    fun reset() {
        bands.forEach { it.reset() }
    }

    /**
     * 把一份参数搬进滤波器。参数没变时立刻返回 —— 这个方法每 128 帧调一次。
     *
     * @param gains 十段增益（dB），长度不足按 0 处理
     * @param mode [EqCurveMode]
     * @param q PEQ 的 Q；GEQ 忽略
     * @param globalGainDb 十段之外的总增益
     */
    fun update(gains: FloatArray, mode: Int, q: Float, globalGainDb: Float) {
        if (sampleRate <= 0) return
        val qUsed = if (mode == EqCurveMode.PEQ) q.coerceIn(EQ_MIN_Q, EQ_MAX_Q) else EQ_BAND_Q
        if (mode == lastMode && qUsed == lastQ && globalGainDb == lastGlobalGainDb && sameGains(gains)) {
            return
        }

        lastMode = mode
        lastQ = qUsed
        lastGlobalGainDb = globalGainDb
        globalGain = dbToLinear(globalGainDb)
        for (index in 0 until EQ_BAND_COUNT) lastGains[index] = gains[index]

        for (index in 0 until EQ_BAND_COUNT) {
            val gain = gains[index]
            val frequency = EQ_BAND_FREQUENCIES[index]
            val filter = bands[index]
            if (mode == EqCurveMode.PEQ) {
                // PEQ 的十段都是钟形：首末两段在 31 / 16k，钟形的另一半落在带外，
                // 效果与 shelf 接近，但不会把整个低频/高频一起抬起来。
                filter.setPeaking(sampleRate, frequency, qUsed, gain)
            } else {
                when (index) {
                    0 -> filter.setLowShelf(sampleRate, frequency, gain)
                    EQ_BAND_COUNT - 1 -> filter.setHighShelf(sampleRate, frequency, gain)
                    else -> filter.setPeaking(sampleRate, frequency, EQ_BAND_Q, gain)
                }
            }
        }
    }

    /** 十段是否与上次算系数时一样。手写循环：数组没有带范围的 contentEquals。 */
    private fun sameGains(gains: FloatArray): Boolean {
        for (index in 0 until EQ_BAND_COUNT) {
            val previous = lastGains[index]
            // NaN 是「还没算过」的标记，永远算不相等。
            if (previous.isNaN() || previous != gains[index]) return false
        }
        return true
    }

    fun process(buffer: FloatArray, offset: Int, frames: Int, channels: Int) {
        val count = frames * channels
        for (index in 0 until count) {
            val channel = index % channels
            var sample = buffer[offset + index]
            for (band in 0 until EQ_BAND_COUNT) {
                sample = bands[band].process(sample, channel)
            }
            if (globalGain != 1f) sample *= globalGain
            buffer[offset + index] = sample
        }
    }

    /** 是否有任何一段真的在动：全平时可以省掉整条滤波。 */
    fun isActive(): Boolean = bands.any { it.active } || abs(globalGain - 1f) > 0.0001f
}
