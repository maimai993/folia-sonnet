package top.izuna.foliamajor.wallpaper

/**
 * 群唱（Cappella）自定义头像 / 表情图在原生这一侧的暂存。
 *
 * 为什么需要它：叠层是**另一个 WebView**（https://localhost），里头的 IndexedDB 与主
 * 应用不是同一份 —— 用户上传的头像 / 表情包在 App 里存的是 IndexedDB 里的 blob，
 * 叠层那边一张都读不到。于是 `avatarSource === 'custom'` 但列表是空的，Cappella
 * 按「没有自定义头像」回退到封面 —— 用户看到的正是「群唱自定义头像显示的是封面」。
 *
 * 所以主 App 把图解析成 data URL（与 OBS 浏览器源同一条解析路径）之后推给这里，
 * 由叠层在推状态时单独发一条消息带下去。
 *
 * 只存不落盘：这些图本来就是从 IndexedDB 现解出来的，App 重新 publish 一次就会再推。
 * 存盘还会让「用户删掉图之后重启」照样显示旧图。
 */
object WallpaperCappellaImages {

    /**
     * 一次推送要用的整份数据。
     *
     * 三样东西必须**一起换**：分几个 volatile 字段各写各的，读侧可能读到「新的头像 +
     * 旧的表情」这种半成品，而版本号已经过去了就再也不会重推 —— 那两张图会一直错着。
     * 所以打包成一个不可变对象，一次引用赋值发布出去。
     */
    class Snapshot(
        /** JSON 数组字符串（[{id,name,url}]）。url 是 data URL，体积可能上百 KB。 */
        @JvmField val avatars: String,
        @JvmField val emojis: String,
        /**
         * 每次 set 都会 +1。
         *
         * 叠层那边靠它判「这一份图推过没有」—— 图本身是几百 KB 的 base64，不能塞进整包
         * 的签名里，也不该每 250ms 重推一次。
         */
        @JvmField val revision: Int,
    )

    @Volatile
    private var current = Snapshot("[]", "[]", 0)

    fun set(avatars: String?, emojis: String?) {
        val nextAvatars = avatars ?: "[]"
        val nextEmojis = emojis ?: "[]"
        val previous = current
        if (nextAvatars == previous.avatars && nextEmojis == previous.emojis) {
            return
        }
        current = Snapshot(nextAvatars, nextEmojis, previous.revision + 1)
    }

    fun read(): Snapshot = current
}
