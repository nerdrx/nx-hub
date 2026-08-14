package com.nxhub.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VersionUtilTest {

    @Test
    fun `strips the usual tag prefixes`() {
        assertEquals("1.2.3", VersionUtil.normalize("v1.2.3"))
        assertEquals("1.2.3", VersionUtil.normalize("V1.2.3"))
        assertEquals("1.3", VersionUtil.normalize("nx-1.3"))
        assertEquals("1.3", VersionUtil.normalize("nx-v1.3"))
        assertEquals("0.9.1", VersionUtil.normalize("wivrn-nx-v0.9.1"))
        assertEquals("2.0.0", VersionUtil.normalize("release-2.0.0"))
        assertEquals("1.0.0", VersionUtil.normalize("1.0.0"))
        assertEquals("1.0.0", VersionUtil.normalize("  1.0.0  "))
    }

    @Test
    fun `keeps things it cannot parse`() {
        assertEquals("", VersionUtil.normalize(null))
        assertEquals("", VersionUtil.normalize("   "))
        assertEquals("nightly", VersionUtil.normalize("nightly"))
    }

    @Test
    fun `keeps pre-release suffixes attached`() {
        assertEquals("1.2.0-beta1", VersionUtil.normalize("v1.2.0-beta1"))
        assertEquals("2.0.0-rc.2", VersionUtil.normalize("nx-2.0.0-rc.2"))
    }

    @Test
    fun `compares numerically, not lexically`() {
        assertTrue(VersionUtil.compare("1.10.0", "1.9.0") > 0)
        assertTrue(VersionUtil.compare("2.0.0", "10.0.0") < 0)
        assertEquals(0, VersionUtil.compare("1.2.0", "v1.2.0"))
        assertEquals(0, VersionUtil.compare("1.2", "1.2.0"))
        assertTrue(VersionUtil.compare("nx-1.3", "v1.2.9") > 0)
    }

    @Test
    fun `a release outranks its pre-releases`() {
        assertTrue(VersionUtil.compare("1.2.0", "1.2.0-beta1") > 0)
        assertTrue(VersionUtil.compare("1.2.0-beta1", "1.2.0-beta2") < 0)
        assertTrue(VersionUtil.compare("1.2.0-beta", "1.2.0-beta.2") < 0)
        assertTrue(VersionUtil.compare("1.3.0-rc1", "1.2.0") > 0)
    }

    @Test
    fun `isNewer drives the Update button`() {
        assertTrue(VersionUtil.isNewer("0.2.0", "0.1.0"))
        assertFalse(VersionUtil.isNewer("0.1.0", "0.1.0"))
        assertFalse(VersionUtil.isNewer("0.1.0", "0.2.0"))
        // not installed → never an update
        assertFalse(VersionUtil.isNewer("1.0.0", null))
        assertFalse(VersionUtil.isNewer("1.0.0", ""))
    }

    @Test
    fun `updateAvailable only fires for installed apps`() {
        val asset = Asset("app.apk", "u", "b", 10)
        val base = AppEntry(
            id = "x", repo = "o/x", owner = "o", name = "X", tagline = "", order = 1,
            isPrivate = false, version = "1.1.0", tag = "v1.1.0", notes = "", publishedAt = "",
            prerelease = false, asset = asset, label = "APK", packageId = "com.x"
        )
        assertFalse(base.updateAvailable)
        assertTrue(base.copy(installed = true, installedVersion = "1.0.0").updateAvailable)
        assertFalse(base.copy(installed = true, installedVersion = "1.1.0").updateAvailable)
        assertFalse(base.copy(installed = true, installedVersion = "1.2.0").updateAvailable)
    }
}
