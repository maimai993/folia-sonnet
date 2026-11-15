package top.izuna.foliamajor.wallpaper

import android.media.audiofx.Visualizer
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log

/**
 * 叠层的音频采集。
 *
 * 为什么需要它：叠层是一个**独立的 WebView**，而播放的音频在主应用的 WebView 里
 * （`usePlaybackAudioBridge` 的 `createMediaElementSource` + `createAnalyser`）。
 * 叠层拿不到那个 AnalyserNode，band 全是 0，画面就只剩静态那点呼吸。
 *
 * 更要紧的是：**也不能把主应用采到的频谱经桥转过来**。采它的那个 rAF 跑在主应用
 *
 * 输出刻意做成**和 Web 侧同一套量纲**，好让叠层画出来的形状和播放页一致：
 * 5 个 band 走 `usePlaybackVisualizerBridge` 里同一组频率边界、同一条 shape 曲线。
 *
 * 曾经还有一份 128 段的频谱数组跟着一起推（叠层上莫奈底部那条「音频图案」画它），
 * 那条已于 2026-10-24 连同它的两个设置一起删掉：每秒二十次传一份没人读的数组，
 * 白白给叠层的 WebView 主线程加活。band 才是叠层现在唯一吃的东西。
 *
 * 拿不到数据时静默降级：一帧都不推，叠层维持它原来的行为。
 * 会拿不到的情况有几种：manifest 缺 MODIFY_AUDIO_SETTINGS、别的进程已经占用了
 * session 0 的 Visualizer、以及蓝牙 A2DP 输出（系统明确不给数据）。
 */
class WallpaperAudioTap {

    /** 采集的一声。数值全部是 0..255，跟页面侧 motion value 的量纲一致。 */
    class Frame internal constructor(power: Int, bass: Int, lowMid: Int, mid: Int, vocal: Int, treble: Int) {
        @JvmField val power: Int = power
        @JvmField val bass: Int = bass
        @JvmField val lowMid: Int = lowMid
        @JvmField val mid: Int = mid
        @JvmField val vocal: Int = vocal
        @JvmField val treble: Int = treble
    }

    /** 采样结果的上送。跑在主线程。 */
    interface Listener {
        fun onAudioFrame(frame: Frame)
    }

    private val listener: Listener
    /**
     * 采集哪一路音频。
     *
     * 0 是全局混音（叠层用这个：它拿不到主应用 WebView 里那个 AnalyserNode）。
     * 播放内核（P2）传的是 ExoPlayer 自己的 `getAudioSessionId()` —— 只采这一首歌，
     * 比起全局混音不会被别的App 的声音混进来，量纲两边共用一套，画出来形状一致。
     */
    private val audioSessionId: Int
    private val mainHandler = Handler(Looper.getMainLooper())

    constructor(listener: Listener) : this(listener, 0)

    constructor(listener: Listener, audioSessionId: Int) {
        this.listener = listener
        this.audioSessionId = audioSessionId
    }

    private var thread: HandlerThread? = null
    private var worker: Handler? = null
    private var visualizer: Visualizer? = null

    private var captureSize = 0
    /** 平滑后的幅度，长度 = captureSize / 2。只有采集线程碰它。 */
    private var smoothed: DoubleArray = DoubleArray(0)

    @Volatile
    private var running = false
    /**
     * 起不来就不再试。
     *
     * 采集失败通常是恒定的（缺权限 / 机型不给 / 被别的进程占着），让它每轮巡检都重试
     * 只会白白烧电还会刷一堆异常。注意**不**因为「暂时没数据」而置位 ——
     * 蓝牙输出在切回扬声器之后是会恢复的。
     */
    @Volatile
    private var failed = false

    /** 叠层挂上去之后调用。重复调用无害。 */
    fun start() {
        if (running || failed) {
            return
        }
        running = true
        // Visualizer 的回调跑在**创建它的线程**的 Looper 上。放在主线程上会让
        // FFT + 128 段重采样每 50ms 挤一次主线程，所以单独开一条。
        val newThread = HandlerThread("folia-wallpaper-audio")
        newThread.start()
        thread = newThread
        val newWorker = Handler(newThread.looper)
        worker = newWorker
        newWorker.post { attach() }
    }

