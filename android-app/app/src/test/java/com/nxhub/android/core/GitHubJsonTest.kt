package com.nxhub.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GitHubJsonTest {

    private val reposJson = """
      [
        {"name":"wivrn-nx","full_name":"nerdrx/wivrn-nx","private":true,"archived":false,
         "description":"OpenXR streaming","owner":{"login":"nerdrx"}},
        {"name":"petri","full_name":"nerdrx/petri","private":false,"archived":true,
         "description":null,"owner":{"login":"nerdrx"}}
      ]
    """.trimIndent()

    private val releaseJson = """
      {
        "tag_name":"v1.2.0","name":"WiVRn NX 1.2.0","body":"- fixes standby\n- auto bitrate",
        "published_at":"2026-08-01T10:00:00Z","prerelease":false,"draft":false,
        "assets":[
          {"name":"wivrn-nx-release.apk","size":48123456,
           "url":"https://api.github.com/repos/nerdrx/wivrn-nx/releases/assets/1",
           "browser_download_url":"https://github.com/nerdrx/wivrn-nx/releases/download/v1.2.0/wivrn-nx-release.apk"},
          {"name":"wivrn-nx-release.apk.sha256","size":80,
           "url":"https://api.github.com/repos/nerdrx/wivrn-nx/releases/assets/2",
           "browser_download_url":"https://x/y.sha256"}
        ]
      }
    """.trimIndent()

    @Test
    fun `repos map to the model`() {
        val repos = GitHubJson.parseRepos(reposJson)
        assertEquals(2, repos.size)
        val w = repos[0]
        assertEquals("wivrn-nx", w.name)
        assertEquals("nerdrx", w.owner)
        assertEquals("nerdrx/wivrn-nx", w.fullName)
        assertEquals("OpenXR streaming", w.description)
        assertTrue(w.isPrivate)
        // a null description must not become the string "null"
        assertEquals("", repos[1].description)
        assertTrue(repos[1].archived)
    }

    @Test
    fun `release maps to the model, asset urls kept as the api url`() {
        val r = GitHubJson.parseRelease(releaseJson)!!
        assertEquals("v1.2.0", r.tag)
        assertEquals("1.2.0", r.version)
        assertEquals("WiVRn NX 1.2.0", r.title)
        assertTrue(r.notes.contains("auto bitrate"))
        assertEquals("2026-08-01T10:00:00Z", r.publishedAt)
        assertEquals(2, r.assets.size)
        val apk = r.assets[0]
        assertEquals("wivrn-nx-release.apk", apk.name)
        assertEquals(48123456L, apk.size)
        assertTrue(apk.apiUrl.startsWith("https://api.github.com/"))
        assertTrue(apk.browserUrl.contains("/releases/download/"))
    }

    @Test
    fun `latest from a list skips drafts and prefers a real release`() {
        val json = """
          [
            {"tag_name":"v2.0.0-draft","draft":true,"prerelease":false,"assets":[]},
            {"tag_name":"v2.0.0-rc1","draft":false,"prerelease":true,"assets":[]},
            {"tag_name":"v1.9.0","draft":false,"prerelease":false,"assets":[]}
          ]
        """.trimIndent()
        assertEquals("v1.9.0", GitHubJson.parseLatestFromList(json)!!.tag)
    }

    @Test
    fun `a repo with only pre-releases still resolves`() {
        val json = """[{"tag_name":"nx-0.3.0-rc1","draft":false,"prerelease":true,"assets":[]}]"""
        val r = GitHubJson.parseLatestFromList(json)!!
        assertEquals("0.3.0-rc1", r.version)
        assertTrue(r.prerelease)
    }

    @Test
    fun `garbage in, null out`() {
        assertNull(GitHubJson.parseRelease("not json"))
        assertNull(GitHubJson.parseRelease(null))
        assertNull(GitHubJson.parseLatestFromList("[]"))
        assertTrue(GitHubJson.parseRepos("{\"message\":\"Bad credentials\"}").isEmpty())
    }
}
