package com.nxhub.android.core

/**
 * The Android hub only ever installs `*.apk`. Everything else on a release —
 * AppImages, Windows zips and, importantly, the checksum/signature siblings that
 * sit next to an APK (`app.apk.sha256`, `app.apk.idsig`, `app.apk.asc`) — is
 * ignored. Since those siblings all carry an extra extension, "ends with .apk"
 * is the whole rule; [IGNORED_SUFFIXES] exists to document/assert the intent.
 */
object AssetClassifier {

    val IGNORED_SUFFIXES = listOf(
        ".sha256", ".sha1", ".sha512", ".md5", ".sig", ".asc", ".idsig",
        ".yml", ".yaml", ".json", ".blockmap", ".txt"
    )

    fun isApk(name: String): Boolean {
        val n = name.trim().lowercase()
        if (!n.endsWith(".apk")) return false
        return IGNORED_SUFFIXES.none { n.endsWith(it) }
    }

    fun apks(assets: List<Asset>): List<Asset> = assets.filter { isApk(it.name) }

    /** true when the asset is a checksum/signature sibling of another asset. */
    fun isSidecar(name: String): Boolean {
        val n = name.trim().lowercase()
        return IGNORED_SUFFIXES.any { n.endsWith(it) }
    }

    /**
     * Pick the APK to offer for a repo.
     *
     * Order of preference:
     *  1. an APK matched by a non-skip overlay artifact rule (rules are ordered),
     *  2. an APK whose name says "release",
     *  3. the largest APK (universal builds beat per-ABI splits).
     *
     * APKs matched by a `skip: true` rule are never returned.
     */
    fun pick(assets: List<Asset>, rules: List<OverlayArtifact>): PickedAsset? {
        val candidates = apks(assets).filter { asset ->
            rules.none { it.skip && Glob.matches(it.assetPattern, asset.name) }
        }
        if (candidates.isEmpty()) return null

        for (rule in rules) {
            if (rule.skip) continue
            if (rule.platform != null && rule.platform != "android") continue
            val hit = candidates.firstOrNull { Glob.matches(rule.assetPattern, it.name) }
            if (hit != null) return PickedAsset(hit, rule.label, rule.packageId)
        }

        val byName = candidates.firstOrNull { it.name.lowercase().contains("release") }
        val chosen = byName ?: candidates.maxByOrNull { it.size } ?: candidates.first()
        return PickedAsset(chosen, null, null)
    }

    data class PickedAsset(val asset: Asset, val label: String?, val packageId: String?)
}

/** Tiny glob matcher for the overlay's `assetPattern` (`*` and `?` only). */
object Glob {
    fun matches(pattern: String, name: String): Boolean {
        val regex = StringBuilder("^")
        for (c in pattern) {
            when (c) {
                '*' -> regex.append(".*")
                '?' -> regex.append('.')
                '.', '(', ')', '[', ']', '{', '}', '+', '^', '$', '|', '\\' ->
                    regex.append('\\').append(c)
                else -> regex.append(c)
            }
        }
        regex.append('$')
        return Regex(regex.toString(), RegexOption.IGNORE_CASE).matches(name.trim())
    }
}
