package top.izuna.foliamajor.player.transition.engine

import org.json.JSONObject

// android/app/src/main/java/top/izuna/foliamajor/player/transition/engine/TransitionCue.kt
// cue 事件：主窗口的过渡环动画 / Remote 快照 / 封面标题背景交接，都订阅同一条 cue。
//
// 对齐 Web 侧 README §8 那条纪律：动画画的是**实际音频跨度**，不是一条装饰性进度条；
// 纯淡化（plainBlend）带 plain 标记，动画用 shouldDrawCue 拒掉它 —— 它对的是音频而不是混音。

enum class CuePhase(val wire: String) {
    ARMED("armed"),
    STARTED("started"),
    PROGRESS("progress"),
    FINISHED("finished"),
    CANCELLED("cancelled"),
    PREVIEW("preview"),
}

data class TransitionCue(
    val cueId: String,
    val phase: CuePhase,
    val style: String,
    val planJson: JSONObject? = null,
    val progress: Float = 0f,
    val overlapMs: Int = 0,
    val elapsedMs: Long = 0L,
    val reason: String = "",
    val preview: Boolean = false,
) {
    val plain: Boolean get() = style == "plainBlend" || style == "fadeOutIn"

    fun toJson(): JSONObject = JSONObject().apply {
        put("cueId", cueId)
        put("phase", phase.wire)
        put("style", style)
        put("progress", progress.toDouble())
        put("overlapMs", overlapMs)
        put("elapsedMs", elapsedMs)
        put("reason", reason)
        put("preview", preview)
        put("plain", plain)
        if (planJson != null) put("plan", planJson)
    }
}
