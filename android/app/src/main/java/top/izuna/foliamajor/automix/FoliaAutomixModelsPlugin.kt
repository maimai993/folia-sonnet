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

    /**
     * 模型拷贝与推理都很重，一律放在单线程池上顺序跑。
     *
     * 单线程而不是线程池：htdemucs 一次推理峰值内存接近 500MB，
     * 两个推理并行会直接把进程撑爆 —— 排队既是省内存，也是省电。
     */
    private val worker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "folia-automix").apply { priority = Thread.NORM_PRIORITY - 1 }
    }

    override fun handleOnDestroy() {
        worker.shutdownNow()
        super.handleOnDestroy()
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
    @PluginMethod
    fun analyzeBeatsFromUrl(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) return call.reject("缺少 url")
        val context: Context = context
        worker.execute {
            try {
                val started = System.currentTimeMillis()
                val decoded = TrackPcmDecoder.decode(context, url)
                    ?: return@execute call.reject("无法解码音频: $url")
                /*
                 * beat_this 要 22050Hz 单声道。这里从 44100 双声道降到单声道
                 * 再按 2:1 抽取 —— 正好是整数倍，不需要插值。
                 */
                val mono = downmixToMono22k(decoded)
                val file = AutomixModels.ensureLocal(context, AutomixModels.BEAT_THIS)
                BeatThisRunner.ensureLoaded(file)
                val result = BeatThisRunner.analyze(mono)
                android.util.Log.i(
                    "Automix",
                    "beat_this(url): ${mono.size} 样本 -> ${result.beats.size} 个拍点，" +
                        "耗时 ${System.currentTimeMillis() - started}ms",
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
                        .put("frames", result.beatLogits.size),
                )
            } catch (error: Exception) {
                call.reject("节拍分析失败: ${error.message}", error)
            }
        }
    }

    /**
     * 用 htdemucs 分离四轨，**音频由原生自己按地址取**（不必走桥）。
     *
     * 参数：url —— 本地绝对路径，或 http(s) 地址。
     * 返回与 separateStems 完全一致（stems 里是 base64 float32），
     * 因为下游解析那段的形状不该因为取音频的方式而变。
     */
    @PluginMethod
    fun separateStemsFromUrl(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) return call.reject("缺少 url")
        val context: Context = context
        worker.execute {
            try {
                val started = System.currentTimeMillis()
                val decoded = TrackPcmDecoder.decode(context, url)
                    ?: return@execute call.reject("无法解码音频: $url")
                val file = AutomixModels.ensureLocal(context, AutomixModels.HTDEMUCS)
                HtdemucsRunner.ensureLoaded(file)
                val result = HtdemucsRunner.separate(decoded.left, decoded.right) { _, _ -> }
                android.util.Log.i(
                    "Automix",
                    "htdemucs(url): ${decoded.samples} 样本 -> ${result.stems.keys}，" +
                        "耗时 ${System.currentTimeMillis() - started}ms",
                )
                val stems = JSObject()
                for ((name, channels) in result.stems) {
                    stems.put(
                        name,
                        JSObject()
                            .put("left", encodeFloats(channels[0]))
                            .put("right", encodeFloats(channels[1])),
                    )
                }
                call.resolve(
                    JSObject()
                        .put("stems", stems)
                        .put("sampleRate", decoded.sampleRate)
                        .put("samples", decoded.samples),
                )
            } catch (error: Exception) {
                call.reject("四轨分离失败: ${error.message}", error)
            }
        }
    }

    /**
     * 44100 双声道 → 22050 单声道。
     *
     * 先左右平均（居中的人声与乐器会保留，这正是节拍检测要的），
     * 再每两个样本取一个 —— 44100/2 = 22050，整数倍抽取不需要重采样。
     */
    private fun downmixToMono22k(decoded: TrackPcmDecoder.Result): FloatArray {
        val frames = decoded.samples
        val out = FloatArray(frames / 2)
        for (i in out.indices) {
            val srcIndex = i * 2
            out[i] = (decoded.left[srcIndex] + decoded.right[srcIndex]) * 0.5f
        }
        return out
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
                val mono = decodeFloats(encoded) ?: return@execute call.reject("samples 不是 float32 数组")

                val file = AutomixModels.ensureLocal(context, AutomixModels.BEAT_THIS)
                BeatThisRunner.ensureLoaded(file)
                val started = System.currentTimeMillis()
                val result = BeatThisRunner.analyze(mono)
                android.util.Log.i(
                    "Automix",
                    "beat_this: ${mono.size} 样本 -> ${result.beats.size} 个拍点，" +
                        "耗时 ${System.currentTimeMillis() - started}ms",
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
                        .put("frames", result.beatLogits.size),
                )
            } catch (error: Exception) {
                call.reject("节拍分析失败: ${error.message}", error)
            }
        }
    }

    /**
     * 用 htdemucs 分离四轨。
     *
     * 参数：
     *   left / right —— base64 编码的 float32 小端 PCM，**必须已经是 44100Hz**。
     *                   单声道就把右声道传同一份（模型要的是立体声输入）。
     *
     * 返回每个轨的波形，同样 base64 编码 —— 调用方拿去做鼓点/人声能量用，
     * 不需要自己再解码一次格式。
     *
     * 这个调用很重：一次 3.9 秒的窗口，手机上通常几百毫秒到一两秒，
     * 一首四分钟的歌要跑几十个窗口。所以放在单线程池里排队，
     * 并且分窗口回报进度 —— 前端据此显示「分析了多少」。
     */
    @PluginMethod
    fun separateStems(call: PluginCall) {
        val leftEncoded = call.getString("left") ?: return call.reject("缺少 left")
        val rightEncoded = call.getString("right") ?: leftEncoded
        val context: Context = context
        worker.execute {
            try {
                val left = decodeFloats(leftEncoded) ?: return@execute call.reject("left 不是 float32 数组")
                val right = decodeFloats(rightEncoded) ?: return@execute call.reject("right 不是 float32 数组")

                val file = AutomixModels.ensureLocal(context, AutomixModels.HTDEMUCS)
                HtdemucsRunner.ensureLoaded(file)
                val started = System.currentTimeMillis()

                /* 进度事件：让界面知道分到哪了。窗口之间就是天然的节流点。 */
                var lastPercent = -1
                val result = HtdemucsRunner.separate(left, right) { done, total ->
                    val percent = if (total > 0) done * 100 / total else 100
                    // 每个百分点发一次就够；一个窗口往往跨好几个百分点，不会太频繁。
                    if (percent != lastPercent && percent < 100) {
                        lastPercent = percent
                        val event = JSObject()
                        event.put("name", AutomixModels.HTDEMUCS)
                        event.put("status", "analyzing")
                        event.put("percent", percent)
                        notifyListeners("modelProgress", event)
                    }
                }
                android.util.Log.i(
                    "Automix",
                    "htdemucs: ${left.size} 样本 -> ${result.stems.keys} " +
                        "耗时 ${System.currentTimeMillis() - started}ms",
                )

                val stems = JSObject()
                for ((name, channels) in result.stems) {
                    val entry = JSObject()
                    entry.put("left", encodeFloats(channels[0]))
                    entry.put("right", encodeFloats(channels[1]))
                    stems.put(name, entry)
                }
                call.resolve(
                    JSObject()
                        .put("stems", stems)
                        .put("sampleRate", result.sampleRate)
                        .put("samples", left.size),
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
