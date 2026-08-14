package com.nxhub.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AssetClassifierTest {

    private fun asset(name: String, size: Long = 1000) = Asset(name, "api/$name", "dl/$name", size)

    @Test
    fun `only apk files are installable`() {
        assertTrue(AssetClassifier.isApk("wivrn-nx-release.apk"))
        assertTrue(AssetClassifier.isApk("NX-Hub-0.1.0-android.APK"))
        assertFalse(AssetClassifier.isApk("PulseNX-1.0.0.AppImage"))
        assertFalse(AssetClassifier.isApk("nxtakt-windows.zip"))
        assertFalse(AssetClassifier.isApk("server-linux-x86_64.tar.gz"))
        assertFalse(AssetClassifier.isApk("latest-linux.yml"))
    }

    @Test
    fun `checksum and signature siblings are ignored`() {
        for (sidecar in listOf(
            "app.apk.sha256", "app.apk.sig", "app.apk.asc", "app.apk.idsig",
            "app.apk.md5", "app.apk.blockmap"
        )) {
            assertFalse(sidecar, AssetClassifier.isApk(sidecar))
            assertTrue(sidecar, AssetClassifier.isSidecar(sidecar))
        }
        val assets = listOf(
            asset("nx.apk"), asset("nx.apk.sha256"), asset("nx.apk.idsig"), asset("notes.txt")
        )
        assertEquals(listOf("nx.apk"), AssetClassifier.apks(assets).map { it.name })
    }

    @Test
    fun `no apk means no row`() {
        val assets = listOf(asset("app.AppImage"), asset("app.exe"), asset("app.zip"))
        assertNull(AssetClassifier.pick(assets, emptyList()))
    }

    @Test
    fun `overlay rules win over heuristics and carry the packageId`() {
        val assets = listOf(asset("wivrn-nx-debug.apk", 90), asset("wivrn-nx-release-1.2.apk", 50))
        val rules = listOf(
            OverlayArtifact("wivrn-nx-release*.apk", label = "Pico headset APK",
                platform = "android", packageId = "org.meumeu.wivrn.nx")
        )
        val picked = AssetClassifier.pick(assets, rules)!!
        assertEquals("wivrn-nx-release-1.2.apk", picked.asset.name)
        assertEquals("Pico headset APK", picked.label)
        assertEquals("org.meumeu.wivrn.nx", picked.packageId)
    }

    @Test
    fun `skip rules remove an asset entirely`() {
        val assets = listOf(asset("app-debug.apk", 900))
        val rules = listOf(OverlayArtifact("*debug*.apk", skip = true))
        assertNull(AssetClassifier.pick(assets, rules))
    }

    @Test
    fun `without overlay rules release beats debug and the biggest apk wins`() {
        val a = listOf(asset("app-debug.apk", 900), asset("app-release.apk", 100))
        assertEquals("app-release.apk", AssetClassifier.pick(a, emptyList())!!.asset.name)

        val b = listOf(asset("app-armeabi.apk", 100), asset("app-universal.apk", 900))
        assertEquals("app-universal.apk", AssetClassifier.pick(b, emptyList())!!.asset.name)
        assertNull(AssetClassifier.pick(b, emptyList())!!.packageId)
    }

    @Test
    fun `non-android overlay rules never select an apk`() {
        val assets = listOf(asset("thing.apk"))
        val rules = listOf(OverlayArtifact("*.apk", label = "Linux", platform = "linux"))
        // the rule is skipped, heuristic still finds the apk but without a label
        val picked = AssetClassifier.pick(assets, rules)!!
        assertEquals("thing.apk", picked.asset.name)
        assertNull(picked.label)
    }

    @Test
    fun `glob matching handles the registry patterns`() {
        assertTrue(Glob.matches("*-android.apk", "NX-Hub-0.1.0-android.apk"))
        assertFalse(Glob.matches("*-android.apk", "NX-Hub-0.1.0-linux.AppImage"))
        assertTrue(Glob.matches("*.apk", "anything.apk"))
        assertTrue(Glob.matches("wivrn-nx-server-*-linux-x86_64.tar.gz", "wivrn-nx-server-1.2-linux-x86_64.tar.gz"))
        assertFalse(Glob.matches("*windows-setup*.exe", "app-windows-portable.exe"))
        // '.' must not act as a regex wildcard
        assertFalse(Glob.matches("app.apk", "appxapk"))
    }
}
