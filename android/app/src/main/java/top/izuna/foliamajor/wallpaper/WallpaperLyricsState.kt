package top.izuna.foliamajor.wallpaper

import android.content.Context
import android.content.SharedPreferences
import android.os.SystemClock

/**
 * 壁纸与应用之间的歌词中转站。
 *
 * 动态壁纸（LyricsWallpaperService）和应用跑在**同一个进程**里（同一个 APK 的
 * WallpaperService 由系统在本进程内实例化），所以不需要跨进程 IPC，进程内的静态引用就够了。
 *
 * 关键设计：**这里存的是整条时间轴，而不是「当前行」。**
 * 应用退到后台后，WebView 的 JS 定时器会被系统挂起；靠 JS 每 100ms 推一次「当前行」的话，
 * 后台时推送一停，歌词就永远停在那一句。所以改成：换歌时下发一次完整时间轴，
 * 播放中只偶尔推一个「时间锚点」（某时刻对应播放到第几毫秒），
 * 之后由原生按墙钟自己往前推 —— JS 就算再也不推，歌词也照样往下走。
 *
 * 时间轴与慢字段另外落一份 SharedPreferences：进程被回收后壁纸会被重新拉起，
 * 那时应用可能根本没启动过。
 */
class WallpaperLyricsState private constructor() {

    class TimedLine {
        @JvmField val text: String
        @JvmField val startMs: Long
        @JvmField val endMs: Long
        /**
         * 翻译行。null = 这一行没有翻译（不是空串 —— 空串会让下游分不清「没有」和「有但是空」，
         * 而过桥时传 null 会变成 JSONObject.NULL，读出来是字符串 "null"）。
         */
        @JvmField val translation: String?

        /**
         * 逐字（逐词）时间轴。**不落盘** —— 见 persist 那边的说明。
         *
         * 没有它，叠层只能把整行当成一个「词」来渲染，后果有两个：歌词是**整一段**
         * 冒出来的（播放器里是一个字一个字推进的），以及 AI 主题的关键词着色会命中
         * 这唯一那个 token、把整行都染成高亮色。
         */
        @JvmField val words: Array<TimedWord>?

        constructor(text: String?, startMs: Long, endMs: Long) : this(text, startMs, endMs, null, null)

        constructor(text: String?, startMs: Long, endMs: Long, translation: String?) :
                this(text, startMs, endMs, translation, null)

        constructor(text: String?, startMs: Long, endMs: Long, translation: String?, words: Array<TimedWord>?) {
            this.text = text ?: ""
            this.startMs = startMs
            this.endMs = endMs
            this.translation = translation
            this.words = if (words == null || words.isEmpty()) null else words
        }
    }

    /** 一行里的一个片段（一个英文词，或中文的一个字）。 */
    class TimedWord(text: String?, startMs: Long, endMs: Long) {
        @JvmField val text: String = text ?: ""
        @JvmField val startMs: Long = startMs
        @JvmField val endMs: Long = endMs
    }

