package top.izuna.foliamajor.automix

import android.content.Context
import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors

/**
 * 把内置的 Automix 模型状态与推理能力暴露给 Web 层。
 *
 * 与上游（Electron）的窗口 API 一一对应，但**没有真正意义上的下载**：
 * 权重在 APK 的 assets 里，`download` 在这个实现里就是「从 assets 拷到私有目录」，
 * 因此通常几秒内完成，也永远不会因为网络失败。
 *
 * 方法：
 *   · getStatus      → 两个模型各自是否就绪、字节数、私有目录
 *   · download       → 把某个模型从 assets 落到私有目录（等价于「安装」）
 *   · remove         → 删掉私有目录里的副本
 *   · verify         → 用 sha256 校验落盘的那份
 *   · analyzeBeats   → beat_this 出节拍网格
 */
@CapacitorPlugin(name = "FoliaAutomixModels")
class FoliaAutomixModelsPlugin : Plugin() {

    /** 拍点分析进度的事件名，与 Web 侧 nativeBeats.ts 的监听一致。 */
    private val beatProgressEvent = "beatAnalysisProgress"

    /** 分段交付的拍点表，同样是 nativeBeats.ts 在听。 */
    private val beatChunkEvent = "beatAnalysisChunk"

    /** 从分离出的鼓轨上取到的频带，每 30 秒一块；drumHits.ts 在听。 */
    private val drumStemBandsEvent = "drumStemBands"

    /** 首段多长（秒）：这一段先算先交，让画面在播放开始后一两秒就有反应。 */
    private val fastSeconds = 45

