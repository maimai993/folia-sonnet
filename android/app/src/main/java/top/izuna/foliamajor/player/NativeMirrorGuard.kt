package top.izuna.foliamajor.player

// 当前文件：原生队列镜像的准入与下标纯逻辑（不碰服务、播放器、JSON，JVM 可直接测）。

object NativeMirrorGuard {

    /**
     * 队列镜像落盘这一下该做什么（#H10）。
     *
     * 判据只有 [PlaybackAuthority] 给出的那一份「当前权威歌」，外加一个「刚推来的队列里有没有它」。
     * 把三种情形合成一个枚举，是为了让调用点没法只挑一半：以前准入用 `mirrorKey`、整份同步门槛
     * 却用 `nativeKey`，两条判据分家之后，派发在途那一档就掉进了「清磁盘快照」的 else 分支。
     */
    enum class QueueMirrorWrite {
        /** 权威歌就在新队列里：整份同步，游标钉在它那一格，并落盘。 */
        APPLY,

        /**
         * 派发在途、而权威歌（真正装着的那首）不在新队列里：只换 `entries`，游标原地不动。
         *
         * 这时候原生手上还是旧歌，新队列是按「用户刚点的那首」排的 —— 游标一旦跟着新下标走，
         * 磁盘上就写成一个既不等于原生现实、也不等于用户意图的中间态。
         */
        ENTRIES_ONLY,

        /** 原生没有媒体，新队列里也没有正在派发的那首：用户把队列清掉了（或退出登录撤了队列），盘上那份作废。 */
        CLEAR_SNAPSHOT,

        /**
         * 派发在途但权威歌还在新队列里：两个选项都还成立（用户可能只是排了个新列表），
         * 停下等那首歌装上或过期再说，**不动磁盘**。
         */
        DEFER,

        /** 什么都不做：收下这份队列不动游标，也**绝不清盘**。 */
        IGNORE,
    }

    /** 原生已有媒体身份时，songKey 对不上的旧 metadata 写入必须拒绝。 */
    fun rejectsMetadata(nativeSongKey: String?, incomingSongKey: String?): Boolean =
        !nativeSongKey.isNullOrEmpty() && incomingSongKey != nativeSongKey

    /**
     * 队列镜像同步之后前台游标该落在哪一格。
     * 原生有媒体时只按原生 currentKey 定位，旧游标不参与；没有原生媒体时才用新推来的下标。
     */
    fun mirrorIndex(
        entryKeys: List<String>,
        nativeCurrentKey: String?,
        nativeHasMedia: Boolean,
        requestedIndex: Int,
    ): Int {
        if (nativeHasMedia) {
            return indexOf(entryKeys, nativeCurrentKey)
        }
        return if (requestedIndex in entryKeys.indices) requestedIndex else -1
    }

    /** 原生有媒体时，前台推来的旧游标不许把原生当前曲目拽回去。 */
    fun acceptsQueueIndex(nativeHasMedia: Boolean): Boolean = !nativeHasMedia

    fun indexOf(entryKeys: List<String>, songKey: String?): Int {
        if (songKey.isNullOrEmpty()) return -1
        return entryKeys.indexOfFirst { it == songKey }
    }

    /**
     * 一条推来的队列镜像该怎么写。**这是队列镜像唯一的判据**，落盘决定只看它的返回值。
     *
     * @param authority 原生此刻的权威歌（见 [PlaybackAuthority.resolve]）。派发在途时
     *   `authorityKey` 是**真正装着**的那首，`pendingKey` 是还没落地的那首 —— 两者分开，
     *   不再用 `?:` 把在途身份混进原生身份里。
     * @param entryKeys 推来的队列里每一格的 songKey。
     * @param requestedIndex 前台给的游标；只在原生手里什么都没有（冷启动）时才认。
     */
    fun resolveQueueMirrorWrite(
        authority: PlaybackAuthority,
        entryKeys: List<String>,
        requestedIndex: Int,
    ): QueueMirrorWrite {
        val nativeKey = authority.nativeKey.orEmpty()
        val pendingKey = authority.pendingKey.orEmpty()
        if (authority.hasMedia) {
            // 原生手上真有歌：只要它还在新队列里就整份同步；不在就不动（旧队列可能连它都没有）。
            return if (indexOf(entryKeys, nativeKey) >= 0) QueueMirrorWrite.APPLY else QueueMirrorWrite.IGNORE
        }
        if (authority.pending) {
            // 派发在途：权威歌是「正在装的那首」，但播放器里此刻什么都没有。
            if (indexOf(entryKeys, pendingKey) < 0) return QueueMirrorWrite.ENTRIES_ONLY
            return if (requestedIndex in entryKeys.indices) QueueMirrorWrite.APPLY else QueueMirrorWrite.DEFER
        }
        // 原生空手、也没有在途派发：冷启动（认前台下标）与「用户清空了队列」（作废磁盘）靠新队列区分。
        if (entryKeys.isEmpty()) return QueueMirrorWrite.CLEAR_SNAPSHOT
        return if (requestedIndex in entryKeys.indices) QueueMirrorWrite.APPLY else QueueMirrorWrite.IGNORE
    }
}