    class Snapshot internal constructor(
            title: String?,
            artist: String?,
            cover: String?,
            accent: Int,
            baseColor: Int,
            motion: Float,
            backgroundMode: String?,
            image: String?,
            font: String?,
            visualizerMode: String?,
            blur: Float,
            showProgress: Boolean,
            showTranslation: Boolean,
            durationMs: Long,
            lines: Array<TimedLine>?,
            playing: Boolean,
            anchorElapsedMs: Long,
            anchorPositionMs: Long,
            stamp: Long
    ) {
        @JvmField val title: String = title ?: ""
        @JvmField val artist: String = artist ?: ""
        @JvmField val cover: String? = cover
        @JvmField val accent: Int = accent
        /** 与 App 当前主题一致的底色，避免壁纸和 App 两套色调。 */
        @JvmField val baseColor: Int = baseColor
        /** 动效强度：calm 0.6 / normal 1.0 / chaotic 1.5，沿用 App 主题的 animationIntensity。 */
        @JvmField val motion: Float = motion
        /** 背景模式：cover = 模糊封面，color = 主题色渐变，image = 用户自选图片。 */
        @JvmField val backgroundMode: String = backgroundMode ?: "cover"
        /**
         * 自选背景图的 key（见 WallpaperBackgroundImage）。只在 mode=image 时生效。
         * 存的是「当前磁盘上是哪张图」的轻量判据，不是图本身 —— 图在私有文件里，
         * 进程怎么重启都在，也不会有几百 KB 的字符串在桥上反复传。
         */
        @JvmField val image: String? = image
        /**
         * 歌词字体的 key（见 WallpaperLyricsFont）；null = 用系统 sans-serif。
         * 同理只存判据，字体文件本身在私有目录里。
         */
        @JvmField val font: String? = font
        /** App 当前的可视化模式，决定壁纸的动画风格（见 LyricsRenderer 的风格表）。 */
        @JvmField val visualizerMode: String = visualizerMode ?: "sonnet"
        /** 背景模糊强度 0..1。作用于模糊封面与自选背景图：0 保留原图清晰度，1 糊成色块。 */
        @JvmField val blur: Float = if (blur < 0f) 0f else if (blur > 1f) 1f else blur
        /** 是否在歌词上方画一条整首歌的进度条。 */
        @JvmField val showProgress: Boolean = showProgress
        /** 是否在主行下面再画一行翻译。没翻译的行不会因此多出空行。 */
        @JvmField val showTranslation: Boolean = showTranslation
        /** 整首歌时长（毫秒）。0 = 未知（应用没给 / 流媒体），此时不画进度条。 */
        @JvmField val durationMs: Long = if (durationMs > 0L) durationMs else 0L
        @JvmField val lines: Array<TimedLine>
        /** 整条时间轴里有没有任何一行带翻译。没有的话行距不用为翻译留位置。 */
        @JvmField val hasTranslation: Boolean
        @JvmField val playing: Boolean = playing
        /** 锚点：elapsedRealtime 为 anchorElapsedMs 时，播放位置是 anchorPositionMs。 */
        @JvmField val anchorElapsedMs: Long = anchorElapsedMs
        @JvmField val anchorPositionMs: Long = anchorPositionMs
        @JvmField val stamp: Long = stamp
        /**
         * 这一份歌词是「纯音乐」占位，不是真歌词。
         *
         * 没有歌词时不能什么都不画 —— 那样整块屏幕就是黑的，看着像坏了。
         * 所以在构造点补一行占位文案交给正常的歌词管线去画。
         * 但叠层那边「纯音乐不显示」的判定要看这个标记，而不是看行数为 0，
         * 否则占位行会被当成真歌词、开关就失效了。
         */
        @JvmField val placeholderOnly: Boolean

        init {
            var resolvedLines: Array<TimedLine> = lines ?: emptyArray()
            // 有歌但没有歌词 = 纯音乐：补一行占位文案，别让屏幕空着。
            // 冷启动（连歌都没有）不补 —— 那种情况走的是待机配色，不该出现"纯音乐"字样。
            val instrumental = resolvedLines.isEmpty() && !this.title.isEmpty()
            if (instrumental) {
                // 6 秒走完这一行的扫光，之后就是常亮，不会整首歌慢慢划过去。
                resolvedLines = arrayOf(TimedLine(INSTRUMENTAL_TEXT, 0L, 6000L))
            }
            this.lines = resolvedLines
            this.placeholderOnly = instrumental
            this.hasTranslation = scanForTranslation(resolvedLines)
        }

        companion object {
            private fun scanForTranslation(lines: Array<TimedLine>): Boolean {
                for (line in lines) {
                    if (line != null && line.translation != null && !line.translation.trim().isEmpty()) {
                        return true
                    }
                }
                return false
            }
        }

        /** 按墙钟推算当前播放位置。暂停时冻结在锚点上。 */
        fun positionMs(): Long {
            if (!playing) {
                return anchorPositionMs
            }
            val position = anchorPositionMs + (SystemClock.elapsedRealtime() - anchorElapsedMs)
            /*
             * 外推不许越过歌曲末尾。
             *
             * 只要漏掉一次 playing=false（Web 层在后台被挂起而没推过来、进程被杀、
             * 命令丢失），这里就会一路加下去。越界之后 indexAt() 恒返回最后一行、
             * progressAt() 恒为 1，屏幕上看到的就是「歌词停住不动」—— 而它看起来
             * 跟「歌放完了」一模一样，很难一眼分辨。夹住之后，最坏也只是停在末尾
             * 那一句，而不是跑到时间轴外面去；真正的修复在上面的同步点。
             */
            if (durationMs > 0L && position > durationMs) {
                return durationMs
            }
            return position
        }

        /** 当前行下标：取最后一个 start <= position 的行。 */
        fun indexAt(positionMs: Long): Int {
            if (lines.isEmpty()) {
                return 0
            }
            var low = 0
            var high = lines.size - 1
            var found = 0
            while (low <= high) {
                val mid = (low + high) ushr 1
                if (lines[mid].startMs <= positionMs) {
                    found = mid
                    low = mid + 1
                } else {
                    high = mid - 1
                }
            }
            return found
        }

        /** 行内进度 0..1。两句之间的空档按「上一句唱完」处理。 */
        fun progressAt(positionMs: Long): Float {
            val index = indexAt(positionMs)
            if (lines.isEmpty()) {
                return 0f
            }
            val line = lines[index]
            val span = line.endMs - line.startMs
            if (span <= 0) {
                return 1f
            }
            val progress = (positionMs - line.startMs) / span.toFloat()
            return if (progress < 0f) 0f else if (progress > 1f) 1f else progress
        }

        fun isEmpty(): Boolean {
            return lines.isEmpty()
        }
    }