    /**
     * 模型拷贝与推理都很重，一律放在单线程池上顺序跑。
     *
     * 单线程而不是线程池：htdemucs 一次推理峰值内存接近 500MB，
     * 两个推理并行会直接把进程撑爆 —— 排队既是省内存，也是省电。
     */
    private val worker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "folia-automix").apply { priority = Thread.NORM_PRIORITY - 1 }
    }

    /**
     * 取消标记。
     *
     * 分离一首四分钟的歌在手机上要几分钟，而界面随时可能切歌、退出、或者用户就是想停。
     * `shutdownNow` 打断不了 Tensor 推理（JNI 里不响应中断），但推理是**按窗口**串起来的，
     * 在窗口之间问一次这个标记就够 —— 已经算完的部分照常交回去。
     */
    private val cancelRequested = java.util.concurrent.atomic.AtomicBoolean(false)

    override fun handleOnDestroy() {
        cancelRequested.set(true)
        // 那 20MB 的单声道缓存只是给「同一首歌的下一次分析」备的，插件都没了就还回去。
        TrackPcmDecoder.clearMonoCache()
        worker.shutdownNow()
        super.handleOnDestroy()
    }

    /** 让正在跑的推理在下一个窗口边界停下来。没有在跑也安全（下一次开始时重置）。 */
    @PluginMethod
    fun cancelAutomix(call: PluginCall) {
        cancelRequested.set(true)
        // 取消基本总跟着切歌：这首歌的 PCM 不会再用了，先释放。
        TrackPcmDecoder.clearMonoCache()
        call.resolve(JSObject().put("ok", true))
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        val context: Context = context
        worker.execute {
            try {
                val models = JSArray()
                for (name in AutomixModels.supportedNames()) {
                    val ready = AutomixModels.isReady(context, name)
                    val entry = JSObject()
                    entry.put("name", name)
                    entry.put("supported", true)
                    entry.put("bytes", AutomixModels.bytesOf(name))
                    entry.put("ready", ready)
                    entry.put("path", if (ready) {
                        AutomixModels.fileFor(context, name).absolutePath
                    } else {
                        null
                    })
                    models.put(entry)
                }
                val result = JSObject()
                result.put("models", models)
                result.put(
                    "dir",
                    AutomixModels.fileFor(context, AutomixModels.BEAT_THIS).parentFile?.absolutePath,
                )
                // 内置：这个构建永远不需要联网取权重，前端据此不显示任何「下载失败」入口。
                result.put("bundled", true)
                call.resolve(result)
            } catch (error: Exception) {
                call.reject("读取模型状态失败: ${error.message}", error)
            }
        }
    }

    @PluginMethod
    fun download(call: PluginCall) {
        val name = call.getString("name") ?: return call.reject("缺少 name")
        if (!AutomixModels.supportedNames().contains(name)) return call.reject("未知模型: $name")
        val context: Context = context
        worker.execute {
            try {
                var lastNotified = 0L
                val file = AutomixModels.ensureLocal(context, name) { received, total ->
                    /*
                     * 进度回调：最多每 4MB 发一次。
                     *
                     * notifyListeners 要跨过 JS 桥，而拷贝 100MB 会有上百次回调；
                     * 全部发过去没有意义，界面上的进度条看不出一两个百分点的差别。
                     */
                    if (received - lastNotified >= 4L * 1024 * 1024 || received == total) {
                        lastNotified = received
                        val event = JSObject()
                        event.put("name", name)
                        event.put("status", "downloading")
                        event.put("received", received)
                        event.put("total", total)
                        event.put("host", "bundled")
                        notifyListeners("modelProgress", event)
                    }
                }
                val done = JSObject()
                done.put("name", name)
                done.put("status", "done")
                notifyListeners("modelProgress", done)
                call.resolve(JSObject().put("ok", true).put("path", file.absolutePath))
            } catch (error: Exception) {
                val failed = JSObject()
                failed.put("name", name)
                failed.put("status", "failed")
                notifyListeners("modelProgress", failed)
                call.reject("安装 $name 失败: ${error.message}", error)
            }
        }
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val name = call.getString("name") ?: return call.reject("缺少 name")
        val context: Context = context
        worker.execute {
            try {
                call.resolve(JSObject().put("ok", AutomixModels.remove(context, name)))
            } catch (error: Exception) {
                call.reject("删除 $name 失败: ${error.message}", error)
            }
        }
    }

    /**
     * 用 sha256 校验私有目录里的副本。
     *
     * 不做成隐式步骤（太慢），只给调试与「文件损坏」这类排查用。
     */
    @PluginMethod
    fun verify(call: PluginCall) {
        val name = call.getString("name") ?: return call.reject("缺少 name")
        val context: Context = context
        worker.execute {
            try {
                val expected = AutomixModels.expectedSha256(name)
                    ?: return@execute call.reject("未知模型: $name")
                val file = AutomixModels.fileFor(context, name)
                if (!file.isFile) return@execute call.reject("$name 还没落盘")
                val actual = AutomixModels.sha256Of(file)
                call.resolve(
                    JSObject()
                        .put("ok", actual == expected)
                        .put("expected", expected)
                        .put("actual", actual),
                )
            } catch (error: Exception) {
                call.reject("校验 $name 失败: ${error.message}", error)
            }
        }
    }

    /**
     * 用 beat_this 分析节拍，**音频由原生自己按地址取**。
     *
     * 参数：
     *   url —— 本地绝对路径，或 http(s) 地址。
     *
     * ★ 这条路径是为安卓加的，替代上面那个 analyzeBeats 的整曲走桥。
     *
     * 线上曲子要走哪条由 JS 决定：本地文件 / 已解析出的远端地址都送到这里，
     * 只有「已经拿在手里的 PCM」才用 analyzeBeats。原因是 FoliaNativePlugin
     * 的 HTTP 响应上限 8MiB（见那边的注释）：把整首歌塞进 parameters 过桥，
     * 要么被拒（"Native HTTP response exceeds the bridge size limit"），
     * 要么把 base64 + JSON 序列化的 8 倍放大撞进 256MB 堆。
     */
    /**
     * 拍点分析的进度：阶段 + 这一段自己的完成度。
     *
     * 为什么要报：界面上原来只有一句不变的「正在分析这首歌的节拍…」，几十秒里一个字不动，
     * 和卡死在用户眼里没有区别，也没法判断是慢还是坏了（真机反馈 2026-11-13）。
     * 只在阶段边界与每 1024 帧报一次，整曲最多二三十条消息。
     */
    private fun reportBeatProgress(stage: String, percent: Float) {
        val payload = JSObject().put("stage", stage).put("percent", percent.toDouble())
        val emit = Runnable { notifyListeners(beatProgressEvent, payload) }
        val host = activity
        if (host != null) host.runOnUiThread(emit) else emit.run()
    }

    /**
     * 交一段「到这里为止」的拍点表。
     *
     * 表是**累积**的（每次都是从头到 `until` 的全量），因为界面那边的时钟只需要一份完整列表；
     * 整曲四分钟也就四五百个拍点，重复发的代价可以忽略，换来的是界面不用自己做合并去重。
     */
    private fun emitBeatChunk(beats: List<BeatThisRunner.Beat>, upToSec: Double, final: Boolean) {
        val array = JSArray()
        for (beat in beats) {
            array.put(
                JSObject()
                    .put("time", beat.time)
                    .put("downbeat", beat.isDownbeat)
                    .put("confidence", beat.confidence.toDouble()),
            )
        }
        val payload = JSObject().put("beats", array).put("until", upToSec).put("final", final)
        val emit = Runnable { notifyListeners(beatChunkEvent, payload) }
        val host = activity
        if (host != null) host.runOnUiThread(emit) else emit.run()
    }

    @PluginMethod
    fun analyzeBeatsFromUrl(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) return call.reject("缺少 url")
        val context: Context = context
        worker.execute {
            try {
                cancelRequested.set(false)
                AutomixLoad.applyThreadPriority()
                val started = System.currentTimeMillis()
                val file = AutomixModels.ensureLocal(context, AutomixModels.BEAT_THIS)
                BeatThisRunner.ensureLoaded(file)

                /*
                 * 第一段：只解前 45 秒，先让画面动起来。
                 *
                 * 为什么值得多花这一次：整曲「解码 + 频谱 + 六块推理」在手机上要二十秒以上，
                 * 而 45 秒（约 22 拍）的解码、频谱、单块推理加起来两秒上下 ——
                 * 用户按下播放后第一次看到镜面/鼓面响应，就在这个量级。
                 *
                 * `allowCache = false` 是关键：这一份是截断，一旦写进 20 秒缓存，
                 * 紧接着的整曲分析会命中它，后半首就永远没有拍点了。
                 */
                val head = TrackPcmDecoder.decodeMono(
                    context,
                    url,
                    maxSeconds = fastSeconds,
                    allowCache = false,
                )
                if (head != null && !cancelRequested.get()) {
                    BeatThisRunner.analyze(
                        mono = head,
                        cancelled = { cancelRequested.get() },
                        onChunk = { beats, upTo -> emitBeatChunk(beats, upTo, final = false) },
                    )
                }

                /*
                 * 整曲。解码结果还会被紧接着的鼓点分析复用（TrackPcmDecoder 的短时缓存）。
                 */
                val mono = TrackPcmDecoder.decodeMono(context, url)
                    ?: return@execute call.reject("无法解码音频: $url")
                reportBeatProgress("decode", 1f)
                val result = BeatThisRunner.analyze(
                    mono = mono,
                    cancelled = { cancelRequested.get() },
                    onProgress = { stage, percent -> reportBeatProgress(stage, percent) },
                    onChunk = { beats, upTo -> emitBeatChunk(beats, upTo, final = false) },
                )
                android.util.Log.i(
                    "Automix",
                    "beat_this(url): ${mono.size} 样本 -> ${result.beats.size} 个拍点，" +
                        "耗时 ${System.currentTimeMillis() - started}ms" +
                        if (result.cancelled) "（已取消）" else "",
                )

                val beats = JSArray()
                for (beat in result.beats) {
                    beats.put(
                        JSObject()
                            .put("time", beat.time)
                            .put("downbeat", beat.isDownbeat)
                            .put("confidence", beat.confidence.toDouble()),
                    )
                }
                call.resolve(
                    JSObject()
                        .put("beats", beats)
                        .put("fps", result.fps)
                        .put("frames", result.beatLogits.size)
                        // 实际分析了多长：解码器对超长的现场版会截断，截断后后半首没有拍点，
                        // 前端要能知道（原来这里不说，看上去就是「这首歌后半段没有节拍」）。
                        .put("seconds", mono.size.toDouble() / 22050.0)
                        .put("cancelled", result.cancelled),
                )
            } catch (error: Exception) {
                call.reject("节拍分析失败: ${error.message}", error)
            }
        }
    }

    /**
     * 混音的三条鼓点频带（kick / snare / hats），**音频由原生自己按地址取**。
     *
     * 这是「时计」在手机上真正需要的那个东西。它原先要么等 htdemucs 分离（比播放慢，永远追不上），
     * 要么在 WebView 里 `decodeAudioData` 整曲再逐块算 mel（四分钟的歌几十秒），两个都会让
     * 仿真鼓面在很长一段时间里一动不动。这里把解码与 mel 都搬到原生：一两秒出整曲的频带，
     * 过桥的只有 3 × 帧数 个 float（四分钟约 150KB），挑鼓点仍在 Web 侧做，算法只有一份。
     *
     * 参数：url —— 本地绝对路径，或 http(s) 地址（媒体缓存的回环地址也算本地）。
     * 返回：bands 三条 base64 float32、frames、fps（50）、seconds（实际解码到的长度）。
     */
    @PluginMethod
    fun analyzeDrumBandsFromUrl(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) return call.reject("缺少 url")
        val context: Context = context
        worker.execute {
            try {
                cancelRequested.set(false)
                AutomixLoad.applyThreadPriority()
                val started = System.currentTimeMillis()
                // 与节拍分析共用同一条 22.05k 单声道：同一首歌紧跟在前者之后调用时直接命中缓存。
                val mono = TrackPcmDecoder.decodeMono(context, url)
                    ?: return@execute call.reject("无法解码音频: $url")
                val bands = BeatThisRunner.drumBands(mono) { cancelRequested.get() }
                val frames = if (bands.isEmpty()) 0 else bands[0].size
                android.util.Log.i(
                    "Automix",
                    "drum bands: ${mono.size} 样本 -> $frames 帧，" +
                        "耗时 ${System.currentTimeMillis() - started}ms",
                )
                val payload = JSArray()
                for (band in bands) payload.put(encodeFloats(band))
                call.resolve(
                    JSObject()
                        .put("bands", payload)
                        .put("frames", frames)
                        .put("fps", BeatThisRunner.FPS)
                        .put("seconds", mono.size.toDouble() / BeatThisRunner.SAMPLE_RATE),
                )
            } catch (error: Exception) {
                call.reject("鼓点频带分析失败: ${error.message}", error)
            }
        }
    }

    /**
     * 从 htdemucs 分离出的**鼓轨**上取鼓点频带，按块回传。
     *
     * 为什么不是一次算完整曲：
     *   · 分离一首四分钟的歌在手机上是几分钟的推理，中间任何一个环节（切歌、退出）
     *     都会让这次结果白扔；
     *   · 分块之后第一块（30 秒音频）几十秒就能回，界面可以先拿它替换混音那份，
     *     剩下的继续补 —— 听的还是同一首歌，越往后越准。
     *
     * 每块做四件事，全在原生：
     *   1. 解码这 30 秒（44.1k 双声道，只这一段，常驻十几 MB）；
     *   2. htdemucs 只算 drums 轨；
     *   3. 降混 + 2:1 抽取到 22.05k 单声道；
     *   4. mel，取 kick / snare / hat 三条频带。
     *
     * 回传的是三条频带（base64 float32，一块约 4.5KB），挑点仍由 Web 侧统一做，
     * 两条路（混音 / 真鼓轨）用的是同一份起音判据。
     */
    @PluginMethod
    fun separateDrumsBandsFromUrl(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) return call.reject("缺少 url")
        val context: Context = context
        val chunkSeconds = (call.getDouble("chunkSeconds") ?: 30.0).coerceIn(10.0, 60.0)
        val maxSeconds = (call.getDouble("maxSeconds") ?: 480.0).coerceAtLeast(chunkSeconds)
        // 已经分离过的部分（缓存里有半份）从那里接着来，不再从 0 重算一遍。
        val startSeconds = (call.getDouble("startSeconds") ?: 0.0).coerceIn(0.0, maxSeconds)
        /*
         * 要不要顺带交回四条音乐包络（低频 / 人声 / 其余乐器 / 整体）。
         *
         * 模型本来就一次吐四轨，多要三轨只是多拷几份内存，推理时间一模一样 ——
         * 所以「鼓点」和「智能动感的其他效果」共用这一次分离，而不是为此再跑一遍。
         * 每块交回的是每 50ms 一个 RMS 值（四分钟的歌四条曲线约 60KB），波形一个字节都不过桥。
         */
        val withEnvelopes = call.getBoolean("envelopes") ?: false
        worker.execute {
            try {
                cancelRequested.set(false)
                AutomixLoad.applyThreadPriority()
                val started = System.currentTimeMillis()
                val file = AutomixModels.ensureLocal(context, AutomixModels.HTDEMUCS)
                HtdemucsRunner.ensureLoaded(file)
                var from = startSeconds
                var blocks = 0
                var reachedEnd = false
                while (!reachedEnd && from < maxSeconds && !cancelRequested.get()) {
                    val decoded = TrackPcmDecoder.decodeRange(context, url, from, chunkSeconds)
                        ?: break
                    if (decoded.samples <= 0) break
                    val separated = HtdemucsRunner.separate(
                        decoded.left,
                        decoded.right,
                        stems = if (withEnvelopes) listOf(0, 1, 2, 3) else listOf(0), // drums[, bass, other, vocals]
                        cancelled = { cancelRequested.get() },
                    )
                    val drums = separated.stems["drums"]
                    val drumsUsable = drums != null && drums.isNotEmpty() && drums[0].isNotEmpty()
                    // 鼓轨空了就没有鼓点可挑；但包络仍值得交回（这首歌可能只是没有鼓）。
                    if (!drumsUsable && !withEnvelopes) break
                    val mono = if (drumsUsable && drums != null) downmixHalf(drums) else FloatArray(0)
                    val bands: Array<FloatArray> = if (mono.isEmpty()) emptyArray() else BeatThisRunner.drumBands(mono) { cancelRequested.get() }
                    val frames = if (bands.isEmpty()) 0 else bands[0].size
                    val until = from + decoded.samples.toDouble() / HtdemucsRunner.SAMPLE_RATE
                    if (frames > 0 || withEnvelopes) {
                        val payload = JSObject()
                        if (frames > 0) {
                            val encoded = JSArray()
                            for (band in bands) encoded.put(encodeFloats(band))
                            payload.put("bands", encoded)
                            payload.put("frames", frames)
                            payload.put("fps", BeatThisRunner.FPS)
                        }
                        if (withEnvelopes) {
                            payload.put("envelopes", envelopeBlock(separated.stems, decoded.left, decoded.right, from, until))
                        }
                        payload.put("fromSec", from)
                        payload.put("untilSec", until)
                        blocks += 1
                        val emit = Runnable { notifyListeners(drumStemBandsEvent, payload) }
                        val host = activity
                        if (host != null) host.runOnUiThread(emit) else emit.run()
                        android.util.Log.i(
                            "Automix",
                            "drum stem: ${from.toInt()}s+${chunkSeconds.toInt()}s -> $frames 帧" +
                                (if (withEnvelopes) "，四轨包络" else "") +
                                "，累计 ${System.currentTimeMillis() - started}ms",
                        )
                    }
                    val advanced = decoded.samples.toDouble() / HtdemucsRunner.SAMPLE_RATE
                    from += advanced
                    // 解出来的比请求的短，说明已经到结尾了。
                    reachedEnd = advanced < chunkSeconds - 0.05
                    AutomixLoad.yieldPoint()
                }
                call.resolve(
                    JSObject()
                        .put("ok", true)
                        .put("blocks", blocks)
                        .put("seconds", from)
                        .put("cancelled", cancelRequested.get()),
                )
            } catch (error: Exception) {
                call.reject("鼓轨分离失败: ${error.message}", error)
            }
        }
    }

    /** 鼓轨的两条声道 → 22.05k 单声道：左右平均，再每两个样本取一个（整数倍抽取，不用插值）。 */
    private fun downmixHalf(stems: Array<FloatArray>): FloatArray {
        val left = stems[0]
        val right = if (stems.size > 1) stems[1] else left
        val out = FloatArray(left.size / 2)
        for (index in out.indices) {
            val at = index * 2
            out[index] = (left[at] + right[at]) * 0.5f
        }
        return out
    }

    /** 包络的帧率：每 50ms 一个值。20Hz 对画面上的呼吸、脉动足够，四分钟也就 4800 点。 */
    private val envelopeFps = 20

    /**
     * 一块音频的四条包络：低频（bass 轨）、人声（vocals 轨）、其余乐器（other 轨）、整体（混音）。
     *
     * 都是该段的 RMS，**不做归一化** —— 整首歌的响度只有 Web 侧拿到全部块之后才知道，
     * 在这里按块拉满会让前奏和副歌一样亮，画面就失去起伏了。
     */
    private fun envelopeBlock(
        stems: Map<String, Array<FloatArray>>,
        left: FloatArray,
        right: FloatArray,
        from: Double,
        until: Double,
    ): JSObject {
        val hop = (HtdemucsRunner.SAMPLE_RATE / envelopeFps).coerceAtLeast(1)
        return JSObject()
            .put("fps", envelopeFps)
            .put("bass", encodeFloats(rmsEnvelope(stems["bass"], hop)))
            .put("vocals", encodeFloats(rmsEnvelope(stems["vocals"], hop)))
            .put("other", encodeFloats(rmsEnvelope(stems["other"], hop)))
            .put("energy", encodeFloats(rmsEnvelope(left, right, hop)))
            .put("fromSec", from)
            .put("untilSec", until)
    }

    /** 一条轨（[声道][样本]）的 RMS 包络；轨不在或为空时给一条空曲线。 */
    private fun rmsEnvelope(stem: Array<FloatArray>?, hop: Int): FloatArray {
        if (stem == null || stem.isEmpty() || stem[0].isEmpty()) return FloatArray(0)
        val left = stem[0]
        val right = if (stem.size > 1) stem[1] else left
        return rmsEnvelope(left, right, hop)
    }

    /** 两条声道的 RMS 包络：每 hop 个样本一个值。 */
    private fun rmsEnvelope(left: FloatArray, right: FloatArray, hop: Int): FloatArray {
        if (left.isEmpty()) return FloatArray(0)
        val frames = (left.size + hop - 1) / hop
        val out = FloatArray(frames)
        for (frame in 0 until frames) {
            val start = frame * hop
            val end = minOf(left.size, start + hop)
            var sum = 0.0
            for (index in start until end) {
                val mono = (left[index] + (if (index < right.size) right[index] else left[index])) * 0.5f
                sum += mono.toDouble() * mono
            }
            out[frame] = kotlin.math.sqrt(sum / (end - start).coerceAtLeast(1)).toFloat()
        }
        return out
    }

    /**
     * 用 htdemucs 分离四轨，**音频由原生自己按地址取**（不必走桥）。
     *
     * 参数：
     *   url —— 本地绝对路径，或 http(s) 地址。
     *   stems —— 逗号分隔的轨名（drums / bass / other / vocals）；不传就是四轨全要。
     *            分析只要鼓或只要人声时传一个，过桥的数据量与内存都跟着减半。
     *   startSeconds / seconds —— 只分离这一段（分析用）。四分钟的歌在手机上是几分钟的
     *            推理，而鼓点与人声包络只关心前一两分钟时，没有理由全算。
     *
     * 返回与 separateStems 完全一致（stems 里是 base64 float32），
     * 因为下游解析那段的形状不该因为取音频的方式而变。
     */
    @PluginMethod
    fun separateStemsFromUrl(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) return call.reject("缺少 url")
        val context: Context = context
        val stems = parseStems(call.getString("stems"))
        val startSeconds = call.getDouble("startSeconds") ?: 0.0
        val seconds = call.getDouble("seconds")
        worker.execute {
            try {
                cancelRequested.set(false)
                val started = System.currentTimeMillis()
                val decoded = TrackPcmDecoder.decode(context, url)
                    ?: return@execute call.reject("无法解码音频: $url")
                respondWithStems(call, decoded, stems, startSeconds, seconds, started)
            } catch (error: Exception) {
                call.reject("四轨分离失败: ${error.message}", error)
            }
        }
    }

    /** 轨名 → 下标；认不出的名字忽略，一个都不剩就退回四轨全要。 */
    private fun parseStems(raw: String?): List<Int> {
        if (raw.isNullOrBlank()) return HtdemucsRunner.STEMS.indices.toList()
        val picked = raw.split(',')
            .map { it.trim().lowercase() }
            .filter { it.isNotEmpty() }
            .mapNotNull { name -> HtdemucsRunner.STEMS.indexOf(name).takeIf { it >= 0 } }
            .distinct()
        return picked.ifEmpty { HtdemucsRunner.STEMS.indices.toList() }
    }

    /**
     * 跑一次分离并把结果交回 JS。
     *
     * 四条路（从地址、从 PCM）只有「音频从哪来」不同，这一段完全一样：范围换算、
     * 进度节流、取消、base64 编码。分成两份写的时候，改参数只改了一半 —— 于是
     * `separateStems` 认 `stems` 而 `separateStemsFromUrl` 不认，调用方一脸问号。
     */
    private fun respondWithStems(
        call: PluginCall,
        decoded: TrackPcmDecoder.Result,
        stems: List<Int>,
        startSeconds: Double,
        seconds: Double?,
        started: Long,
    ) {
        val file = AutomixModels.ensureLocal(context, AutomixModels.HTDEMUCS)
        HtdemucsRunner.ensureLoaded(file)
        val rate = decoded.sampleRate
        val from = (startSeconds * rate).toInt().coerceIn(0, decoded.samples)
        val to = if (seconds == null || seconds <= 0) {
            decoded.samples
        } else {
            (from + seconds * rate).toInt().coerceIn(from, decoded.samples)
        }
        var lastPercent = -1
        val result = HtdemucsRunner.separate(
            decoded.left,
            decoded.right,
            stems = stems,
            fromSample = from,
            toSample = to,
            onProgress = { done, total ->
                val percent = if (total > 0) done * 100 / total else 100
                // 五个百分点发一次：一个窗口往往跨好几个百分点，不会太频繁。
                if (percent / 5 != lastPercent / 5 && percent < 100) {
                    lastPercent = percent
                    val event = JSObject()
                    event.put("name", AutomixModels.HTDEMUCS)
                    event.put("status", "analyzing")
                    event.put("percent", percent)
                    notifyListeners("modelProgress", event)
                }
            },
            cancelled = { cancelRequested.get() },
        )
        android.util.Log.i(
            "Automix",
            "htdemucs: ${decoded.samples} 样本 [${from}, ${to}) -> ${result.stems.keys}，" +
                "耗时 ${System.currentTimeMillis() - started}ms" +
                if (cancelRequested.get()) "（已取消，交回算完的部分）" else "",
        )

        val encoded = JSObject()
        for ((name, channels) in result.stems) {
            encoded.put(
                name,
                JSObject()
                    .put("left", encodeFloats(channels[0]))
                    .put("right", encodeFloats(channels[1])),
            )
        }
        call.resolve(
            JSObject()
                .put("stems", encoded)
                .put("sampleRate", result.sampleRate)
                // 这一段的长度，不是整首的：取消时会更短，调用方按 fromSample 拼。
                .put("samples", result.stems.values.firstOrNull()?.get(0)?.size ?: 0)
                .put("fromSample", result.fromSample)
                .put("cancelled", cancelRequested.get()),
        )
    }

    /**
     * 用 beat_this 分析节拍。
     *
     * 参数：
     *   samples —— base64 编码的 float32 小端 PCM，**必须已经是 22050Hz 单声道**。
     *              重采样放在 JS 侧做（那里已经有 decodeAudioData，改采样率成本很低），
     *              原生这边只负责它最擅长的那段：mel 频谱 + 推理 + 取峰。
     */
    @PluginMethod
    fun analyzeBeats(call: PluginCall) {
        val encoded = call.getString("samples") ?: return call.reject("缺少 samples")
        val context: Context = context
        worker.execute {
            try {
                cancelRequested.set(false)
                val mono = decodeFloats(encoded) ?: return@execute call.reject("samples 不是 float32 数组")

                val file = AutomixModels.ensureLocal(context, AutomixModels.BEAT_THIS)
                BeatThisRunner.ensureLoaded(file)
                val started = System.currentTimeMillis()
                // 命名参数：末尾那个 lambda 是 onChunk，不是 cancelled。
                val result = BeatThisRunner.analyze(mono, cancelled = { cancelRequested.get() })
                android.util.Log.i(
                    "Automix",
                    "beat_this: ${mono.size} 样本 -> ${result.beats.size} 个拍点，" +
                        "耗时 ${System.currentTimeMillis() - started}ms" +
                        if (result.cancelled) "（已取消）" else "",
                )

                val beats = JSArray()
                for (beat in result.beats) {
                    beats.put(
                        JSObject()
                            .put("time", beat.time)
                            .put("downbeat", beat.isDownbeat)
                            .put("confidence", beat.confidence.toDouble()),
                    )
                }
                call.resolve(
                    JSObject()
                        .put("beats", beats)
                        .put("fps", result.fps)
                        .put("frames", result.beatLogits.size)
                        .put("cancelled", result.cancelled),
                )
            } catch (error: Exception) {
                call.reject("节拍分析失败: ${error.message}", error)
            }
        }
    }

    /**
     * 用 htdemucs 分离一段 PCM（调用方按段喂，见 stemRange.ts）。
     *
     * 参数：
     *   left / right —— base64 编码的 float32 小端 PCM，**必须已经是 44100Hz**。
     *                   单声道就把右声道传同一份（模型要的是立体声输入）。
     *   stems —— 逗号分隔的轨名；不传就是四轨全要。
     *
     * 返回每个轨的波形，同样 base64 编码 —— 调用方拿去做鼓点/人声能量用，
     * 不需要自己再解码一次格式。
     *
     * 这个调用很重：一次 3.9 秒的窗口，手机上通常几秒，一首四分钟的歌要跑几十个窗口。
     * 所以放在单线程池里排队，并且分窗口回报进度 —— 前端据此显示「分析了多少」。
     */
    @PluginMethod
    fun separateStems(call: PluginCall) {
        val leftEncoded = call.getString("left") ?: return call.reject("缺少 left")
        val rightEncoded = call.getString("right") ?: leftEncoded
        val stems = parseStems(call.getString("stems"))
        worker.execute {
            try {
                cancelRequested.set(false)
                val left = decodeFloats(leftEncoded) ?: return@execute call.reject("left 不是 float32 数组")
                val right = decodeFloats(rightEncoded) ?: return@execute call.reject("right 不是 float32 数组")
                val started = System.currentTimeMillis()
                respondWithStems(
                    call,
                    TrackPcmDecoder.Result(left, right, HtdemucsRunner.SAMPLE_RATE),
                    stems,
                    0.0,
                    null,
                    started,
                )
            } catch (error: Exception) {
                call.reject("四轨分离失败: ${error.message}", error)
            }
        }
    }

    /** base64 → float32 小端。返回 null 表示长度不是 4 的倍数。 */
    private fun decodeFloats(encoded: String): FloatArray? {
        val bytes = Base64.decode(encoded, Base64.DEFAULT)
        if (bytes.isEmpty() || bytes.size % 4 != 0) return null
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        return FloatArray(bytes.size / 4) { buffer.getFloat(it * 4) }
    }

    /** float32 小端 → base64。分块累积，避免超大数组一次性展开。 */
    private fun encodeFloats(samples: FloatArray): String {
        val buffer = ByteBuffer.allocate(samples.size * 4).order(ByteOrder.LITTLE_ENDIAN)
        for (sample in samples) buffer.putFloat(sample)
        return Base64.encodeToString(buffer.array(), Base64.NO_WRAP)
    }
}
