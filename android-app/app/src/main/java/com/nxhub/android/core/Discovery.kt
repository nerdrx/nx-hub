package com.nxhub.android.core

/**
 * The pure half of discovery: (repo + its latest release + overlay) → AppEntry.
 * Network fetching lives in [com.nxhub.android.GitHubClient]; everything that
 * decides *what the user sees* is here so the unit tests can cover it.
 */
object Discovery {

    /**
     * Build one row. Returns null when the repo is hidden by the overlay, has no
     * release, or the release ships no installable APK.
     */
    fun entryFor(repo: Repo, release: Release?, overlay: Overlay): AppEntry? {
        if (overlay.isHidden(repo.name)) return null
        if (release == null || release.draft) return null

        val ov = overlay.app(repo.name)
        val picked = AssetClassifier.pick(release.assets, ov?.artifacts ?: emptyList()) ?: return null

        return AppEntry(
            id = repo.name.lowercase(),
            repo = repo.fullName,
            owner = repo.owner,
            name = ov?.name ?: repo.name,
            tagline = ov?.tagline ?: repo.description,
            order = ov?.order ?: 100,
            isPrivate = repo.isPrivate,
            version = release.version,
            tag = release.tag,
            notes = release.notes,
            publishedAt = release.publishedAt,
            prerelease = release.prerelease,
            asset = picked.asset,
            label = picked.label ?: "Android APK",
            packageId = picked.packageId
        )
    }

    /** Build and sort the whole list: overlay order first, then name. */
    fun build(
        repos: List<Repo>,
        releases: Map<String, Release?>,
        overlay: Overlay
    ): List<AppEntry> =
        repos.mapNotNull { entryFor(it, releases[it.fullName] ?: releases[it.name], overlay) }
            .sortedWith(compareBy({ it.order }, { it.name.lowercase() }))

    /** Normalise a user-typed "owner/repo" (tolerates URLs and stray spaces). */
    fun parseRepoRef(raw: String): Pair<String, String>? {
        var s = raw.trim()
        if (s.isEmpty()) return null
        s = s.removePrefix("https://").removePrefix("http://").removePrefix("github.com/")
        s = s.removeSuffix(".git").trim('/')
        val parts = s.split('/').filter { it.isNotBlank() }
        if (parts.size < 2) return null
        return parts[0] to parts[1]
    }
}
