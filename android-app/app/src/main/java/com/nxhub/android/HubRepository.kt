package com.nxhub.android

import android.content.Context
import android.util.Log
import com.nxhub.android.core.AppEntry
import com.nxhub.android.core.Discovery
import com.nxhub.android.core.Overlay
import com.nxhub.android.core.Release
import com.nxhub.android.core.Repo
import java.io.File
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Discovery orchestration: sources → repos → latest releases → overlay merge →
 * installed-version annotation. Runs on a caller-supplied background thread.
 */
class HubRepository(private val context: Context) {

    val settings = Settings(context)
    val installer = Installer(context)
    val github = GitHubClient(context.cacheDir) { settings.token }

    data class Result(val apps: List<AppEntry>, val warnings: List<String>, val overlayLive: Boolean)

    fun refresh(force: Boolean, onStatus: (String) -> Unit): Result {
        val warnings = mutableListOf<String>()
        if (force) github.clearCache()

        onStatus("Loading registry…")
        val liveOverlay = github.fetchOverlay(Settings.OVERLAY_URL)
        val overlayJson = liveOverlay ?: bundledOverlay()
        if (liveOverlay == null) {
            warnings += "Using the bundled registry (live copy unreachable" +
                (if (settings.hasToken()) ")" else " — a token is needed while nx-hub is private)")
        }
        val overlay = Overlay.parse(overlayJson)

        val self = try { github.authenticatedLogin() } catch (e: Exception) { null }
        if (settings.hasToken() && self == null) warnings += "Token not accepted by GitHub"

        onStatus("Listing repositories…")
        val repos = LinkedHashMap<String, Repo>()
        for (owner in settings.owners) {
            val list = try { github.listRepos(owner, self) } catch (e: Exception) {
                warnings += "Could not list repos of $owner"
                emptyList()
            }
            if (list.isEmpty()) warnings += "No repositories found for $owner"
            list.forEach { repos[it.fullName.lowercase()] = it }
        }
        for (ref in settings.extraRepos) {
            val parsed = Discovery.parseRepoRef(ref) ?: continue
            if (repos.containsKey("${parsed.first}/${parsed.second}".lowercase())) continue
            val r = try { github.repo(parsed.first, parsed.second) } catch (e: Exception) { null }
            if (r == null) warnings += "Cannot read $ref" else repos[r.fullName.lowercase()] = r
        }

        val visible = repos.values.filter { !overlay.isHidden(it.name) }
        onStatus("Checking ${visible.size} repos for releases…")

        val pool = Executors.newFixedThreadPool(POOL)
        val releases = HashMap<String, Release?>()
        try {
            val tasks = visible.map { repo ->
                Callable {
                    repo.fullName to try {
                        github.latestRelease(repo.owner, repo.name, settings.includePrereleases)
                    } catch (e: Exception) {
                        Log.w(TAG, "release fetch failed for ${repo.fullName}", e)
                        null
                    }
                }
            }
            pool.invokeAll(tasks, 120, TimeUnit.SECONDS).forEach { f ->
                runCatching { f.get() }.getOrNull()?.let { releases[it.first] = it.second }
            }
        } finally {
            pool.shutdownNow()
        }

        val apps = Discovery.build(visible, releases, overlay).map { annotate(it) }
        if (apps.isEmpty() && warnings.isEmpty()) warnings += "No repository has a release with an APK"
        return Result(apps, warnings, liveOverlay != null)
    }

    /** Fill in packageId (overlay → learned → self) and the installed version. */
    fun annotate(entry: AppEntry): AppEntry {
        val pkg = entry.packageId
            ?: settings.learnedPackageId(entry.id)
            ?: if (entry.id == "nx-hub") context.packageName else null
        val installed = installer.installedVersion(pkg)
        return entry.copy(
            packageId = pkg,
            installedVersion = installed,
            installed = installed != null
        )
    }

    /** Remember the packageId of an APK we just downloaded, for repos with no overlay entry. */
    fun learnFromApk(entry: AppEntry, apk: File): String? {
        val id = installer.readApkIdentity(apk)?.first ?: return null
        settings.rememberPackageId(entry.id, id)
        return id
    }

    fun apkCacheFile(entry: AppEntry): File =
        File(File(context.cacheDir, "apk").apply { mkdirs() }, "${entry.id}-${entry.version}.apk")

    fun clearApkCache() {
        File(context.cacheDir, "apk").listFiles()?.forEach { it.delete() }
    }

    private fun bundledOverlay(): String? = try {
        context.assets.open("overrides.json").bufferedReader().use { it.readText() }
    } catch (e: Exception) {
        Log.w(TAG, "bundled overlay missing", e)
        null
    }

    companion object {
        private const val TAG = "NXHub/Repo"
        private const val POOL = 6
    }
}
