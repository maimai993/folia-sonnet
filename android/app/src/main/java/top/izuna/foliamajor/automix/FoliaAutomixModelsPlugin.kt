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

    companion object {
        /**
         * ONNX 推理总闸（issue #401）。
         *
         * false 时：所有推理方法入口直接 reject，**并且**不加载模型 —— OrtEnvironment /
         * OrtSession / 权重全都不碰。这就是「从根源上禁止启动推理」：默认关着，由 Web 侧的
         * services/aiMemoryGate.ts 在用户主动关掉「禁用 AI 推理」之后调 setInferenceEnabled 打开。
         *
         * 做成进程级静态量而不是实例字段：插件实例会随 Activity 重建而重建，而 ONNX 会话是
         * JVM 级资源；用实例字段会让「刚重建那一刻」偷偷放行一次。
         */
        @Volatile
        @JvmStatic
        var inferenceEnabled: Boolean = false

        /** 总闸关着时给 JS 的那句话（Web 侧按前缀识别，别改）。 */
        const val INFERENCE_DISABLED_MESSAGE = "automix-inference-disabled"
    }

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
     * 单线程而不是线程池：一次推理的中间张量按 11 秒窗口算也有几十 MB，
     * 两个推理并行会直接把进程撑爆 —— 排队既是省内存，也是省电。
     */
    private val worker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "folia-automix").apply { priority = Thread.NORM_PRIORITY - 1 }
    }

    /**
     * 「整曲快速包络」专用的线程。
     *
     * 它不能排在 `worker` 后面：那条队列里可能正压着一整首 beat_this（二十秒到四十秒）或者
     * 一块分轨推理。而快速包络的全部价值就是「一两秒出结果」—— 排在它们后面等于没有。
     * 它自己不加载任何模型，峰值内存只有一份 42MB 的 22.05k 双声道，和那两边同时跑也不会顶翻。
     */
    private val envelopeWorker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "folia-envelope").apply { priority = Thread.NORM_PRIORITY - 1 }
    }

    /**
     * 取消的世代号。
     *
     * 原来是一个 `AtomicBoolean`：取消置 true，每个任务开头置 false。
     * 这在「一趟还没停、下一趟已经开跑」时是错的 —— 新任务把标记清掉，旧任务在它的
     * 窗口边界上永远看不到取消，于是一路算到底；而单线程池会把新任务排在那之后。
     * 用户看到的就是「第一块之后再也不动」。
     *
     * 改成世代号：取消只让**当前这一代**作废，新任务拿到的是新一代，
     * 老任务无论在哪一步检查都会看到自己的代号过期，各自收尾，互不影响。
     */
    private val cancelGeneration = java.util.concurrent.atomic.AtomicInteger(0)

    /** 这一代还算数吗。 */
    private fun expired(generation: Int): Boolean = cancelGeneration.get() != generation

    override fun handleOnDestroy() {
        cancelGeneration.incrementAndGet()
        // 那 20MB 的单声道缓存只是给「同一首歌的下一次分析」备的，插件都没了就还回去。
        TrackPcmDecoder.clearMonoCache()
        worker.shutdownNow()
        envelopeWorker.shutdownNow()
        super.handleOnDestroy()
    }

    /** 让正在跑的推理在下一个窗口边界停下来。没有在跑也安全（下一代由下一次请求开启）。 */
    /**
     * 开/关 ONNX 推理（issue #401）。默认关着。
     *
     * 关的时候不但后续请求不再受理，已经加载的会话也会被丢弃 —— 权重与 OrtSession 本身就是
     * 几十 MB 的常驻内存，光「不再发起新推理」并不能把已经占住的还回去。
     */
    @PluginMethod
    fun setInferenceEnabled(call: PluginCall) {
        val enabled = call.getBoolean("enabled") ?: false
        inferenceEnabled = enabled
        if (!enabled) {
            // 主动释放：把两个 Runner 的会话与缓存权重放掉，并停掉在跑的那一趟。
            cancelGeneration.incrementAndGet()
            runCatching { BeatThisRunner.close() }
            runCatching { ScnetRunner.release() }
        }
        val result = JSObject()
        result.put("enabled", inferenceEnabled)
        call.resolve(result)
    }

    @PluginMethod
    fun cancelAutomix(call: PluginCall) {
        cancelGeneration.incrementAndGet()
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
        if (!inferenceEnabled) return call.reject(INFERENCE_DISABLED_MESSAGE) // ONNX 总闸（#401），见 companion object
        val url = call.getString("url")
        if (url.isNullOrBlank()) return call.reject("缺少 url")
        val context: Context = context
        worker.execute {
            try {
                val generation = cancelGeneration.get()
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
                if (head != null && !expired(generation)) {
                    BeatThisRunner.analyze(
                        mono = head,
                        cancelled = { expired(generation) },
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
                    cancelled = { expired(generation) },
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
     * 这是「时计」在手机上真正需要的那个东西。它原先要么等分轨（比播放慢，永远追不上），
     * 要么在 WebView 里 `decodeAudioData` 整曲再逐块算 mel（四分钟的歌几十秒），两个都会让
     * 仿真鼓面在很长一段时间里一动不动。这里把解码与 mel 都搬到原生：一两秒出整曲的频带，
     * 过桥的只有 3 × 帧数 个 float（四分钟约 150KB），挑鼓点仍在 Web 侧做，算法只有一份。
     *
     * 参数：url —— 本地绝对路径，或 http(s) 地址（媒体缓存的回环地址也算本地）。
     * 返回：bands 三条 base64 float32、frames、fps（50）、seconds（实际解码到的长度）。
     */
    @PluginMethod
    fun analyzeDrumBandsFromUrl(call: PluginCall) {
        if (!inferenceEnabled) return call.reject(INFERENCE_DISABLED_MESSAGE) // ONNX 总闸（#401），见 companion object
        val url = call.getString("url")
        if (url.isNullOrBlank()) return call.reject("缺少 url")
        val context: Context = context
        worker.execute {
            try {
                val generation = cancelGeneration.get()
                AutomixLoad.applyThreadPriority()
                val started = System.currentTimeMillis()
                // 与节拍分析共用同一条 22.05k 单声道：同一首歌紧跟在前者之后调用时直接命中缓存。
                val mono = TrackPcmDecoder.decodeMono(context, url)
                    ?: return@execute call.reject("无法解码音频: $url")
                val bands = BeatThisRunner.drumBands(mono) { expired(generation) }
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
     * 从 SCNet 分离出的**鼓轨**上取鼓点频带，按块回传。
     *
     * 为什么不是一次算完整曲：
     *   · 分离一首四分钟的歌在手机上仍是分钟级的活，中间任何一个环节（切歌、退出）
     *     都会让这次结果白扔；
     *   · 分块之后第一块（11 秒音频）几秒就能回，界面可以先拿它替换混音那份，
     *     剩下的继续补 —— 听的还是同一首歌，越往后越准。
     *
     * 每块做四件事，全在原生：
     *   1. 解码这 11 秒（44.1k 双声道，只这一段，常驻十几 MB）；
     *   2. SCNet 只算 drums 轨；
     *   3. 降混 + 2:1 抽取到 22.05k 单声道；
     *   4. mel，取 kick / snare / hat 三条频带。
     *
     * 回传的是三条频带（base64 float32，一块约 4.5KB），挑点仍由 Web 侧统一做，
     * 两条路（混音 / 真鼓轨）用的是同一份起音判据。
     */
    /**
     * 整曲的十条音乐包络，**不跑分离模型**，只做频段分析。
     *
     * 为什么要有这一条：分离一次要按窗口推理，整首四分钟仍是分钟级的活。
     * 而画面上那些「低频涌动 / 人声泛光 / 明暗呼吸」要的只是**某一刻某一频段有多响**，
     * 不需要听感完美的分轨。频段 RMS 在整曲上算完只要一两秒 —— 先用它把整条曲线铺满，
     * 画面立刻整曲可用；分轨结果随后一块块盖上去，盖到哪一段哪一段就更准。
     *
     * 参数的取舍：解码用 22.05k **双声道**（要中置通道，人声在中间），四分钟约 42MB；
     * 44.1k 会翻倍，而 25Hz 的包络根本用不到 11kHz 以上的带宽。
     *
     * 返回的键与 `envelopeBlock` 完全一致，所以两条路的结果在 Web 侧是同一个形状，
     * 覆盖的时候不需要区分来源。
     */
    @PluginMethod
    fun analyzeMusicEnvelopesFromUrl(call: PluginCall) {
        if (!inferenceEnabled) return call.reject(INFERENCE_DISABLED_MESSAGE) // ONNX 总闸（#401），见 companion object
        val url = call.getString("url")
        if (url.isNullOrBlank()) return call.reject("缺少 url")
        val context: Context = context
        envelopeWorker.execute {
            try {
                val generation = cancelGeneration.get()
                AutomixLoad.applyThreadPriority()
                val started = System.currentTimeMillis()
                val pcm = TrackPcmDecoder.decode(context, url, targetRate = FAST_ENVELOPE_RATE)
                    ?: return@execute call.reject("无法解码音频: $url")
                val left = pcm.left
                val right = pcm.right
                if (left.isEmpty()) return@execute call.reject("音频是空的: $url")
                /*
                 * 中置通道。人声、底鼓、贝斯在混音里几乎都居中；立体声展宽的吉他、pad、
                 * 混响尾巴大多在两侧。取 (L+R)/2 能把这些侧向内容压掉一截 ——
                 * 这是我们**唯一**能接近「分出人声」的手段，不追求干净，够画面用就行。
                 */
                val mid = FloatArray(left.size) { (left[it] + right[it]) * 0.5f }
                val hop = (FAST_ENVELOPE_RATE / envelopeFps).coerceAtLeast(1)
                val mix = arrayOf(mid)
                fun band(lowHz: Double, highHz: Double): FloatArray =
                    bandRmsEnvelope(mix, hop, lowHz, highHz, FAST_ENVELOPE_RATE)
                val bass = band(0.0, 250.0)
                val lowMid = band(250.0, 1200.0)
                val vocalBand = band(1200.0, 4500.0)
                val air = band(3000.0, 0.0)
                val bright = band(4000.0, 0.0)
                val hat = band(6000.0, 0.0)
                val sub = band(0.0, 80.0)
                /*
                 * 底鼓与军鼓用**起音强度**而不是能量。
                 *
                 * 纯能量分不开「底鼓」和「贝斯」—— 两者的基频都在 60~100Hz，能量曲线几乎一样。
                 * 但底鼓是瞬态、贝斯是持续音：能量的**上升速率**只在鼓点处出现尖峰。
                 * 这一条比分离出来的 kick 曲线更「脆」，鼓面会更跟手。
                 */
                val kick = onsetEnvelope(band(0.0, 150.0))
                val snare = onsetEnvelope(band(250.0, 3000.0))
                val energy = band(0.0, 0.0)
                /*
                 * 基线阶段还没有分轨，人声与乐器是同一条中置混音：发声/基频/和弦都从它近似。
                 * 鼓还在里面，所以和弦会比精修块粗一些 —— 但总比整条停在 0 好：
                 * 分离要几分钟，这期间画面不能是死的。精修块一到就按区间整段盖掉。
                 */
                val features = AudioFeatures.analyze(mix, null, hop, energy.size, FAST_ENVELOPE_RATE)
                val seconds = mid.size.toDouble() / FAST_ENVELOPE_RATE
                android.util.Log.i(
                    "Automix",
                    "music envelopes: ${mid.size} 样本 / ${seconds.toInt()}s -> ${energy.size} 帧，" +
                        "耗时 ${System.currentTimeMillis() - started}ms",
                )
                call.resolve(
                    JSObject()
                        .put("fps", envelopeFps)
                        .put("frames", energy.size)
                        .put("seconds", seconds)
                        .put("fromSec", 0.0)
                        .put("untilSec", seconds)
                        .put("bass", encodeFloats(bass))
                        .put("vocals", encodeFloats(vocalBand))
                        .put("other", encodeFloats(lowMid))
                        .put("energy", encodeFloats(energy))
                        .put("bassSub", encodeFloats(sub))
                        .put("vocalAir", encodeFloats(air))
                        .put("brightness", encodeFloats(bright))
                        .put("kick", encodeFloats(kick))
                        .put("snare", encodeFloats(snare))
                        .put("hat", encodeFloats(hat))
                        /*
                         * 基线的四条语义轨。
                         *
                         * 这时候还没有分离，只能从混音里按频段近似：drums 用低频起音、
                         * vocalBody 用 300–2000（人声所在，但伴奏也在）、harmony 用
                         * 250–2000、pad 用 80–250。它们只负责「补齐之前画面别僵住」，
                         * 精修块一到就按区间整段盖掉。
                         */
                        .put("drums", encodeFloats(onsetEnvelope(band(30.0, 150.0))))
                        .put("vocalBody", encodeFloats(band(300.0, 2000.0)))
                        .put("harmony", encodeFloats(band(250.0, 2000.0)))
                        .put("pad", encodeFloats(band(80.0, 250.0)))
                        // 语义层：基线用中置混音近似，精修块一到就覆盖。
                        .put("vocalVoicing", encodeFloats(features.voicing))
                        .put("vocalPitch", encodeFloats(features.pitch))
                        .put("chordRoot", encodeFloats(features.chordRoot))
                        .put("chordMinor", encodeFloats(features.chordMinor))
                        .put("chromaMean", encodeFloats(features.chromaMean)),
                )
            } catch (error: Throwable) {
                if (error is OutOfMemoryError) {
                    // 42MB 的双声道解码在低内存机器上也可能不够；卸掉缓存，下次再来。
                    TrackPcmDecoder.clearMonoCache()
                    call.reject("包络分析内存不足: ${error.message}")
                    return@execute
                }
                call.reject("包络分析失败: ${error.message ?: error.javaClass.simpleName}")
            }
        }
    }

    /**
     * 能量包络的**上升量**：只在「比上一帧更响」的地方留值。
     *
     * 用来把瞬态（鼓、拍手）从持续音（贝斯、pad）里分出来。
     * 值域与输入相同（都是 RMS 量级），Web 侧会按整曲的 97 分位归一，不需要在这里缩放。
     */
    private fun onsetEnvelope(rms: FloatArray): FloatArray {
        val out = FloatArray(rms.size)
        var previous = 0f
        for (index in rms.indices) {
            val rise = rms[index] - previous
            if (rise > 0f) out[index] = rise
            previous = rms[index]
        }
        return out
    }

    /*
     * 分轨引擎：只有 SCNet。
     *
     * 曾经这里是「SCNet 为主、htdemucs 兜底」，揣测的是新链路第一次上真机，任何一处
     * 不成立都不该把整首歌的分析判死。代价是兜底是**静默**的：真机上退回 htdemucs
     * 之后，曲线照常出、画面照常动，只是分得没那么干净 —— 于是「换了模型但没区别」
     * 这种问题只能靠翻日志才看得见。htdemucs 的 108MB 权重也因此一直占着包。
     *
     * 现在没有兜底：加载失败就是失败，调用方拿到明确的错误，日志里只有一行原因。
     */
    @Volatile
    private var stemEngineReady = false

    @Synchronized
    private fun ensureStemEngine(context: Context) {
        if (stemEngineReady) return
        ScnetRunner.ensureLoaded(AutomixModels.ensureLocal(context, AutomixModels.SCNET))
        stemEngineReady = true
    }

    @Synchronized
    private fun releaseStemEngine() {
        ScnetRunner.release()
        stemEngineReady = false
    }

    /** 用 SCNet 分离一段。加载与推理的失败都往上抛，由调用方决定怎么交代。 */
    private fun separateStems(
        context: Context,
        left: FloatArray,
        right: FloatArray,
        stems: List<Int>,
        cancelled: () -> Boolean,
    ): Map<String, Array<FloatArray>> {
        ensureStemEngine(context)
        return ScnetRunner.separate(left, right, stems = stems, cancelled = cancelled).stems
    }

    @PluginMethod
    fun separateDrumsBandsFromUrl(call: PluginCall) {
        if (!inferenceEnabled) return call.reject(INFERENCE_DISABLED_MESSAGE) // ONNX 总闸（#401），见 companion object
        val url = call.getString("url")
        if (url.isNullOrBlank()) return call.reject("缺少 url")
        val context: Context = context
        val chunkSeconds = (call.getDouble("chunkSeconds") ?: 11.0).coerceIn(10.0, 60.0)
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
        /*
         * 这一次调用最多跑几块。
         *
         * 默认 1：整趟由 Web 侧一块一块驱动。原因不是省事，而是**可恢复**——
         * 一次调用跑完整首时，中间任何一块失败（推理 OOM、解码 seek 失败、用户切歌）
         * 都会把整趟连同后面所有块一起丢掉，而界面只看到「停在第 30 秒」。
         * 一调用一块之后，坏的那一块只丢它自己，下一块照常继续；每块结束线程池也空一次，
         * 长跑占住的内存与 native 缓冲有机会归还。
         */
        val maxBlocks = (call.getInt("blocks") ?: 1).coerceIn(1, 64)
        worker.execute {
            var from = startSeconds
            var blocks = 0
            var reachedEnd = false
            try {
                val generation = cancelGeneration.get()
                AutomixLoad.applyThreadPriority()
                val started = System.currentTimeMillis()
                ensureStemEngine(context)
                while (!reachedEnd && from < maxSeconds && blocks < maxBlocks && !expired(generation)) {
                    val decoded = TrackPcmDecoder.decodeRange(context, url, from, chunkSeconds)
                        ?: break
                    if (decoded.samples <= 0) break
                    /*
                     * 数字静音的段落不跑推理：一首歌里前奏、间奏、尾奏的空拍常有十几二十秒，
                     * 这段时间分离出来的四轨本来就全是零。跳过它省下的是真金白银的推理时间
                     * （一块 30 秒是八个窗口），而交回的曲线长度照旧，时间轴不会断。
                     */
                    val silent = rmsOf(decoded.left, decoded.right) < SILENT_RMS
                    val separated = if (silent) {
                        null
                    } else {
                        separateStems(
                            context,
                            decoded.left,
                            decoded.right,
                            // drums[, bass, other, vocals]
                            stems = if (withEnvelopes) listOf(0, 1, 2, 3) else listOf(0),
                        ) { expired(generation) }
                    }
                    val drums = separated?.get("drums")
                    val drumsUsable = drums != null && drums.isNotEmpty() && drums[0].isNotEmpty()
                    // 鼓轨空了就没有鼓点可挑；但包络仍值得交回（这首歌可能只是没有鼓）。
                    if (!drumsUsable && !withEnvelopes && !silent) break
                    val mono = if (drumsUsable && drums != null) downmixHalf(drums) else FloatArray(0)
                    val bands: Array<FloatArray> = if (mono.isEmpty()) emptyArray() else BeatThisRunner.drumBands(mono) { expired(generation) }
                    val frames = if (bands.isEmpty()) 0 else bands[0].size
                    val until = from + decoded.samples.toDouble() / ScnetRunner.SAMPLE_RATE
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
                            payload.put(
                                "envelopes",
                                envelopeBlock(separated, decoded.left, decoded.right, from, until),
                            )
                        }
                        payload.put("fromSec", from)
                        payload.put("untilSec", until)
                        blocks += 1
                        val emit = Runnable { notifyListeners(drumStemBandsEvent, payload) }
                        val host = activity
                        if (host != null) host.runOnUiThread(emit) else emit.run()
                        /*
                         * 一行里带出「分离出来的轨到底有没有声音」。
                         *
                         * 曲线全平 / 画面不动时，从日志要能一眼分清是模型没跑、跑出空轨，
                         * 还是跑了也有数据只是 Web 侧没接上 —— 两种情况的鼓/人声 RMS 差一个量级。
                         */
                        val drumRms = separated?.get("drums")?.let { rmsOf(it[0], it[1]) } ?: 0.0
                        val vocalRms = separated?.get("vocals")?.let { rmsOf(it[0], it[1]) } ?: 0.0
                        android.util.Log.i(
                            "Automix",
                            "drum stem[${AutomixModels.SCNET}]: ${from.toInt()}s+${chunkSeconds.toInt()}s${if (silent) "（静音，跳过推理）" else ""} -> $frames 帧" +
                                (if (withEnvelopes) "，四轨包络" else "") +
                                "，鼓 ${Math.round(drumRms * 1000)}‰ 人声 ${Math.round(vocalRms * 1000)}‰" +
                                "，累计 ${System.currentTimeMillis() - started}ms",
                        )
                    } else if (silent) {
                        // 静音段没有鼓点、又不要包络：时间轴照样要往前推，否则调用方以为没过这一块。
                        blocks += 1
                    }
                    val advanced = decoded.samples.toDouble() / ScnetRunner.SAMPLE_RATE
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
                        .put("done", reachedEnd)
                        .put("cancelled", expired(generation)),
                )
            } catch (error: Throwable) {
                /*
                 * Throwable 而不是 Exception：分轨单块推理的中间张量到几十 MB，
                 * OOM 是 OutOfMemoryError —— 它是 Error 的子类，`catch (Exception)` 收不到。
                 * 收不到的后果比崩溃更难查：worker 线程被 Error 带走，这个 call 的 promise
                 * 永远不 resolve，Web 侧的「正在补齐 · 30s」就永远停在那里，重启才好。
                 * 这里必须收下、必须 resolve/reject，并把会话卸掉 —— 下一次从干净状态重来。
                 */
                if (error is OutOfMemoryError) {
                    releaseStemEngine()
                    android.util.Log.w("Automix", "鼓轨分离内存不足，已卸载会话：${error.message}")
                    // 已经算完的块仍然有效，把位置交回去，别让调用方从更早的地方重来。
                    call.resolve(
                        JSObject()
                            .put("ok", false)
                            .put("blocks", blocks)
                            .put("seconds", from)
                            .put("done", reachedEnd)
                            .put("outOfMemory", true)
                            .put("cancelled", false),
                    )
                    return@execute
                }
                call.reject("鼓轨分离失败（分轨模型 ${AutomixModels.SCNET}）: ${error.message ?: error.javaClass.simpleName}")
            }
        }
    }

    /**
     * 一段立体声的 RMS（0..1）。
     *
     * 只看响度，不做任何门限曲线：调用方拿它判「这段是不是数字静音」。
     */
    private fun rmsOf(left: FloatArray, right: FloatArray): Double {
        if (left.isEmpty()) return 0.0
        var sum = 0.0
        for (index in left.indices) {
            val value = left[index].toDouble()
            sum += value * value
        }
        val count = left.size
        val rightSum = if (right.size == count) {
            var acc = 0.0
            for (index in right.indices) {
                val value = right[index].toDouble()
                acc += value * value
            }
            acc
        } else {
            sum
        }
        return kotlin.math.sqrt((sum + rightSum) / (count * 2.0))
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

    /**
     * 包络的帧率：每 40ms 一个值。
     *
     * 25 这个数是两边都能整除出来的：44.1k / 25 = 1764，22.05k / 25 = 882。
     * 「整曲快速包络」与「分轨精修」两条路必须用**同一个帧率**，否则它们的时间轴对不上，
     * 精修块盖不到基线上去。20 在 22.05k 上除不尽（1102.5），会累积出可听的漂移。
     */
    private val envelopeFps = 25

    /**
     * 判「这段是数字静音」的响度门限（RMS，0..1）。
     *
     * 0.001 约等于 -60dBFS：正常音乐哪怕是极安静的前奏也在 -40dBFS 上下，
     * 低于这个值的段落基本只可能是数字静音（空白间隔、导出的静音尾巴）。
     * 宁可少跳也不要误跳 —— 误跳会把「安静」抹成「没有」，画面会突然死一段。
     */
    private val SILENT_RMS = 0.001

    /**
     * 「整曲快速包络」的解码采样率。
     *
     * 22.05k 就够：包络是每 40ms 一个 RMS，最高关心到 6kHz 以上的镲片，
     * 11kHz 的 Nyquist 绰绰有余。而 44.1k 会让整曲双声道的解码缓冲从 42MB 涨到 170MB。
     */
    private val FAST_ENVELOPE_RATE = TrackPcmDecoder.MONO_RATE

    /**
     * 一块音频的十条包络。前四条是原来的整轨 RMS（低频 / 人声 / 其余乐器 / 整体混音），
     * 后六条是把**同一批已分离的波形**再按频段过一遍得到的细分维度：
     * 超低频、气声、亮度、底鼓、军鼓、镲片。
     *
     * 关键是「不重跑分离、不换模型」：分轨本来就一次吐四轨，这里只是对已经在手的
     * 波形做几次一阶 IIR 分频再取 RMS，一首四分钟歌十条曲线也就几百万次乘加，相比一次
     * 前向可以忽略。APK 里一个字节的模型都不用多放，过桥只多 6 条每 50ms 一个值的曲线。
     *
     * 都是该段的 RMS，**不做归一化** —— 整首歌的响度只有 Web 侧拿到全部块之后才知道，
     * 在这里按块拉满会让前奏和副歌一样亮，画面就失去起伏了。
     */
    private fun envelopeBlock(
        stems: Map<String, Array<FloatArray>>?,
        left: FloatArray,
        right: FloatArray,
        from: Double,
        until: Double,
    ): JSObject {
        val hop = (ScnetRunner.SAMPLE_RATE / envelopeFps).coerceAtLeast(1)
        val mix = arrayOf(left, right)
        /*
         * `stems == null` 是「这一段是数字静音，没跑推理」。
         *
         * 这时候仍然要交一条**等长**的零曲线：不交会让时间轴在这里断掉（Web 侧按帧位置
         * 摆曲线，缺口补零），交空数组则长度对不上、后面的块全部错位。
         */
        val frames = (left.size + hop - 1) / hop
        // 轨缺了 / 太短都补齐到 frames：曲线短一帧，Web 侧整块后面的时间轴都会错位。
        fun pad(a: FloatArray): FloatArray = if (a.size == frames) a else FloatArray(frames) { a.getOrElse(it) { 0f } }
        fun curve(stem: Array<FloatArray>?, lowHz: Double, highHz: Double): FloatArray =
            if (stems == null) FloatArray(frames) else pad(bandRmsEnvelope(stem, hop, lowHz, highHz))
        /*
         * 亮度只从**其余乐器**取，不再从整混音取。
         *
         * 整混音 4kHz 以上几乎被镲片与军鼓的高频占满：鼓点每敲一下，这条曲线就跳一下。
         * 读它的画面（雾的浓淡、光束宽度、辉光强度）于是跟着鼓闪 —— 这正是「不是鼓的
         * 画面却被鼓带着抖」。other 轨里是吉他 / 键盘 / 弦乐这些真正决定明暗的东西。
         */
        val brightnessSource = stems?.get("other")?.takeIf { it.isNotEmpty() && it[0].isNotEmpty() } ?: mix
        /*
         * 人声净曲线：不是「vocals 在 250–2000 的 RMS」，而是把鼓在这个频段里的残留
         * 一并扣掉之后的结果。军鼓主体就在 150–2500，和男声基频、女声低次谐波完全重叠，
         * 光靠分轨减不干净——分得再准，重叠的那部分还在。
         * 具体三步（谱减 / 上升沿门控 / 中值+跟随）见 [VocalCurve]。
         */
        val vocalBodyCurve = if (stems == null) {
            FloatArray(frames)
        } else {
            pad(VocalCurve.envelope(stems["vocals"], stems["drums"], hop))
        }
        /*
         * 语义层：发声 / 基频 / 和弦 / 调性。
         *
         * 三条都从**已分离的波形**上算，不额外跑模型：人声轨给发声与基频，
         * 人声 + 其余乐器给色度谱（和弦）。鼓已经在这两条轨之外，色度谱不会被鼓的
         * 宽频瞬态糊成一团 —— 这正是「和弦跟着鼓点乱跳」的根因。
         */
        val features = if (stems == null) {
            AudioFeatures.empty(frames)
        } else {
            AudioFeatures.analyze(stems["vocals"], stems["other"], hop, frames)
        }
        /*
         * 一行日志给真机排查：净曲线的均值与峰值。
         *
         * 和上面那行「鼓 x‰ 人声 y‰」凑起来就能分清三种情况：
         *   · 人声 y 很小 —— 这首歌本来就没唱（纯音乐），曲线安静是对的；
         *   · 人声 y 正常、净曲线均值却接近 0 —— 谱减削过头了，要调 SUBTRACT；
         *   · 两者都正常但画面仍抖 —— 问题在 Web 侧接线，不在数据。
         */
        // 静音段没跑推理，曲线整条是 0 —— 打出来只会淹没真正要看的那几行。
        if (stems != null && vocalBodyCurve.isNotEmpty()) {
            var sum = 0f
            var peak = 0f
            for (value in vocalBodyCurve) {
                sum += value
                if (value > peak) peak = value
            }
            android.util.Log.i(
                "Automix",
                "vocal net[${AutomixModels.SCNET}]: 均值 ${Math.round(sum / vocalBodyCurve.size * 1000)}‰" +
                    " 峰值 ${Math.round(peak * 1000)}‰（已减鼓）",
            )
        }
        return JSObject()
            .put("fps", envelopeFps)
            // 原来的四条，含义不变，旧数据也能对上。
            .put("bass", encodeFloats(curve(stems?.get("bass"), 0.0, 0.0)))
            .put("vocals", encodeFloats(curve(stems?.get("vocals"), 0.0, 0.0)))
            .put("other", encodeFloats(curve(stems?.get("other"), 0.0, 0.0)))
            .put("energy", encodeFloats(if (stems == null) FloatArray(frames) else pad(bandRmsEnvelope(mix, hop, 0.0, 0.0))))
            // 细分：同一批波形再分频段过一遍。
            .put("bassSub", encodeFloats(curve(stems?.get("bass"), 0.0, 80.0)))
            .put("vocalAir", encodeFloats(curve(stems?.get("vocals"), 3000.0, 0.0)))
            .put("brightness", encodeFloats(if (stems == null) FloatArray(frames) else pad(bandRmsEnvelope(brightnessSource, hop, 4000.0, 0.0))))
            .put("kick", encodeFloats(curve(stems?.get("drums"), 0.0, 150.0)))
            .put("snare", encodeFloats(curve(stems?.get("drums"), 150.0, 6000.0)))
            .put("hat", encodeFloats(curve(stems?.get("drums"), 6000.0, 0.0)))
            /*
             * 再往下切一层：四条「语义轨」，每个效果只读它真正需要的那一条。
             *
             * 四轨模型的上限是四条，这里不在模型上再分，而是在**已分离的波形**上按频段切。
             * 目的不是「轨道数变多」，是让「歌词的呼吸」和「鼓的冲击」在数据上就分开：
             *   drums      —— 鼓组整体（只有节奏类画面该用它）
             *   vocalBody  —— 人声基频与共振峰（250–2000），歌词句子的厚度
             *   harmony    —— 伴奏主体（other 250–2000），和声与乐句的厚薄
             *   pad        —— 伴奏铺底（other 80–250），低频的「托」
             * 这样 lyrics 类效果读 vocalBody / vocalAir 时，鼓点再重也进不来。
             */
            .put("drums", encodeFloats(curve(stems?.get("drums"), 0.0, 0.0)))
            .put("vocalBody", encodeFloats(vocalBodyCurve))
            .put("harmony", encodeFloats(curve(stems?.get("other"), 250.0, 2000.0)))
            .put("pad", encodeFloats(curve(stems?.get("other"), 80.0, 250.0)))
            /*
             * 语义层四条曲线 + 一块平均色度。
             *
             *   vocalVoicing —— 这一帧有没有人在唱（0..1）。歌词类画面「什么时候该动」
             *                   从此有了依据：清音帧不该有位移。
             *   vocalPitch   —— 唱到多高（0..1，55–880Hz 四个八度）。乐句往上走，
             *                   画面才往上抬；读能量是做不到这件事的。
             *   chordRoot    —— 根音 / 12；chordMinor 0 大调 1 小调。
             *   chromaMean   —— 12 维平均色度，Web 侧据此算整曲调性（Krumhansl）。
             */
            .put("vocalVoicing", encodeFloats(features.voicing))
            .put("vocalPitch", encodeFloats(features.pitch))
            .put("chordRoot", encodeFloats(features.chordRoot))
            .put("chordMinor", encodeFloats(features.chordMinor))
            .put("chromaMean", encodeFloats(features.chromaMean))
            .put("fromSec", from)
            .put("untilSec", until)
    }

    /**
     * 一条轨的带限 RMS 包络。实现在 [VocalCurve.bandRms]，这里只留一个转发。
     *
     * 之所以搬到那边：人声那条曲线要在同一套分频上做谱减和门控，两处各写一份
     * 迟早会漂（一边改了截止频率、一边没改，减出来的就是错的）。算法只有一个来源。
     */
    private fun bandRmsEnvelope(
        stem: Array<FloatArray>?,
        hop: Int,
        lowHz: Double,
        highHz: Double,
        sampleRate: Int = ScnetRunner.SAMPLE_RATE,
    ): FloatArray = VocalCurve.bandRms(stem, hop, lowHz, highHz, sampleRate)

    /**
     * 用 SCNet 分离四轨，**音频由原生自己按地址取**（不必走桥）。
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
        if (!inferenceEnabled) return call.reject(INFERENCE_DISABLED_MESSAGE) // ONNX 总闸（#401），见 companion object
        val url = call.getString("url")
        if (url.isNullOrBlank()) return call.reject("缺少 url")
        val context: Context = context
        val stems = parseStems(call.getString("stems"))
        val startSeconds = call.getDouble("startSeconds") ?: 0.0
        val seconds = call.getDouble("seconds")
        worker.execute {
            try {
                val generation = cancelGeneration.get()
                val started = System.currentTimeMillis()
                val decoded = TrackPcmDecoder.decode(context, url)
                    ?: return@execute call.reject("无法解码音频: $url")
                respondWithStems(call, decoded, stems, startSeconds, seconds, started, generation)
            } catch (error: Exception) {
                call.reject("四轨分离失败: ${error.message}", error)
            }
        }
    }

    /** 轨名 → 下标；认不出的名字忽略，一个都不剩就退回四轨全要。 */
    private fun parseStems(raw: String?): List<Int> {
        if (raw.isNullOrBlank()) return ScnetRunner.STEMS.indices.toList()
        val picked = raw.split(',')
            .map { it.trim().lowercase() }
            .filter { it.isNotEmpty() }
            .mapNotNull { name -> ScnetRunner.STEMS.indexOf(name).takeIf { it >= 0 } }
            .distinct()
        return picked.ifEmpty { ScnetRunner.STEMS.indices.toList() }
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
        generation: Int,
    ) {
        ensureStemEngine(context)
        val rate = decoded.sampleRate
        val from = (startSeconds * rate).toInt().coerceIn(0, decoded.samples)
        val to = if (seconds == null || seconds <= 0) {
            decoded.samples
        } else {
            (from + seconds * rate).toInt().coerceIn(from, decoded.samples)
        }
        var lastPercent = -1
        val result = ScnetRunner.separate(
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
                    event.put("name", AutomixModels.SCNET)
                    event.put("status", "analyzing")
                    event.put("percent", percent)
                    notifyListeners("modelProgress", event)
                }
            },
            cancelled = { expired(generation) },
        )
        android.util.Log.i(
            "Automix",
            "scnet: ${decoded.samples} 样本 [${from}, ${to}) -> ${result.stems.keys}，" +
                "耗时 ${System.currentTimeMillis() - started}ms" +
                if (expired(generation)) "（已取消，交回算完的部分）" else "",
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
                .put("cancelled", expired(generation)),
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
        if (!inferenceEnabled) return call.reject(INFERENCE_DISABLED_MESSAGE) // ONNX 总闸（#401），见 companion object
        val encoded = call.getString("samples") ?: return call.reject("缺少 samples")
        val context: Context = context
        worker.execute {
            try {
                val generation = cancelGeneration.get()
                val mono = decodeFloats(encoded) ?: return@execute call.reject("samples 不是 float32 数组")

                val file = AutomixModels.ensureLocal(context, AutomixModels.BEAT_THIS)
                BeatThisRunner.ensureLoaded(file)
                val started = System.currentTimeMillis()
                // 命名参数：末尾那个 lambda 是 onChunk，不是 cancelled。
                val result = BeatThisRunner.analyze(mono, cancelled = { expired(generation) })
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
     * 用 SCNet 分离一段 PCM（调用方按段喂，见 stemRange.ts）。
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
        if (!inferenceEnabled) return call.reject(INFERENCE_DISABLED_MESSAGE) // ONNX 总闸（#401），见 companion object
        val leftEncoded = call.getString("left") ?: return call.reject("缺少 left")
        val rightEncoded = call.getString("right") ?: leftEncoded
        val stems = parseStems(call.getString("stems"))
        worker.execute {
            try {
                val generation = cancelGeneration.get()
                val left = decodeFloats(leftEncoded) ?: return@execute call.reject("left 不是 float32 数组")
                val right = decodeFloats(rightEncoded) ?: return@execute call.reject("right 不是 float32 数组")
                val started = System.currentTimeMillis()
                respondWithStems(
                    call,
                    TrackPcmDecoder.Result(left, right, ScnetRunner.SAMPLE_RATE),
                    stems,
                    0.0,
                    null,
                    started,
                    generation,
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
