package top.izuna.foliamajor.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

// 会话快照的位置要连同写入时间一起交给前台，前台才能按谁最后写的决定取哪一份。
class SessionSnapshotStoreTest {
    private val queue = """{"v":1,"entries":[{"songKey":"A"}],"index":0,"songKey":"A","at":10}"""

    @Test fun sameSongPositionCarriesItsWriteTime() {
        val snapshot = SessionSnapshotStore.parse(queue, """{"v":1,"songKey":"A","positionMs":20000,"at":5000}""")
        assertNotNull(snapshot)
        assertEquals(20000L, snapshot!!.positionMs)
        assertEquals(5000L, snapshot.positionSavedAtMs)
    }

    @Test fun otherSongPositionIsIgnoredTogetherWithItsTime() {
        val snapshot = SessionSnapshotStore.parse(queue, """{"v":1,"songKey":"B","positionMs":20000,"at":5000}""")
        assertEquals(0L, snapshot!!.positionMs)
        assertEquals(0L, snapshot.positionSavedAtMs)
    }

    @Test fun missingPositionHasNoWriteTime() {
        assertEquals(0L, SessionSnapshotStore.parse(queue, null)!!.positionSavedAtMs)
    }
}
