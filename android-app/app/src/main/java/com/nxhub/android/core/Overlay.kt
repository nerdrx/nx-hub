package com.nxhub.android.core

import org.json.JSONObject

/** One `artifacts[]` entry of the overlay (registry/overrides.json). */
data class OverlayArtifact(
    val assetPattern: String,
    val label: String? = null,
    val kind: String? = null,
    val platform: String? = null,
    val packageId: String? = null,
    val skip: Boolean = false
)

/** Per-repo overlay entry. */
data class OverlayApp(
    val name: String? = null,
    val tagline: String? = null,
    val order: Int? = null,
    val artifacts: List<OverlayArtifact> = emptyList()
)

/**
 * The curated overlay. Repo names are matched case-insensitively because the
 * registry uses the GitHub spelling ("OscGoesBrrr-NX-Patches") while ids are
 * lowercased everywhere else.
 */
class Overlay(
    val hidden: Set<String>,
    private val apps: Map<String, OverlayApp>
) {
    fun app(repoName: String): OverlayApp? = apps[repoName.lowercase()]

    /**
     * Scoped like the desktop hub: an `owner/repo` entry hides exactly that
     * repo; a bare name hides only the PRIMARY owner's repo of that name —
     * another source's identically-named repo must never inherit the hiding.
     */
    fun isHidden(repoName: String, owner: String? = null, primaryOwner: String? = null): Boolean {
        val name = repoName.lowercase()
        val full = if (owner != null) "${owner.lowercase()}/$name" else null
        return hidden.any { h ->
            if (h.contains("/")) h == full
            else h == name && (owner == null || primaryOwner == null || owner.equals(primaryOwner, ignoreCase = true))
        }
    }

    fun appIds(): Set<String> = apps.keys

    companion object {
        val EMPTY = Overlay(emptySet(), emptyMap())

        fun parse(json: String?): Overlay {
            if (json.isNullOrBlank()) return EMPTY
            return try {
                val root = JSONObject(json)
                val hidden = mutableSetOf<String>()
                root.optJSONArray("hidden")?.let { arr ->
                    for (i in 0 until arr.length()) hidden.add(arr.optString(i).lowercase())
                }
                val apps = mutableMapOf<String, OverlayApp>()
                root.optJSONObject("apps")?.let { obj ->
                    for (key in obj.keys()) {
                        val a = obj.optJSONObject(key) ?: continue
                        val artifacts = mutableListOf<OverlayArtifact>()
                        a.optJSONArray("artifacts")?.let { arr ->
                            for (i in 0 until arr.length()) {
                                val art = arr.optJSONObject(i) ?: continue
                                val pattern = art.optString("assetPattern", "")
                                if (pattern.isEmpty()) continue
                                artifacts.add(
                                    OverlayArtifact(
                                        assetPattern = pattern,
                                        label = art.optStringOrNull("label"),
                                        kind = art.optStringOrNull("kind"),
                                        platform = art.optStringOrNull("platform"),
                                        packageId = art.optStringOrNull("packageId"),
                                        skip = art.optBoolean("skip", false)
                                    )
                                )
                            }
                        }
                        apps[key.lowercase()] = OverlayApp(
                            name = a.optStringOrNull("name"),
                            tagline = a.optStringOrNull("tagline"),
                            order = if (a.has("order")) a.optInt("order", 100) else null,
                            artifacts = artifacts
                        )
                    }
                }
                Overlay(hidden, apps)
            } catch (e: Exception) {
                EMPTY
            }
        }
    }
}

internal fun JSONObject.optStringOrNull(key: String): String? {
    if (!has(key) || isNull(key)) return null
    val v = optString(key, "")
    return if (v.isEmpty()) null else v
}
