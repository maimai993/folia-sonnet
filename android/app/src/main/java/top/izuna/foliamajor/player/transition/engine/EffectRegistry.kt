package top.izuna.foliamajor.player.transition.engine

import top.izuna.foliamajor.player.transition.EffectId
import top.izuna.foliamajor.player.transition.engine.effects.BarAlignedBlendEffect
import top.izuna.foliamajor.player.transition.engine.effects.BassSwapEffect
import top.izuna.foliamajor.player.transition.engine.effects.BeatCutEffect
import top.izuna.foliamajor.player.transition.engine.effects.BuildUpEffect
import top.izuna.foliamajor.player.transition.engine.effects.EchoThrowEffect
import top.izuna.foliamajor.player.transition.engine.effects.FadeOutInEffect
import top.izuna.foliamajor.player.transition.engine.effects.FilterSweepInEffect
import top.izuna.foliamajor.player.transition.engine.effects.HardCutEffect
import top.izuna.foliamajor.player.transition.engine.effects.PlainBlendEffect
import top.izuna.foliamajor.player.transition.engine.effects.PlateauBlendEffect
import top.izuna.foliamajor.player.transition.engine.effects.ReverbCarryEffect
import top.izuna.foliamajor.player.transition.engine.effects.ReverseCrescendoEffect
import top.izuna.foliamajor.player.transition.engine.effects.RiserDropEffect
import top.izuna.foliamajor.player.transition.engine.effects.TailRideEffect
import top.izuna.foliamajor.player.transition.engine.effects.TempoBendEffect
import top.izuna.foliamajor.player.transition.engine.effects.ThreeBandSeamEffect
import top.izuna.foliamajor.player.transition.engine.effects.VinylBrakeEffect
import top.izuna.foliamajor.player.transition.engine.effects.VocalRecedeEffect

// android/app/src/main/java/top/izuna/foliamajor/player/transition/engine/EffectRegistry.kt
// 可插拔注册表：18 种接法全部在这里登记。
//
// 新增一种接法 = 新建一个 BaseTransitionEffect 子类 + 在 defaults() 里加一行 +
// 在 TransitionStyle.EffectCatalog 里加一条描述。执行引擎与播放器一行不改。
// register() 也对外开放，供可选的按需下载增强包注入更高阶的效果。

object EffectRegistry {

    private val effects = HashMap<EffectId, TransitionEffect>()

    init {
        defaults().forEach { register(it) }
    }

    private fun defaults(): List<TransitionEffect> = listOf(
        PlainBlendEffect(),
        HardCutEffect(),
        FadeOutInEffect(),
        PlateauBlendEffect(),
        BassSwapEffect(),
        ThreeBandSeamEffect(),
        FilterSweepInEffect(),
        VocalRecedeEffect(),
        BeatCutEffect(),
        BarAlignedBlendEffect(),
        TempoBendEffect(),
        TailRideEffect(),
        EchoThrowEffect(),
        ReverbCarryEffect(),
        BuildUpEffect(),
        RiserDropEffect(),
        VinylBrakeEffect(),
        ReverseCrescendoEffect(),
    )

    @Synchronized
    fun register(effect: TransitionEffect) {
        effects[effect.id] = effect
    }

    @Synchronized
    fun unregister(id: EffectId) {
        effects.remove(id)
    }

    @Synchronized
    fun output(frame: EffectFrame): EffectOutput {
        val effect = effects[frame.plan.style] ?: effects[EffectId.PLAIN_BLEND]!!
        return effect.apply(frame)
    }

    @Synchronized
    fun registered(): List<String> = effects.keys.map { it.wire }.sorted()
}
