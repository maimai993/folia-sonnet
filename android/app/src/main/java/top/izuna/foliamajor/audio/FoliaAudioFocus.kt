package top.izuna.foliamajor.audio

import android.content.Context
import android.content.SharedPreferences

/**
 * 「与其他音源同时播放」这一条策略的落盘值。
 *
 * 为什么必须落盘、而不能放在内存里等 Web 层推过来：
 * WebView 是在**它自己要请求音频焦点的那一刻**才来向 Application 要 AudioManager 的
 * （Chromium 的 `AudioFocusDelegate.requestAudioFocusInternal`）。冷启动后第一次播放
 * 就发生在这之前 —— 那时 Web 层才刚起来，还没人推过这个值。所以只有磁盘上的值
 * 能决定这一次给出去的是哪一种 AudioManager。
 *
 * 反过来说，切换开关时也必须真的写下去：原生这边是每次请求焦点时读一次，
 * 不落盘就等于「重启前一直生效、重启后回到默认」，用户会以为是 bug。
 */
class FoliaAudioFocus private constructor() {

    companion object {

        private const val PREFS = "folia_audio_focus"
        private const val KEY_MIX_WITH_OTHERS = "mix_with_others"

        @JvmStatic
        fun setMixWithOthers(context: Context?, on: Boolean) {
            if (context == null) {
                return
            }
            /*
             * 同步提交而不是 apply：Web 层紧接着就要让当前这首歌按新策略**重新请求一次**
             * 焦点（否则正在播的那首拿到的还是切换前那个 AudioManager，要等下一首才换过来），
             * 异步写盘的话那一帧读到的可能还是旧值，表现就是开关拨了但没反应。
             * 这里只在用户拨开关时走一次，同步写的那点开销无所谓。
             */
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putBoolean(KEY_MIX_WITH_OTHERS, on)
                    .commit()
        }

        @JvmStatic
        fun mixWithOthers(context: Context?): Boolean {
            if (context == null) {
                return false
            }
            return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getBoolean(KEY_MIX_WITH_OTHERS, false)
        }
    }
}