    /** 叠层收摊时调用。 */
    fun stop() {
        if (!running) {
            return
        }
        running = false
        val currentWorker = worker
        val currentThread = thread
        if (currentWorker != null && currentThread != null) {
            // release 必须回到创建它的那条线程：Visualizer 不是线程安全的。
            currentWorker.post { release() }
            // quitSafely 会把队列里剩下的这条跑完再退，所以 release 一定执行得到。
            currentThread.quitSafely()
            thread = null
            worker = null
        }
    }

    private fun attach() {
        if (!running) {
            return
        }
        var probe: Visualizer? = null
        try {
            probe = Visualizer(audioSessionId)
            val range = Visualizer.getCaptureSizeRange()
            // 捕获长度越大频率越细，但上限是 1024（Visualizer 的硬规定），
            // 也就是 512 个频点 —— 比页面侧的 1024 个粗一倍，分成 5 个 band 足够。
            val size = Math.min(1024, Math.max(128, range[1]))
            if (probe.setCaptureSize(size) != Visualizer.SUCCESS) {
                release(probe)
                failed = true
                return
            }
            val sampling = probe.getSamplingRate()
            if (sampling <= 0) {
                release(probe)
                failed = true
                return
            }
            // getMaxCaptureRate 在部分 ROM 上被裁掉（报 NoSuchMethodError），反射兜底；
            // 取不到就按 0 处理（下面 maxRate > 0 才会拿它做上限）。
            val maxRate: Int = try {
                val m = Visualizer::class.java.getMethod("getMaxCaptureRate")
                (m.invoke(probe) as Int)
            } catch (ignored: Throwable) {
                0
            }
            // 单位是毫赫兹：20000 mHz = 20 次/秒。
            var rate = CAPTURE_FPS * 1000
            if (maxRate > 0) {
                rate = Math.min(rate, maxRate)
            }
            if (probe.setDataCaptureListener(object : Visualizer.OnDataCaptureListener {
                override fun onWaveFormDataCapture(visualizer: Visualizer?, waveform: ByteArray?, samplingRate: Int) {
                    // 只要频谱。
                }

                override fun onFftDataCapture(visualizer: Visualizer?, fft: ByteArray?, samplingRate: Int) {
                    onFft(fft, samplingRate)
                }
            }, rate, false, true) != Visualizer.SUCCESS) {
                release(probe)
                failed = true
                return
            }
            /*
             * 缓冲必须在 setEnabled 之前备好。
             *
             * 回调是 post 到**同一个** Looper 上的，理论上不会插到这个方法中间执行，
             * 但顺序上把它写成「先备好再开门」就不用依赖那条推论 —— 采集回调里
             * 摸到 null 缓冲就是一整条崩溃。
             */
            captureSize = size
            smoothed = DoubleArray(size / 2)
            if (probe.setEnabled(true) != Visualizer.SUCCESS) {
                release(probe)
                failed = true
                return
            }
            visualizer = probe
        } catch (error: Throwable) {
            Log.w(TAG, "音频采集起不来，叠层的音频响应维持原样", error)
            release(probe)
            failed = true
        }
    }

    private fun release() {
        val current = visualizer
        visualizer = null
        release(current)
    }

    private fun release(target: Visualizer?) {
        if (target == null) {
            return
        }
        try {
            target.setEnabled(false)
        } catch (ignored: Throwable) {
            // 已经没了。
        }
        try {
            target.release()
        } catch (ignored: Throwable) {
            // 同上。
        }
    }

