package top.izuna.foliamajor.player

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// 用播放器实际 MediaItem 持有的一次性凭据，区分同曲重装、不同曲及手动拖动。
class SessionResumeTicketTest {
    @Test fun onlyMatchingIncarnationCanSpendOnce() {
        val ticket = SessionResumeTicket("w:2")
        assertFalse(ticket.take("A", "B", "w:2"))
        assertFalse(ticket.take("A", "A", "w:1"))
        assertTrue(ticket.take("A", "A", "w:2"))
        assertFalse(ticket.take("A", "A", "w:2"))
    }

    @Test fun userSeekOrRepeatInvalidatesEvenTheMatchingItem() {
        val ticket = SessionResumeTicket("w:1")
        ticket.cancel()
        assertFalse(ticket.take("A", "A", "w:1"))
    }
}
