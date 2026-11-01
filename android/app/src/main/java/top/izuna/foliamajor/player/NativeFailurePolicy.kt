package top.izuna.foliamajor.player

// 后台失败的单一决策：不向冻结的 JS 回执重放；跳过仍有连续次数上限。
data class NativeFailurePolicy(val notifyWeb: Boolean, val skip: Boolean)

fun nativeFailurePolicy(uiVisible: Boolean, autoSkip: Boolean, backgroundSilentSkip: Boolean): NativeFailurePolicy =
        if (uiVisible) NativeFailurePolicy(true, autoSkip)
        else NativeFailurePolicy(false, backgroundSilentSkip)

/** 插件对没有 mediaId 的媒体报空串：空串等同「没带身份」，走旧时间窗，不能当成一个不匹配的身份丢弃（#175）。 */
fun endedIdentity(raw: String?): String? = raw?.takeIf { it.isNotEmpty() }
