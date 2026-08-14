package com.nxhub.android.core

import org.json.JSONArray
import org.json.JSONObject

/** GitHub REST payloads → model. Pure parsing, no I/O, so it is unit-testable. */
object GitHubJson {

    fun parseRepos(json: String?): List<Repo> {
        if (json.isNullOrBlank()) return emptyList()
        return try {
            val arr = JSONArray(json)
            (0 until arr.length()).mapNotNull { i -> arr.optJSONObject(i)?.let(::repo) }
        } catch (e: Exception) {
            emptyList()
        }
    }

    fun repo(o: JSONObject): Repo? {
        val name = o.optStringOrNull("name") ?: return null
        val owner = o.optJSONObject("owner")?.optStringOrNull("login")
            ?: o.optStringOrNull("full_name")?.substringBefore('/')
            ?: return null
        return Repo(
            name = name,
            owner = owner,
            description = o.optStringOrNull("description") ?: "",
            isPrivate = o.optBoolean("private", false),
            archived = o.optBoolean("archived", false)
        )
    }

    /** Parse a single release object (GET /repos/{o}/{r}/releases/latest). */
    fun parseRelease(json: String?): Release? {
        if (json.isNullOrBlank()) return null
        return try {
            release(JSONObject(json))
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Parse a releases array and return the newest usable one: skip drafts, and
     * skip pre-releases unless nothing else is available.
     */
    fun parseLatestFromList(json: String?): Release? {
        if (json.isNullOrBlank()) return null
        return try {
            val arr = JSONArray(json)
            val all = (0 until arr.length())
                .mapNotNull { i -> arr.optJSONObject(i)?.let(::release) }
                .filter { !it.draft }
            all.firstOrNull { !it.prerelease } ?: all.firstOrNull()
        } catch (e: Exception) {
            null
        }
    }

    fun release(o: JSONObject): Release? {
        val tag = o.optStringOrNull("tag_name") ?: o.optStringOrNull("name") ?: return null
        val assets = mutableListOf<Asset>()
        o.optJSONArray("assets")?.let { arr ->
            for (i in 0 until arr.length()) {
                val a = arr.optJSONObject(i) ?: continue
                val name = a.optStringOrNull("name") ?: continue
                assets.add(
                    Asset(
                        name = name,
                        apiUrl = a.optStringOrNull("url") ?: "",
                        browserUrl = a.optStringOrNull("browser_download_url") ?: "",
                        size = a.optLong("size", 0L)
                    )
                )
            }
        }
        return Release(
            tag = tag,
            title = o.optStringOrNull("name") ?: tag,
            notes = o.optStringOrNull("body") ?: "",
            publishedAt = o.optStringOrNull("published_at") ?: o.optStringOrNull("created_at") ?: "",
            prerelease = o.optBoolean("prerelease", false),
            draft = o.optBoolean("draft", false),
            assets = assets
        )
    }
}
