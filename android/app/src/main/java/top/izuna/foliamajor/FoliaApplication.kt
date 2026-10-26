package top.izuna.foliamajor
import android.app.Application

/**
 * 让崩溃取证覆盖到「MainActivity 还没起来」的那段时间。
 *
 * 动态壁纸与应用同进程，而壁纸引擎是系统直接拉起的：它可能比 Activity 更早跑，
 * 那时装在 MainActivity.onCreate 里的处理器还没生效，崩了就是无声的进程死亡 ——
 * 用户看到的只是「应用打不开」，拿不到任何线索。
 *
 * 装在这里，进程内任何一处未捕获异常都会被记下来并弹崩溃界面。
 */
class FoliaApplication : Application() {

    /** 关着「同时播放」时给出去的那个：系统原装的 AudioManager。 */
    @Volatile
    private var plainAudioManager: Any? = null
    /** 开着时给出去的那个：把焦点回调换成空实现的 FoliaAudioManager。 */
    @Volatile
    private var mixedAudioManager: Any? = null

    override fun onCreate() {
        super.onCreate()
        FoliaCrashHandler.install(this)
    }

    /**
     * WebView 是通过 `getApplicationContext().getSystemService(AUDIO_SERVICE)` 拿
     * AudioManager 的（Chromium 的 `AudioFocusDelegate`），所以这里是唯一能换掉它的地方。
     *
     * **只在 AUDIO_SERVICE 这一支上做区分**，其余一律走 super —— 这个方法是所有
     * 系统服务的入口，任何多余的动作都会波及一大批调用方。
     *
     * 两个实例各自缓存：开关切换后 WebView 下一次请求焦点时会重新来问，那一问拿到
     * 的就是新的那一个（正在响的那首仍沿用切换前的，见 FoliaAudioFocus 的说明）。
     */
    override fun getSystemService(name: String): Any {
        if (android.content.Context.AUDIO_SERVICE != name) {
            return super.getSystemService(name)
        }
        if (!top.izuna.foliamajor.audio.FoliaAudioFocus.mixWithOthers(this)) {
            val plain = plainAudioManager
            if (plain == null) {
                val created = super.getSystemService(name)
                plainAudioManager = created
                return created
            }
            return plain
        }
        val existing = mixedAudioManager
        if (existing == null) {
            val created: Any = try {
                top.izuna.foliamajor.audio.FoliaAudioManager(this)
            } catch (error: Throwable) {
                /*
                 * 继承 / 构造走不通（ROM 改过 AudioManager、hidden 构造被拦下）时
                 * 退回原装那个：那不过是「同时播放」不生效，总好过整个应用起不来。
                 */
                super.getSystemService(name)
            }
            mixedAudioManager = created
            return created
        }
        return existing
    }
}
