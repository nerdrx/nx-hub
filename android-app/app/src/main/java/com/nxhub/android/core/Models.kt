package com.nxhub.android.core

/**
 * Pure-JVM data model shared by discovery and the UI. Nothing in this package
 * touches the Android framework, so all of it is exercised by ./gradlew test.
 */

/** One downloadable file attached to a GitHub release. */
data class Asset(
    val name: String,
    /** API asset URL — download with Accept: application/octet-stream (works for private repos). */
    val apiUrl: String,
    val browserUrl: String,
    val size: Long
)

/** A GitHub release, reduced to what the installer needs. */
data class Release(
    val tag: String,
    val title: String,
    val notes: String,
    val publishedAt: String,
    val prerelease: Boolean,
    val draft: Boolean,
    val assets: List<Asset>
) {
    val version: String get() = VersionUtil.normalize(tag)
}

/** A GitHub repository. */
data class Repo(
    val name: String,
    val owner: String,
    val description: String,
    val isPrivate: Boolean,
    val archived: Boolean = false
) {
    val fullName: String get() = "$owner/$name"
}

/**
 * One row in the app list: a repo whose latest release ships an APK we can install.
 * [installedVersion]/[installedPackageId] are filled in on-device by PackageManager
 * and are absent in the pure discovery output.
 */
data class AppEntry(
    val id: String,
    val repo: String,
    val owner: String,
    val name: String,
    val tagline: String,
    val order: Int,
    val isPrivate: Boolean,
    val version: String,
    val tag: String,
    val notes: String,
    val publishedAt: String,
    val prerelease: Boolean,
    val asset: Asset,
    val label: String,
    /** From the overlay when known, else learned from the downloaded APK. */
    val packageId: String?,
    val installedVersion: String? = null,
    val installed: Boolean = false
) {
    val updateAvailable: Boolean
        get() = installed && installedVersion != null &&
            VersionUtil.compare(version, installedVersion) > 0
}
