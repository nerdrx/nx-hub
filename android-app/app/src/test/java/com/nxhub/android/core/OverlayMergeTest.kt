package com.nxhub.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class OverlayMergeTest {

    private val overlayJson = """
      { "version": 1,
        "hidden": ["petri", "CDRP-for-Claude"],
        "apps": {
          "wivrn-nx": {
            "name": "WiVRn NX",
            "tagline": "OpenXR streaming to the Pico — NX transport stack",
            "order": 1,
            "artifacts": [
              { "assetPattern": "wivrn-nx-release*.apk", "label": "Pico headset APK",
                "kind": "apk-adb", "platform": "android", "packageId": "org.meumeu.wivrn.nx" },
              { "assetPattern": "*.tar.gz", "label": "Linux server", "kind": "tarball-prefix",
                "platform": "linux" }
            ]
          },
          "OscGoesBrrr-NX-Patches": {
            "name": "OGB NX-Patches",
            "artifacts": [ { "assetPattern": "*debug*.apk", "skip": true } ]
          },
          "nx-hub": {
            "name": "NX Hub", "tagline": "This launcher", "order": 90,
            "artifacts": [
              { "assetPattern": "*-android.apk", "label": "Android/Pico companion",
                "platform": "android", "packageId": "com.nxhub.android" },
              { "assetPattern": "*linux.AppImage", "label": "Desktop hub (Linux)", "platform": "linux" }
            ]
          }
        } }
    """.trimIndent()

    private val overlay = Overlay.parse(overlayJson)

    private fun repo(name: String, owner: String = "nerdrx", desc: String = "", priv: Boolean = false) =
        Repo(name, owner, desc, priv)

    private fun release(tag: String, vararg assets: String) = Release(
        tag = tag, title = tag, notes = "notes for $tag", publishedAt = "2026-08-01T00:00:00Z",
        prerelease = false, draft = false,
        assets = assets.map { Asset(it, "api/$it", "dl/$it", 1234) }
    )

    @Test
    fun `overlay parses names, order, hidden and artifacts`() {
        assertTrue(overlay.isHidden("petri"))
        assertTrue(overlay.isHidden("PETRI"))
        assertTrue(overlay.isHidden("cdrp-for-claude"))
        assertEquals("WiVRn NX", overlay.app("wivrn-nx")!!.name)
        assertEquals(1, overlay.app("WIVRN-NX")!!.order)
        // repo keys are matched case-insensitively
        assertEquals("OGB NX-Patches", overlay.app("oscgoesbrrr-nx-patches")!!.name)
        assertNull(overlay.app("unknown-repo"))
    }

    @Test
    fun `overlay overrides name, tagline and order, repo fills the gaps`() {
        val e = Discovery.entryFor(
            repo("wivrn-nx", priv = true, desc = "raw github description"),
            release("v1.2.0", "wivrn-nx-release.apk", "wivrn-nx-server.tar.gz"),
            overlay
        )!!
        assertEquals("wivrn-nx", e.id)
        assertEquals("WiVRn NX", e.name)
        assertEquals("OpenXR streaming to the Pico — NX transport stack", e.tagline)
        assertEquals(1, e.order)
        assertTrue(e.isPrivate)
        assertEquals("1.2.0", e.version)
        assertEquals("v1.2.0", e.tag)
        // android artifact rule selected the APK and supplied label + packageId
        assertEquals("wivrn-nx-release.apk", e.asset.name)
        assertEquals("Pico headset APK", e.label)
        assertEquals("org.meumeu.wivrn.nx", e.packageId)
    }

    @Test
    fun `no overlay entry falls back to repo name and description, order 100`() {
        val e = Discovery.entryFor(
            repo("some-tool", desc = "a thing"), release("1.0.0", "some-tool.apk"), overlay
        )!!
        assertEquals("some-tool", e.name)
        assertEquals("a thing", e.tagline)
        assertEquals(100, e.order)
        assertNull(e.packageId)
        assertEquals("Android APK", e.label)
    }

    @Test
    fun `hidden repos and releases without apks drop out`() {
        assertNull(Discovery.entryFor(repo("petri"), release("v1.0.0", "petri.apk"), overlay))
        assertNull(Discovery.entryFor(repo("nxtakt"), release("v1.0.0", "nxtakt-linux.zip"), overlay))
        assertNull(Discovery.entryFor(repo("nxtakt"), null, overlay))
    }

    @Test
    fun `skip true hides an apk even though it is an apk`() {
        assertNull(
            Discovery.entryFor(
                repo("OscGoesBrrr-NX-Patches"), release("v3.1", "ogb-debug.apk"), overlay
            )
        )
        assertNotNull(
            Discovery.entryFor(
                repo("OscGoesBrrr-NX-Patches"), release("v3.1", "ogb-debug.apk", "ogb.apk"), overlay
            )
        )
    }

    @Test
    fun `the hub itself is discoverable through its own android asset`() {
        val e = Discovery.entryFor(
            repo("nx-hub"),
            release("v0.1.0", "NX-Hub-0.1.0-android.apk", "NX-Hub-0.1.0-linux.AppImage"),
            overlay
        )!!
        assertEquals("com.nxhub.android", e.packageId)
        assertEquals("NX-Hub-0.1.0-android.apk", e.asset.name)
        assertEquals("Android/Pico companion", e.label)
        // self-update: installed 0.1.0, release 0.2.0 → update offered
        val updated = e.copy(installed = true, installedVersion = "0.1.0", version = "0.2.0")
        assertTrue(updated.updateAvailable)
    }

    @Test
    fun `build sorts by overlay order then name`() {
        val repos = listOf(repo("nx-hub"), repo("wivrn-nx"), repo("zzz-tool"), repo("aaa-tool"))
        val releases = mapOf(
            "nerdrx/nx-hub" to release("v0.1.0", "NX-Hub-0.1.0-android.apk"),
            "nerdrx/wivrn-nx" to release("v1.2.0", "wivrn-nx-release.apk"),
            "nerdrx/zzz-tool" to release("v1.0", "zzz.apk"),
            "nerdrx/aaa-tool" to release("v1.0", "aaa.apk")
        )
        // order 1 → 90 → 100 (default, alphabetical inside the same order)
        assertEquals(
            listOf("WiVRn NX", "NX Hub", "aaa-tool", "zzz-tool"),
            Discovery.build(repos, releases, overlay).map { it.name }
        )
    }

    @Test
    fun `owner slash repo references are normalised`() {
        assertEquals("nerdrx" to "wivrn-nx", Discovery.parseRepoRef("nerdrx/wivrn-nx"))
        assertEquals("nerdrx" to "wivrn-nx", Discovery.parseRepoRef("  nerdrx/wivrn-nx  "))
        assertEquals("nerdrx" to "wivrn-nx", Discovery.parseRepoRef("https://github.com/nerdrx/wivrn-nx"))
        assertEquals("nerdrx" to "wivrn-nx", Discovery.parseRepoRef("github.com/nerdrx/wivrn-nx.git"))
        assertNull(Discovery.parseRepoRef("wivrn-nx"))
        assertNull(Discovery.parseRepoRef(""))
    }

    @Test
    fun `real releases from the live repos map the way the Pico expects`() {
        val bundled = File("src/main/assets/overrides.json")
        if (!bundled.exists()) return
        val real = Overlay.parse(bundled.readText())

        // nerdrx/wivrn-nx, tag "nx-1.3"
        val wivrn = Discovery.entryFor(
            repo("wivrn-nx"),
            release("nx-1.3", "wivrn-nx-release.apk", "wivrn-nx-server-1.3-linux-x86_64.tar.gz"),
            real
        )!!
        assertEquals("1.3", wivrn.version)
        assertEquals("wivrn-nx-release.apk", wivrn.asset.name)
        assertEquals("org.meumeu.wivrn.nx", wivrn.packageId)
        assertEquals("Pico headset APK", wivrn.label)

        // nerdrx/pulsenx, tag "v1.0.0" — every asset has a .sha256 sibling
        val pulse = Discovery.entryFor(
            repo("pulsenx", priv = true),
            release(
                "v1.0.0",
                "PulseNX-1.0.0-linux.AppImage", "PulseNX-1.0.0-linux.AppImage.sha256",
                "PulseNX-1.0.0-windows-portable.exe", "pulsenx-bridge-1.0.0.apk",
                "pulsenx-bridge-1.0.0.apk.sha256"
            ),
            real
        )!!
        assertEquals("pulsenx-bridge-1.0.0.apk", pulse.asset.name)
        assertEquals("com.pulsenx.bridge", pulse.packageId)

        // nerdrx/quadforge ships a Blender addon zip only → not an Android app
        assertNull(Discovery.entryFor(repo("quadforge"), release("v0.1.0", "quadforge-0.1.0.zip"), real))
    }

    @Test
    fun `the bundled registry snapshot is valid and matches the spec`() {
        val bundled = File("src/main/assets/overrides.json")
        if (!bundled.exists()) return   // module dir differs → nothing to check
        val real = Overlay.parse(bundled.readText())
        assertTrue(real.appIds().contains("nx-hub"))
        assertTrue(real.isHidden("petri"))
        val hub = real.app("nx-hub")!!
        val androidRule = hub.artifacts.first { it.assetPattern == "*-android.apk" }
        assertEquals("com.nxhub.android", androidRule.packageId)
        assertEquals("org.meumeu.wivrn.nx", real.app("wivrn-nx")!!.artifacts
            .first { it.platform == "android" }.packageId)
    }
}
