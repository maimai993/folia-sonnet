package top.izuna.foliamajor.player.dsp

import kotlin.math.abs

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/StereoStage.kt
// 声场宽度：中侧（M/S）加权，挂在后置均衡之后、混响之前。
//
// 为什么用 M/S 而不是「左右各加一点延时」：延时差会让单声道兼容性变差 —— 在手机
// 外放或蓝牙单声道音箱上，反相成分直接抵消，声音会变薄。M/S 只改侧向分量的权重，
// 中置（人声、底鼓）原样不动，collapse 到单声道时正好退回去，不丢东西。
//
//   M = (L + R) / 2      S = (L - R) / 2
//   L' = M + S·width     R' = M - S·width
//
// width = 0 → 完全单声道；1 → 原样；2 → 侧向加倍（宽到喇叭外面）。
// 大于 1 时峰值可能超过原信号，由链末的前瞻限幅器兜住（它本来就要处理 EQ 的增益）。
//
// 位置为什么在混响之前：混响每声道有自己的梳状延时线，本身就是立体声的。若把宽度
// 处理放在它后面，混响尾巴会被再拉宽一次，听起来像「两个房间叠在一起」。放在前面
// 只作用于干声，尾巴仍由混响自己的声道差决定。
//
// 线程：音频渲染线程，逐样本，无状态。

class StereoStage {

    /** 无状态处理，reset 只为与其他 stage 的接口保持一致（seek / flush 时调用）。 */
    fun reset() = Unit

    fun process(
        buffer: FloatArray,
        offset: Int,
        frames: Int,
        channels: Int,
        settings: StereoSettings,
    ) {
        // 单声道没有「侧」可言；宽度恰好 1 时是恒等变换，别白跑一遍。
        if (!settings.enabled || channels < 2) return
        val width = settings.width.coerceIn(0f, 2f)
        if (abs(width - 1f) < 0.001f) return

        for (frame in 0 until frames) {
            val base = offset + frame * channels
            // 成对处理；声道数为奇数时最后一个通道没有伴，原样留着。
            for (channel in 0 until channels - 1 step 2) {
                val left = buffer[base + channel]
                val right = buffer[base + channel + 1]
                val mid = (left + right) * 0.5f
                val side = (left - right) * 0.5f * width
                buffer[base + channel] = mid + side
                buffer[base + channel + 1] = mid - side
            }
        }
    }
}
