package top.izuna.foliamajor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException

// 纯 JVM 合成测试，不启动 Android、不创建 socket。
class RemoteAudioRegistryTest {
    @Test
    @Throws(Exception::class)
    fun acceptsOnlyExactHttpOrigin() {
        RemoteAudioRegistry.validateOrigin("https://nas.synthetic.test:443/image", "https://NAS.synthetic.test")
        RemoteAudioRegistry.validateOrigin("http://nas.synthetic.test:5666/image", "http://nas.synthetic.test:5666")
        val rejected = arrayOf(
            "https://other.synthetic.test/image",
            "http://nas.synthetic.test/image",
            "https://nas.synthetic.test:8443/image",
            "https://synthetic@nas.synthetic.test/image",
            "https://nas.synthetic.test.other.test/image",
            "file:///image"
        )
        for (target in rejected) {
            try {
                RemoteAudioRegistry.validateOrigin(target, "https://nas.synthetic.test")
                fail("Origin mismatch accepted")
            } catch (expected: IOException) {
            }
        }
    }

    @Test
    @Throws(Exception::class)
    fun rejectsAnOriginContainingPathOrCredentials() {
        for (origin in arrayOf(
            "https://nas.synthetic.test/path",
            "https://synthetic@nas.synthetic.test",
            "https://nas.synthetic.test?synthetic",
            "https://nas.synthetic.test#synthetic"
        )) {
            try {
                RemoteAudioRegistry.validateOrigin("https://nas.synthetic.test/image", origin)
                fail("Non-origin accepted")
            } catch (expected: IOException) {
            }
        }
    }

    @Test
    fun usesDistinctOpaqueTokensAndImmutableHeaderSnapshots() {
        val registry = RemoteAudioRegistry()
        val headers = HashMap<String, String>()
        headers["Cookie"] = "SYNTHETIC_A"
        val first = registry.register("https://nas.synthetic.test/image", headers)
        headers["Cookie"] = "SYNTHETIC_B"
        val second = registry.register("https://nas.synthetic.test/image", headers)
        assertNotEquals(first, second)
        assertEquals("SYNTHETIC_A", registry.get(first)!!.headers["Cookie"])
        assertEquals("SYNTHETIC_B", registry.get(second)!!.headers["Cookie"])
        assertFalse(registry.get(first)!!.allowsRedirects())
        registry.remove(first)
        assertNull(registry.get(first))
        assertNotNull(registry.get(second))
    }

    @Test
    fun boundsCapacityAndKeepsPlainCdnRedirects() {
        val registry = RemoteAudioRegistry()
        val oldest = registry.register("https://cdn.synthetic.test/audio", null)
        for (index in 0 until 128) registry.register("https://cdn.synthetic.test/audio", null)
        assertNull(registry.get(oldest))
        val latest = registry.register("https://cdn.synthetic.test/audio", null)
        assertTrue(registry.get(latest)!!.allowsRedirects())
    }

    @Test
    fun repeatedAudioRegistrationDoesNotExhaustCapacityOrRebindCredentials() {
        val registry = RemoteAudioRegistry()
        val firstHeaders = HashMap<String, String>()
        firstHeaders["Cookie"] = "SYNTHETIC_A"
        val playing = registry.registerReusable("https://nas.synthetic.test/audio", firstHeaders)
        for (i in 0 until 1000) {
            assertEquals(playing, registry.registerReusable("https://nas.synthetic.test/audio", firstHeaders))
        }
        val nextHeaders = HashMap<String, String>()
        nextHeaders["Cookie"] = "SYNTHETIC_B"
        val next = registry.registerReusable("https://nas.synthetic.test/audio", nextHeaders)
        assertNotEquals(playing, next)
        assertEquals("SYNTHETIC_A", registry.get(playing)!!.headers["Cookie"])
        assertEquals("SYNTHETIC_B", registry.get(next)!!.headers["Cookie"])
    }

    @Test
    fun reusingAudioRefreshesItsEvictionOrder() {
        val registry = RemoteAudioRegistry()
        val playing = registry.registerReusable("https://cdn.synthetic.test/playing", null)
        val oldestUnused = registry.registerReusable("https://cdn.synthetic.test/oldest-unused", null)
        for (i in 0 until 126) registry.registerReusable("https://cdn.synthetic.test/unique-" + i, null)
        assertEquals(playing, registry.registerReusable("https://cdn.synthetic.test/playing", null))
        registry.registerReusable("https://cdn.synthetic.test/new", null)
        assertNotNull(registry.get(playing))
        assertNull(registry.get(oldestUnused))
    }

    @Test
    @Throws(Exception::class)
    fun revokingAnOldRegistrationNeverRevokesItsReplacement() {
        val registry = RemoteAudioRegistry()
        val old = registry.register("https://nas.synthetic.test/image", null)
        val revoke = Thread { for (i in 0 until 1000) registry.remove(old) }
        revoke.start()
        val replacement = registry.register("https://nas.synthetic.test/image", null)
        revoke.join()
        assertNull(registry.get(old))
        assertNotNull(registry.get(replacement))
    }
}
