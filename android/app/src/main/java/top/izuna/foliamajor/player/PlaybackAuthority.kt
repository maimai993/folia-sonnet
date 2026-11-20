package top.izuna.foliamajor.player

// 当前文件：「谁是当前权威歌」的判据，队列镜像、游标更新、metadata 刷新三条路径共用（#H10、#H8）。

/**
 * 原生此刻的播放权威歌。三种身份分开，不用 `?:` 拼：
 *
 * - [nativeKey]：播放器**真正装着**的那首（`mediaSnapshot()?.songKey`）。
 * - [pendingKey]：正在派发、还没装上的那首。它既不是原生身份，也不是用户已经听到的歌。
 * - `hasMedia` / `pending`：上面两个字段各自有没有值。
 *
 * 以前队列镜像用 `pendingKey ?: nativeKey` 当「原生身份」，于是「派发在途」被当成了
 * 「原生手上是那首新歌」—— 游标被挪到还没装上的那一格、`nativeKey.isNotEmpty()` 又为假，
 * 两条判据分家，最坏一档直接走进清磁盘快照的 else 分支（用户点一首还没解析出地址的歌，
 * 盘上「上次听到哪儿」就被抹掉）。
 */
class PlaybackAuthority(
    val nativeKey: String?,
    val pendingKey: String?,
) {
    /** 播放器真的装着歌。 */
    val hasMedia: Boolean
        get() = !nativeKey.isNullOrEmpty()

    /** 正在装某一首、还没落地。 */
    val pending: Boolean
        get() = !pendingKey.isNullOrEmpty()

    /**
     * 队列游标该站在哪一首上：**只有真正装着的那首才算数**，在途那首不算。
     *
     * 在途时游标不动的理由与「没有原生媒体」不同：那时盘上的游标是上一次的真实状态，
     * 比一个还没落地的目标更接近用户听到的。
     */
    val cursorKey: String?
        get() = nativeKey?.takeIf { it.isNotEmpty() }

    companion object {
        /** 从两处 volatile 读一次，合成一份快照。 */
        fun resolve(nativeKey: String?, pendingKey: String?): PlaybackAuthority =
            PlaybackAuthority(
                nativeKey = nativeKey?.takeIf { it.isNotEmpty() },
                pendingKey = pendingKey?.takeIf { it.isNotEmpty() },
            )

        /** 原生空手、也没有在途派发（冷启动 / 用户清空队列）。 */
        val NONE = PlaybackAuthority(null, null)
    }
}