    companion object {
        private const val PREFS = "folia_wallpaper_lyrics"
        private const val KEY_TITLE = "title"
        private const val KEY_ARTIST = "artist"
        private const val KEY_TIMELINE = "timeline"
        private const val KEY_POSITION = "position"
        private const val KEY_PLAYING = "playing"
        private const val KEY_ACCENT = "accent"
        private const val KEY_BACKGROUND = "background"
        private const val KEY_BASE = "base"
        private const val KEY_MOTION = "motion"
        private const val KEY_STAMP = "stamp"
        private const val KEY_VISUALIZER = "visualizer"
        private const val KEY_BLUR = "blur"
        private const val KEY_PROGRESS = "progress"
        private const val KEY_TRANSLATION = "translation"
        private const val KEY_TUNING = "tuning"
        private const val KEY_DURATION = "duration"
        /** 行分隔符与字段分隔符都挑不可能出现在歌词里的字符。 */
        private const val LINE_SEPARATOR = "␟"
        private const val FIELD_SEPARATOR = "␞"
        private const val TUNING_PAIR_SEPARATOR = "␝"
        private const val TUNING_VALUE_SEPARATOR = "␜"

        /** 与应用默认值一致（useVisualizerSettingsStore 的 DEFAULT_WALLPAPER_BLUR）。 */
        internal const val DEFAULT_BLUR = 0.35f

        /** 纯音乐时的占位文案。没有歌词就画它，别留一块黑屏。 */
        private const val INSTRUMENTAL_TEXT = "纯音乐，请欣赏"

        /*
         * 封面的**原始地址**。
         *
         * 不进 Snapshot：那边的构造器已经有十几个参数了，而这份数据只有一个消费者
         * （叠层页面）。base64 那份（`Snapshot.cover`）是 App 抓图转出来的，
         * 转不成时它就不动 —— 叠层于是永远挂着上一首的封面，看起来就是「封面不更新」。
         * 地址短、每首必变，叠层能直接 `<img>` 去拉，所以单独存一份。
         */
        private var lastCoverUrl: String? = null

        /** 只在非空时更新：心跳那几次 publish 不带封面，不能把已有地址清掉。 */
        @JvmStatic
        fun setCoverUrl(coverUrl: String?) {
            if (coverUrl != null && !coverUrl.isEmpty()) {
                lastCoverUrl = coverUrl
            }
        }

        @JvmStatic
        fun coverUrl(): String? {
            return lastCoverUrl
        }

        /**
         * 原生兜底切歌后由服务直接发布歌词与歌名（见 MusicGateway 的说明）。
         *
         * WebView 冻结时 Web 那条 publish（换歌推整条时间轴）不会来，壁纸只能停在上
         * 一首 —— 这里就地换掉标题、歌手、时间轴与时长，其余外观字段沿用当前快照，
         * 别让一首歌换到一半把用户选的背景/配色也冲掉。
         * 位置从 0 起播（原生刚 prepare 完），playing 置真。
         */
        @JvmStatic
        fun publishNativeTrack(title: String?, artist: String?, coverUrl: String?,
                               durationMs: Long, lines: Array<TimedLine>?) {
            if (lines == null || lines.isEmpty()) {
                return
            }
            heartbeat()
            setCoverUrl(coverUrl)
            val previous = current
            current = Snapshot(
                    if (title != null && !title.isEmpty()) title else previous.title,
                    if (artist != null && !artist.isEmpty()) artist else previous.artist,
                    previous.cover,
                    previous.accent, previous.baseColor, previous.motion,
                    previous.backgroundMode, previous.image, previous.font,
                    previous.visualizerMode, previous.blur,
                    previous.showProgress, previous.showTranslation,
                    if (durationMs > 0L) durationMs else previous.durationMs,
                    lines, true,
                    SystemClock.elapsedRealtime(), 0L,
                    System.currentTimeMillis())
        }

        /**
         * 原生把封面下载下来之后顺手喂给壁纸：GLES 那层的封面是 base64，
         * WebView 冻结时 Web 抓 base64 那条路不会跑，只能从通知栏那份位图来。
         */
        @JvmStatic
        fun setCoverData(coverBase64: String?) {
            if (coverBase64 == null || coverBase64.isEmpty()) {
                return
            }
            val previous = current
            current = Snapshot(previous.title, previous.artist, coverBase64,
                    previous.accent, previous.baseColor, previous.motion,
                    previous.backgroundMode, previous.image, previous.font,
                    previous.visualizerMode, previous.blur,
                    previous.showProgress, previous.showTranslation,
                    previous.durationMs, previous.lines, previous.playing,
                    previous.anchorElapsedMs, previous.anchorPositionMs,
                    System.currentTimeMillis())
        }

        private val EMPTY: Snapshot = Snapshot(
                "", "", null, 0xFF7C5CFF.toInt(), 0xFF09090B.toInt(), 1f, "cover", null, null, "sonnet",
                DEFAULT_BLUR, true, true, 0L, emptyArray<TimedLine>(), false, 0L, 0L, 0L)

        @Volatile
        private var current: Snapshot = EMPTY

        // ===== seek 回弹守卫 =====
        // 通知栏进度条拖动时，服务（onSeekTo）先把锚点对齐到目标位置；随后 JS 那边才收到
        // seek 命令、音频还没真 seek 过去，timeupdate 报的还是旧位置。这一份「位置回退」的
        // 推送如果在窗口期内被收下，叠层就是用户看到的「先弹到新位置、又弹回旧位置、
        // 再跳回新位置」。所以原生 seek 之后的短时间内，明显往回跳的推送一律丢掉位置。
        @Volatile
        private var nativeSeekAtMs = 0L
        @Volatile
        private var nativeSeekPositionMs = 0L
        private const val SEEK_GUARD_WINDOW_MS = 600L
        private const val SEEK_GUARD_TOLERANCE_MS = 400L

        /**
         * 原生侧的一次「真 seek」：写锚点的同时打开回弹守卫窗。
         * 只有通知栏 / 锁屏拖进度条这条路走这里；播放 / 暂停的对齐（syncWallpaperAnchor）
         * 位置取自快照自己，不存在回退，照旧走 {@link #setAnchor}。
         */
        @JvmStatic
        fun setSeekAnchor(positionMs: Long, playing: Boolean) {
            nativeSeekAtMs = SystemClock.elapsedRealtime()
            nativeSeekPositionMs = positionMs
            setAnchor(positionMs, playing)
        }

        /** 这一推是不是 seek 守卫窗内的位置回退。 */
        private fun isSeekRegression(positionMs: Long): Boolean {
            val since = SystemClock.elapsedRealtime() - nativeSeekAtMs
            if (since < 0L || since > SEEK_GUARD_WINDOW_MS) {
                return false
            }
            return positionMs < nativeSeekPositionMs - SEEK_GUARD_TOLERANCE_MS
        }

        // ===== 心跳 =====
        // 「锚点 + 墙钟」模型有个盲区：它只会一直往前走，没人告诉它播放还活着没有。
        // 应用被划掉后台之后 WebView 没了、桥上的推送停了，但进程（连同这份静态状态）
        // 还活着 —— 歌词就照着最后一首歌的时间轴一路走到头，进度条走满，什么都停不下来。
        //
        // 心跳 = 「播放管线还活着」的定期信号。写锚点的一方顺手戳一下（Web 的推送、
        // 播放服务的巡检，见 FoliaPlaybackService 的 heartbeatTick），渲染入口
        // （LyricsRenderer / 两层叠层）自己每帧/每轮巡检查 —— 超时就不画歌词和进度条，
        // 只留背景。每个绘制入口都要自己读（老教训：指望别人转发开关一定会漏）。
        @Volatile
        private var lastHeartbeatAtMs = 0L

        /**
         * 心跳超时。发心跳的节拍是 2 秒（JS 定时器与播放服务巡检都是），
         * 8 秒 = 容得下四次没接着；再长的话划掉后台之后歌词要多挂好几秒才收。
         */
        const val HEARTBEAT_TIMEOUT_MS = 8000L

        /** 播放管线还活着：由任何一方（Web 推送 / 播放服务巡检）定期调用。 */
        @JvmStatic
        fun heartbeat() {
            lastHeartbeatAtMs = SystemClock.elapsedRealtime()
        }

        /**
         * 心跳是否还新鲜。从未跳过（0）视为活着：冷启动恢复出来的那份是**暂停态**
         * （restore 里 playing 固定 false），歌词冻着不会自己跑，不算「没人管还在走」。
         */
        @JvmStatic
        fun heartbeatAlive(): Boolean {
            val last = lastHeartbeatAtMs
            if (last == 0L) {
                return true
            }
            val age = SystemClock.elapsedRealtime() - last
            // age < 0 只可能是换了个时间的时钟（不至于发生），按过期处理更稳。
            return age >= 0L && age <= HEARTBEAT_TIMEOUT_MS
        }

        // ===== 主题推送按内容去重 =====
        // 切歌那一推本来就被「等主题落定」的闸按住，但闸放开之后仍可能连着来两份：
        // 一份主题在途、一份主题落定（或封面补到）。叠层每收一次整包就重画一次，
        // 于是换一首歌闪两下。既然两份的内容一样，第二份就根本不该重贴 ——
        // 判据不是「publish 来了几次」，而是「渲染出来的东西变没变」。
        private var lastPalettePrimary: String? = null
        private var lastPaletteSecondary: String? = null
        private var lastPaletteThemeJson: String? = null

        /** 最近一次写进磁盘的自选图，用来跳过重复写入。 */
        private var lastStoredImage: String? = null
        private var lastStoredKey: String? = null
        /** 当前歌词字体的 key。字体不随换歌变化，所以只在 setFont 时更新。 */
        private var currentFontKey: String? = null

        /**
         * 歌词动画实验台里那一整套可调项（每个模式十几二十个，十几个模式合计一百多项）。
         *
         * 为什么不逐个做成 Snapshot 的字段：每加一项就要改构造器、七个调用点、还有落盘格式。
         * 这里用一张扁平的键值表：Web 侧每次只下发**当前生效那个模式**自己的字段名，
         * 原生按表名取值。同名冲突不存在 —— 同一时刻只有一个模式在渲染。
         */
        @Volatile
        private var tuning: Map<String, Float> = emptyMap()

        @JvmStatic
        fun tuning(): Map<String, Float> {
            return tuning
        }

        /** null 表示「这次没带配置来」，沿用上一次的。 */
        private fun resolveTuning(incoming: Map<String, Float>?): Map<String, Float> {
            return if (incoming == null) tuning else java.util.Collections.unmodifiableMap(incoming) as Map<String, Float>
        }

        @JvmStatic
        fun get(): Snapshot {
            return current
        }

        /**
         * 只翻「播 / 停」，位置**按外推后的当前值重新起算**。
         *
         * 这是同步播放状态时该用的那一个：调用方（播放服务在通知栏 / 锁屏按下的那一刻）
         * 并不知道真实位置，知道的是「屏幕上此刻画到哪儿了」—— 那就把外推结果当作新锚点，
         * 这样 playing 翻转不会让画面跳，也不会把别处刚写进去的位置盖掉。
         *
         * 与 {@link #setAnchor} 的区别：那个是「我告诉你位置是多少」，位置由调用方负责，
         * 用错地方就会把拖动后的新位置顶回旧值（见 FoliaPlaybackService 里那条注释）。
         */
        @JvmStatic
        fun setPlaying(playing: Boolean) {
            heartbeat()
            val previous = current
            if (previous.playing == playing) {
                // 同一个状态重复同步：什么都不用做，别白白重设锚点。
                return
            }
            current = Snapshot(previous.title, previous.artist, previous.cover, previous.accent,
                    previous.baseColor, previous.motion, previous.backgroundMode, previous.image,
                    previous.font, previous.visualizerMode, previous.blur, previous.showProgress,
                    previous.showTranslation, previous.durationMs, previous.lines, playing,
                    SystemClock.elapsedRealtime(), previous.positionMs(), previous.stamp)
        }

        /** 播放位置推进：只更新锚点，不动时间轴，也不落盘。 */
        @JvmStatic
        fun setAnchor(positionMs: Long, playing: Boolean) {
            // 谁能写锚点谁就活着（Web 推送、播放服务、原生 seek），顺手把心跳带上。
            heartbeat()
            val previous = current
            var anchorPosition = positionMs
            if (isSeekRegression(anchorPosition)) {
                // seek 守卫窗内的旧位置回推：位置丢弃，playing 照收 —— 那是独立的事实。
                // 锚点沿用快照里已有的（原生 seek 刚写进去的那个）。
                anchorPosition = previous.anchorPositionMs
            }
            current = Snapshot(previous.title, previous.artist, previous.cover, previous.accent,
                    previous.baseColor, previous.motion, previous.backgroundMode, previous.image,
                    previous.font, previous.visualizerMode, previous.blur, previous.showProgress,
                    previous.showTranslation, previous.durationMs, previous.lines, playing,
                    SystemClock.elapsedRealtime(), anchorPosition, previous.stamp)
        }

        /**
         * 换歌词字体。base64 为空表示清除、回落到系统 sans-serif。
         * 字体不进 `publish`：它跟歌无关，没必要每次换歌都跟着走一遍。
         */
        @JvmStatic
        fun setLyricsFont(context: Context?, fontBase64: String?) {
            currentFontKey = if (fontBase64 == null || fontBase64.trim().isEmpty())
                WallpaperLyricsFont.store(context, null)
            else
                WallpaperLyricsFont.store(context, fontBase64)
            applyFontKey()
        }

        /**
         * 「跟随播放页」：网页把播放页那个字体的字节托管过来。
         *
         * 播放页的字体是网页侧用 FontFace 注册的（字节在 IndexedDB 里），原生两层
         * （壁纸渲染器、精简小窗）是自绘的、根本读不到，只能由网页把字节推下来落盘。
         * 走**另一个文件**（见 WallpaperLyricsFont 的两个槽位），不碰用户自己挑的那份。
         * 传 null / 空串 = 播放页没有自定义字体，回落系统字体。
         */
        @JvmStatic
        fun setFollowLyricsFont(context: Context?, fontBase64: String?) {
            currentFontKey = WallpaperLyricsFont.storeFollow(context, fontBase64)
            applyFontKey()
        }

        /** 原生已经把字体文件拷好了（系统文件选择器路径），这里只把新 key 同步进状态。 */
        @JvmStatic
        fun refreshLyricsFont(context: Context?) {
            currentFontKey = WallpaperLyricsFont.key(context)
            applyFontKey()
        }

        /**
         * 走系统文件选择器：原生自己把 URI 指向的文件拷进私有目录，再同步 key。
         * 返回拷贝后的 key，null = 没拷成功（用户取消 / 选中文件读不了 / 不是合法字体）。
         */
        @JvmStatic
        fun setLyricsFontFromUri(context: Context?, uri: android.net.Uri?): String? {
            currentFontKey = WallpaperLyricsFont.copyFrom(context, uri)
            applyFontKey()
            return currentFontKey
        }

        private fun applyFontKey() {
            val previous = current
            current = Snapshot(previous.title, previous.artist, previous.cover, previous.accent,
                    previous.baseColor, previous.motion, previous.backgroundMode, previous.image,
                    currentFontKey, previous.visualizerMode, previous.blur, previous.showProgress,
                    previous.showTranslation, previous.durationMs, previous.lines, previous.playing,
                    previous.anchorElapsedMs, previous.anchorPositionMs, previous.stamp)
        }

        @JvmStatic
        fun publish(context: Context?, title: String?, artist: String?, cover: String?,
                    accent: Int, baseColor: Int, motion: Float, backgroundMode: String?,
                    imageBase64: String?, visualizerMode: String?, blur: Float,
                    showProgress: Boolean?, showTranslation: Boolean?, durationMs: Long,
                    lines: Array<TimedLine>?, tuningPatch: Map<String, Float>?,
                    positionMs: Long, playing: Boolean) {
            val previous = current
            heartbeat()
            tuning = resolveTuning(tuningPatch)
            // seek 守卫窗内的位置回退：整包推送也照丢。锚点沿用快照里已有的（原生 seek
            // 刚写进去的那个），其余字段照常更新。
            var anchorElapsedMs = SystemClock.elapsedRealtime()
            var anchorPositionMs = positionMs
            if (isSeekRegression(positionMs)) {
                anchorElapsedMs = previous.anchorElapsedMs
                anchorPositionMs = previous.anchorPositionMs
            }
            var next = Snapshot(
                    if (title != null) title else previous.title,
                    if (artist != null) artist else previous.artist,
                    if (cover != null) cover else previous.cover,
                    if (accent != 0) accent else previous.accent,
                    if (baseColor != 0) baseColor else previous.baseColor,
                    if (motion > 0f) motion else previous.motion,
                    if (backgroundMode != null) backgroundMode else previous.backgroundMode,
                    storeImage(context, imageBase64),
                    previous.font,
                    if (visualizerMode != null) visualizerMode else previous.visualizerMode,
                    if (blur >= 0f) blur else previous.blur,
                    if (showProgress != null) showProgress else previous.showProgress,
                    if (showTranslation != null) showTranslation else previous.showTranslation,
                    if (durationMs >= 0L) durationMs else previous.durationMs,
                    if (lines != null) lines else previous.lines,
                    playing,
                    anchorElapsedMs,
                    anchorPositionMs,
                    System.currentTimeMillis())
            // 同内容不重贴：叠层看到「签名变了」才会重画整包，而签名里带着 stamp。
            // 渲染内容与上一份完全相同（主题在途/落定的两连推就是这种）时沿用旧 stamp，
            // 叠层那次推送整个跳过。主题要单独看：它存在 WallpaperThemePalette 的小表里、
            // 不进 Snapshot，主题真的换了时 stamp 必须前进，否则叠层永远拿不到新主题。
            if (renderedContentEquals(previous, next) && !paletteChanged(context)) {
                next = Snapshot(next.title, next.artist, next.cover, next.accent, next.baseColor,
                        next.motion, next.backgroundMode, next.image, next.font,
                        next.visualizerMode, next.blur, next.showProgress, next.showTranslation,
                        next.durationMs, next.lines, next.playing, next.anchorElapsedMs,
                        next.anchorPositionMs, previous.stamp)
            }
            current = next
            if (context != null && (lines != null || tuningPatch != null)) {
                persist(context, next)
            }
        }

        /**
         * 叠层会渲染的字段是否与上一份完全相同。
         * 位置 / 播放态不参与 —— 那两个走锚点，签名里本来就有，不靠 stamp。
         */
        private fun renderedContentEquals(a: Snapshot, b: Snapshot): Boolean {
            return a.title == b.title
                    && a.artist == b.artist
                    && (if (a.cover == null) b.cover == null else a.cover == b.cover)
                    && a.accent == b.accent
                    && a.baseColor == b.baseColor
                    && a.motion == b.motion
                    && a.backgroundMode == b.backgroundMode
                    && (if (a.image == null) b.image == null else a.image == b.image)
                    && a.visualizerMode == b.visualizerMode
                    && a.blur == b.blur
                    && a.showProgress == b.showProgress
                    && a.showTranslation == b.showTranslation
                    && a.durationMs == b.durationMs
                    && linesEqual(a.lines, b.lines)
        }

        private fun linesEqual(a: Array<TimedLine>?, b: Array<TimedLine>?): Boolean {
            if (a === b) return true
            if (a == null || b == null || a.size != b.size) return false
            for (i in a.indices) {
                val left = a[i]
                val right = b[i]
                if (left === right) continue
                if (left == null || right == null) return false
                if (left.startMs != right.startMs || left.endMs != right.endMs) return false
                if (left.text != right.text) return false
                if (if (left.translation == null) right.translation != null
                    else left.translation != right.translation) {
                    return false
                }
            }
            return true
        }

        /**
         * 主题三元组（主色 / 次色 / 整份主题 JSON）相对上一次 publish 有没有变。
         * FoliaWallpaperPlugin 在调 publish 之前已经把新的三元组写进偏好表了，
         * 这里读出来跟缓存比对并刷新缓存。首次（缓存还是 null）不算变：
         * 那时快照也刚从 EMPTY 出发，签名本来就会变。
         */
        private fun paletteChanged(context: Context?): Boolean {
            if (context == null) return false
            val palette = WallpaperThemePalette.read(context)
            val themeJson = WallpaperThemePalette.readThemeJson(context)
            val changed = lastPalettePrimary != null && (
                    !nullSafeEquals(lastPalettePrimary, palette[0])
                            || !nullSafeEquals(lastPaletteSecondary, palette[1])
                            || !nullSafeEquals(lastPaletteThemeJson, themeJson))
            lastPalettePrimary = palette[0]
            lastPaletteSecondary = palette[1]
            lastPaletteThemeJson = themeJson
            return changed
        }

        private fun nullSafeEquals(a: String?, b: String?): Boolean {
            return if (a == null) b == null else a == b
        }

        /** 只改外观（背景模式 / 自选图 / 可视化风格），不动时间轴，也避免整条时间轴重新落盘。 */
        @JvmStatic
        fun setAppearance(context: Context?, backgroundMode: String?, imageBase64: String?,
                          visualizerMode: String?, blur: Float, showProgress: Boolean?,
                          showTranslation: Boolean?, durationMs: Long,
                          tuningPatch: Map<String, Float>?) {
            val previous = current
            heartbeat()
            tuning = resolveTuning(tuningPatch)
            val next = Snapshot(previous.title, previous.artist, previous.cover,
                    previous.accent, previous.baseColor, previous.motion,
                    if (backgroundMode != null) backgroundMode else previous.backgroundMode,
                    storeImage(context, imageBase64),
                    previous.font,
                    if (visualizerMode != null) visualizerMode else previous.visualizerMode,
                    if (blur >= 0f) blur else previous.blur,
                    if (showProgress != null) showProgress else previous.showProgress,
                    if (showTranslation != null) showTranslation else previous.showTranslation,
                    if (durationMs >= 0L) durationMs else previous.durationMs,
                    previous.lines, previous.playing, previous.anchorElapsedMs,
                    previous.anchorPositionMs, previous.stamp)
            current = next
            if (context != null) {
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .edit()
                        .putString(KEY_BACKGROUND, next.backgroundMode)
                        .putString(KEY_VISUALIZER, next.visualizerMode)
                        .putInt(KEY_BASE, next.baseColor)
                        .putInt(KEY_ACCENT, next.accent)
                        .putFloat(KEY_MOTION, next.motion)
                        .putFloat(KEY_BLUR, next.blur)
                        .putBoolean(KEY_PROGRESS, next.showProgress)
                        .putBoolean(KEY_TRANSLATION, next.showTranslation)
                        .putString(KEY_TUNING, encodeTuning(tuning))
                        .putLong(KEY_DURATION, next.durationMs)
                        .apply()
            }
        }

        @JvmStatic
        fun clear(context: Context?) {
            current = EMPTY
            if (context != null) {
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
            }
            // 关掉推送不等于放弃选好的图：下次开回来还要用。图只在用户主动清除时才删。
        }

        /** 忘掉自选图（用户点「清除图片」）。 */
        @JvmStatic
        fun clearBackgroundImage(context: Context?) {
            lastStoredImage = null
            lastStoredKey = null
            WallpaperBackgroundImage.store(context, null)
            val previous = current
            current = Snapshot(previous.title, previous.artist, previous.cover, previous.accent,
                    previous.baseColor, previous.motion, previous.backgroundMode, null,
                    previous.font, previous.visualizerMode, previous.blur, previous.showProgress,
                    previous.showTranslation, previous.durationMs, previous.lines, previous.playing,
                    previous.anchorElapsedMs, previous.anchorPositionMs, previous.stamp)
        }

        /**
         * 把 Web 侧给的自选图写成文件，只在图真的换了时才动磁盘 ——
         * `publish` 每次换歌都会走一遍，重复写一张几百 KB 的图没意义。
         */
        private fun storeImage(context: Context?, base64: String?): String? {
            if (context == null) {
                return lastStoredKey
            }
            if (base64 == null) {
                // 没带图来：图可能来自上一次进程（文件还在），也可能用户已经清掉了。
                // 这里不删文件，只是沿用磁盘现状，避免把上一轮的图误删。
                if (lastStoredImage == null) {
                    lastStoredKey = WallpaperBackgroundImage.key(context)
                }
                return lastStoredKey
            }
            if (base64 == lastStoredImage && lastStoredKey != null) {
                return lastStoredKey
            }
            lastStoredImage = base64
            lastStoredKey = WallpaperBackgroundImage.store(context, base64)
            return lastStoredKey
        }

        /**
         * 进程被拉起时把落盘的时间轴与外观读回来。
         *
         * **只在内存还是空的时候才恢复。** 壁纸服务由系统按需绑定，绑定时机可能晚于应用已经推过
         * 一轮状态 —— 那时无条件覆盖会把刚设好的自选背景图冲掉，表现就是「选了图还是纯色」。
         * 冷启动时内存必然是 EMPTY，恢复如期发生；热路径则一律不打断现有状态。
         */
        @JvmStatic
        fun restore(context: Context?) {
            if (context == null || current !== EMPTY) {
                return
            }
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (!prefs.contains(KEY_BACKGROUND) && !prefs.contains(KEY_TIMELINE)) {
                return
            }
            val joined = prefs.getString(KEY_TIMELINE, null)
            val encoded: List<String> = if (joined == null || joined.isEmpty())
                emptyList()
            else
                joined.split(LINE_SEPARATOR)
            val lines: Array<TimedLine> = Array(encoded.size) { i ->
                val fields = encoded[i].split(FIELD_SEPARATOR)
                val start = if (fields.isNotEmpty()) parseLong(fields[0]) else 0L
                val end = if (fields.size > 1) parseLong(fields[1]) else 0L
                val text = if (fields.size > 2) fields[2] else ""
                // 第 4 段是翻译，空串表示「这一行没有翻译」。
                val translation = if (fields.size > 3 && !fields[3].isEmpty()) fields[3] else null
                TimedLine(text, start, end, translation)
            }
            tuning = decodeTuning(prefs.getString(KEY_TUNING, null))
            current = Snapshot(
                    prefs.getString(KEY_TITLE, ""),
                    prefs.getString(KEY_ARTIST, ""),
                    null,
                    prefs.getInt(KEY_ACCENT, EMPTY.accent),
                    prefs.getInt(KEY_BASE, EMPTY.baseColor),
                    prefs.getFloat(KEY_MOTION, EMPTY.motion),
                    prefs.getString(KEY_BACKGROUND, "cover"),
                    WallpaperBackgroundImage.key(context),
                    WallpaperLyricsFont.key(context),
                    prefs.getString(KEY_VISUALIZER, "sonnet"),
                    prefs.getFloat(KEY_BLUR, DEFAULT_BLUR),
                    prefs.getBoolean(KEY_PROGRESS, true),
                    prefs.getBoolean(KEY_TRANSLATION, true),
                    prefs.getLong(KEY_DURATION, 0L),
                    lines,
                    false,
                    SystemClock.elapsedRealtime(),
                    prefs.getLong(KEY_POSITION, 0L),
                    prefs.getLong(KEY_STAMP, System.currentTimeMillis()))
        }

        private fun persist(context: Context, snapshot: Snapshot) {
            // 注意：`words` **故意不落盘**。
            // 原生那层 GLES 歌词（LyricsRenderer）只按整行的起止画，逐字轴对它没用；
            // 把它写进 SharedPreferences 等于让每首歌的时间轴胖好几倍，纯属浪费。
            // 逐字轴只活在内存里，转发给叠层页面 —— App 每次 publish 都会带过来。
            // 代价是冷启动（App 还没 publish）时恢复出来的行没有逐字轴，
            // 那一小会儿叠层退回「整行」的老样子，App 一起来就补上了。
            val joined = StringBuilder()
            for (i in snapshot.lines.indices) {
                if (i > 0) {
                    joined.append(LINE_SEPARATOR)
                }
                val line = snapshot.lines[i]
                joined.append(line.startMs)
                        .append(FIELD_SEPARATOR)
                        .append(line.endMs)
                        .append(FIELD_SEPARATOR)
                        .append(line.text.replace(LINE_SEPARATOR, " ").replace(FIELD_SEPARATOR, " "))
                        .append(FIELD_SEPARATOR)
                        .append(line.translation?.replace(LINE_SEPARATOR, " ")
                                ?.replace(FIELD_SEPARATOR, " ") ?: "")
            }
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putString(KEY_TITLE, snapshot.title)
                    .putString(KEY_ARTIST, snapshot.artist)
                    .putString(KEY_TIMELINE, joined.toString())
                    .putLong(KEY_POSITION, snapshot.anchorPositionMs)
                    .putBoolean(KEY_PLAYING, snapshot.playing)
                    .putInt(KEY_ACCENT, snapshot.accent)
                    .putInt(KEY_BASE, snapshot.baseColor)
                    .putFloat(KEY_MOTION, snapshot.motion)
                    .putString(KEY_BACKGROUND, snapshot.backgroundMode)
                    .putString(KEY_VISUALIZER, snapshot.visualizerMode)
                    .putFloat(KEY_BLUR, snapshot.blur)
                    .putBoolean(KEY_PROGRESS, snapshot.showProgress)
                    .putBoolean(KEY_TRANSLATION, snapshot.showTranslation)
                    .putString(KEY_TUNING, encodeTuning(tuning))
                    .putLong(KEY_DURATION, snapshot.durationMs)
                    .putLong(KEY_STAMP, snapshot.stamp)
                    .apply()
        }

        /*
         * 这些 key **绝不落盘**。
         *
         * 它们不是设置，是**会话内的瞬时状态**。跟着 tuning 表一起写进 SharedPreferences
         * 的下场只有一个：应用被杀 / 崩了 / WebView 被回收，「把它关掉」那次调用就永远
         * 发不出来，盘上的 1 一直留到下一次冷启动 —— 状态从此卡死在开。
         *
         * wp.floatingPreview 正是这么栽的（详见 FloatingLyricsOverlay 里 PREVIEW_LEASE_MS
         * 上那段）：卡在 1 之后小窗恒挂，壁纸那层看见 isShowing() 恒真就不再画原生歌词，
         * 同时整层被强制 FLAG_NOT_TOUCHABLE —— 拖也拖不动。
         *
         * 挡在编码这一层，是为了两个写盘点（setAppearance 与 persist）一次都盖住，
         * 顺带把老版本已经写进盘的脏值在下一次落盘时清掉。
         */
        private val EPHEMERAL_TUNING_KEYS: Set<String> =
                java.util.Collections.singleton("wp.floatingPreview")

        private fun encodeTuning(values: Map<String, Float>?): String {
            if (values == null || values.isEmpty()) {
                return ""
            }
            val joined = StringBuilder()
            for (entry in values.entries) {
                if (EPHEMERAL_TUNING_KEYS.contains(entry.key)) {
                    continue
                }
                if (joined.length > 0) {
                    joined.append(TUNING_PAIR_SEPARATOR)
                }
                joined.append(entry.key)
                        .append(TUNING_VALUE_SEPARATOR)
                        .append(entry.value)
            }
            return joined.toString()
        }

        private fun decodeTuning(encoded: String?): Map<String, Float> {
            if (encoded == null || encoded.isEmpty()) {
                return emptyMap()
            }
            val values = java.util.HashMap<String, Float>()
            for (pair in encoded.split(TUNING_PAIR_SEPARATOR)) {
                val split = pair.indexOf(TUNING_VALUE_SEPARATOR)
                if (split <= 0) {
                    continue
                }
                try {
                    values[pair.substring(0, split)] = pair.substring(split + 1).toFloat()
                } catch (error: NumberFormatException) {
                    // 单个值坏了不影响其余配置项。
                }
            }
            @Suppress("UNCHECKED_CAST") return java.util.Collections.unmodifiableMap(values) as Map<String, Float>
        }

        private fun parseLong(value: String): Long {
            return try {
                value.toLong()
            } catch (error: NumberFormatException) {
                0L
            }
        }
    }
}
