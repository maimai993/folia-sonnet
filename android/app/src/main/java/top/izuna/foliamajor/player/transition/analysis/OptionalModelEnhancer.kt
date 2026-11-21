package top.izuna.foliamajor.player.transition.analysis

import android.content.Context
import top.izuna.foliamajor.player.transition.TrackProfile
import java.io.File

// android/app/src/main/java/top/izuna/foliamajor/player/transition/analysis/OptionalModelEnhancer.kt
// 可选增强包的边界。包体纪律全在这一条：
//
//   · 核心过渡系统（本目录全部代码）是 Kotlin 算术，不进任何模型权重、不进 .so；
//   · 需要音轨分离 / 更准拍点的效果（VOCAL_RECEDE 等）标 needsEnhancer = true；
//   · 增强包**不打进 APK**，由用户在设置里按需下载，上限 18 MB；
//   · 未安装时这些效果自动从候选中剔除，其余 16 种照常可用，功能不缺失。
//
// 于是基础包增量 < 1 MB，用户愿意多花 20 MB 以内流量时再解锁更高精度。
// 这里只定义接口与安装状态检查；具体推理实现由后续的独立模块提供并通过 bind() 注入，
// 避免把可选依赖编译进主应用。

interface EnhancerPack {
    val installed: Boolean
    val sizeBytes: Long
    /**
     * 这个包真的会重算分析结果吗。
     *
     * 存在的理由：包可以「装上但推理还没绑定」（权重下好了、真正的推理模块还没注入），
     * 那时候跑的是 PassthroughEnhancer 这类占位实现 —— 它一个字都算不出来。没有这个
     * 标记的话，上层只能看到 `installed = true`，于是把 DSP 结果标成 ENHANCED、
     * 把「文件在」报成「能用」。诊断面板和档位判定都读它。
     */
    val producesAnalysis: Boolean get() = true
    /** 在 DSP 档案基础上补更准的拍点 / 人声尾标记；不允许返回 null 之外的降级信号。 */
    fun enhance(base: TrackProfile): TrackProfile?
}

object OptionalModelEnhancer {

    /** 用户可接受的上限：20 多 MB 预算里给增强包留 18 MB，其余给资源。 */
    const val MAX_PACK_BYTES = 18L * 1024L * 1024L
    private const val DIR = "transition-enhancer"
    private const val MODEL_FILE = "beat-stems-lite.bin"

    @Volatile
    private var bound: EnhancerPack? = null

    /** 由后续独立模块（动态交付）在下载完成后调用。 */
    fun bind(pack: EnhancerPack?) {
        bound = pack
    }

    fun current(): EnhancerPack? = bound?.takeIf { it.installed && it.sizeBytes <= MAX_PACK_BYTES }

    fun isInstalled(context: Context): Boolean = modelFile(context).let {
        it.exists() && it.length() in 1L..MAX_PACK_BYTES
    } || current() != null

    fun installedSize(context: Context): Long = modelFile(context).takeIf { it.exists() }?.length() ?: 0L

    fun modelFile(context: Context): File = File(context.filesDir, "$DIR/$MODEL_FILE")

    /** 诊断面板用：把「浏览器做不到」和「权重还没下」分开报，对齐 Web 侧 §7 的纪律。 */
    fun capabilities(context: Context): Map<String, Any> = mapOf(
        "dspAnalysis" to true,
        "beatGrid" to true,
        "stems" to isInstalled(context),
        "enhancerInstalled" to isInstalled(context),
        // 「文件在」不等于「推理能用」：占位实现占着位置时如实报 false（issue H21）。
        "enhancerActive" to (current()?.producesAnalysis == true),
        "enhancerBytes" to installedSize(context),
        "enhancerMaxBytes" to MAX_PACK_BYTES,
    )
}

/**
 * 占位实现：只复述 DSP 档案，用于让「增强包已安装但推理未绑定」时链路仍可跑通。
 * 真正的模型推理不在这里 —— 它属于按需下载模块，不参与主 APK 编译。
 *
 * 它**不能**假装自己增强过（issue H21）：
 *   · 以前这里把拍点置信度 +0.05 再交出去，等于凭空捏造了一个「更准」的信号，
 *     下游据此把档位标成 ENHANCED，用户看到的精度提升是假的；
 *   · 现在原样返回，并且 `producesAnalysis = false`，让上层知道「包在、推理不在」。
 */
class PassthroughEnhancer(override val sizeBytes: Long) : EnhancerPack {
    override val installed: Boolean get() = true
    override val producesAnalysis: Boolean get() = false
    override fun enhance(base: TrackProfile): TrackProfile = base
}
