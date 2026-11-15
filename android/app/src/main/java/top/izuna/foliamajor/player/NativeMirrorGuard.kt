package top.izuna.foliamajor.player

// 当前文件：原生队列镜像的准入与下标纯逻辑（不碰服务、播放器、JSON，JVM 可直接测）。

object NativeMirrorGuard {

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
}