    /**
     * FFT 回调。
     *
     * 数据格式：`fft` 长度是 `captureSize * 2`，实部虚部交错，有效频点是前
     * `captureSize / 2` 个（0 .. Nyquist）。频率 = `k * samplingRate / captureSize`。
     * 下标 0 / 1 在 half-complex 打包下是 DC 与 Nyquist 的实部，这两点的误差
     * 在频谱上完全看不出来，所以按下标直接成对取，不做特殊处理。
     */
    private fun onFft(fft: ByteArray?, samplingRateHz: Int) {
        if (!running || fft == null || captureSize == 0) {
            return
        }
        val bins = captureSize / 2
        if (fft.size < bins * 2 || samplingRateHz <= 0) {
            return
        }
        for (index in 0 until bins) {
            val real = fft[index * 2].toDouble()
            val imaginary = fft[index * 2 + 1].toDouble()
            val magnitude = Math.sqrt(real * real + imaginary * imaginary)
            // 平滑放在幅度域，跟 Web Audio 一样（它对 dB 之前的值做指数平滑）。
            smoothed[index] = smoothed[index] * SMOOTHING + magnitude * (1.0 - SMOOTHING)
        }

        val hzPerBin = samplingRateHz / captureSize.toDouble()
        // 频率边界与 usePlaybackVisualizerBridge 的 computeBandEnergy 逐条对齐。
        val bassRaw = bandValue(hzPerBin, 20.0, 150.0)
        val lowMidRaw = bandValue(hzPerBin, 150.0, 400.0)
        val midRaw = bandValue(hzPerBin, 400.0, 1200.0)
        val vocalRaw = bandValue(hzPerBin, 1000.0, 3500.0)
        val trebleRaw = bandValue(hzPerBin, 3500.0, 12000.0)

        // shape 指数也与 usePlaybackVisualizerBridge 里的逐条对齐。
        val frame = Frame(
                shape((bassRaw + lowMidRaw) / 2.0, 3.0),
                shape(bassRaw, 1.8),
                shape(lowMidRaw, 2.0),
                shape(midRaw, 2.0),
                shape(vocalRaw, 1.5),
                shape(trebleRaw, 2.0))
        mainHandler.post { listener.onAudioFrame(frame) }
    }

    /** 一段频率里各 bin 的 0..255 值的平均，对齐 computeBandEnergy。 */
    private fun bandValue(hzPerBin: Double, minHz: Double, maxHz: Double): Double {
        var start = Math.floor(minHz / hzPerBin).toInt()
        var end = Math.floor(maxHz / hzPerBin).toInt()
        if (start < 0) {
            start = 0
        }
        if (end >= smoothed.size) {
            end = smoothed.size - 1
        }
        if (end < start) {
            return 0.0
        }
        var sum = 0.0
        for (index in start..end) {
            sum += toByte(smoothed[index])
        }
        return sum / (end - start + 1)
    }

    /**
     * 线性幅度 → 0..255。
     *
     * 页面侧 `getByteFrequencyData` 给的是 dB 域（-100..-30 映射到 0..255），
     * Visualizer 给的是线性幅度，所以先转 dB 再减掉 DB_REFERENCE 那把尺子。
     */
    private fun toByte(magnitude: Double): Double {
        if (magnitude <= 1.0) {
            return 0.0
        }
        val db = 20.0 * Math.log10(magnitude)
        val normalized = (db - DB_REFERENCE + 100.0) / DB_RANGE
        if (normalized <= 0) {
            return 0.0
        }
        if (normalized >= 1) {
            return 255.0
        }
        return normalized * 255.0
    }

    /** 对齐 shapeBandEnergy：pow(value / 255, boost) * 255。 */
    private fun shape(value: Double, boost: Double): Int {
        var normalized = value / 255.0
        if (normalized <= 0) {
            return 0
        }
        if (normalized > 1) {
            normalized = 1.0
        }
        return Math.round(Math.pow(normalized, boost) * 255.0).toInt()
    }

    companion object {
        private const val TAG = "FoliaWallpaperAudioTap"

        /** 采集节拍（次/秒）。下面按 Visualizer 要求的毫赫兹换算。 */
        private const val CAPTURE_FPS = 20

        /** 幅度上的指数平滑，对齐 AnalyserNode 的 smoothingTimeConstant = 0.6。 */
        private const val SMOOTHING = 0.6

        /** 幅度 → 0..255 的参考响度。
         *
         * Visualizer 给的是**线性幅度**（signed byte 尺度，hypot 之后约 0..181），
         * 而页面那侧吃的是 dB 域。两边差一个固定尺度因子，这里用一个常量把它对上。
         *
         * **真机校准点**：频谱一直贴顶就把这个值调大，一直趴着就调小。
         */
        private const val DB_REFERENCE = 84.0

        /** 与 Web Audio 的 minDecibels(-100) / maxDecibels(-30) 一致。 */
        private const val DB_RANGE = 70.0
    }
}
