package com.nxhub.android

import android.util.Log
import com.nxhub.android.core.GitHubJson
import com.nxhub.android.core.Release
import com.nxhub.android.core.Repo
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Minimal GitHub REST client on HttpsURLConnection — no okhttp, no gson.
 *
 * Everything it needs (TLS, gzip, redirects, JSON) is in the platform, and the
 * whole surface is four calls, so a HTTP library would be more code to configure
 * than to replace. Adds: ETag caching in cacheDir (GitHub does not count 304s
 * against the rate limit) and auth-stripping redirect handling for asset
 * downloads (S3 rejects requests that carry both a signature and an
 * Authorization header).
 */
class GitHubClient(private val cacheDir: File, private val tokenProvider: () -> String) {

    class HttpResult(val code: Int, val body: String?, val fromCache: Boolean, val error: String? = null)

    private val httpCache = File(cacheDir, "http").apply { mkdirs() }

    // ---------------------------------------------------------------- requests

    private fun get(url: String, accept: String = "application/vnd.github+json", useCache: Boolean = true): HttpResult {
        val key = sha1(url)
        val bodyFile = File(httpCache, "$key.body")
        val etagFile = File(httpCache, "$key.etag")
        var conn: HttpURLConnection? = null
        try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 15000
                readTimeout = 30000
                setRequestProperty("Accept", accept)
                setRequestProperty("User-Agent", USER_AGENT)
                setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
                val t = tokenProvider()
                if (t.isNotEmpty()) setRequestProperty("Authorization", "Bearer $t")
                if (useCache && etagFile.exists() && bodyFile.exists()) {
                    setRequestProperty("If-None-Match", etagFile.readText().trim())
                }
            }
            val code = conn.responseCode
            if (code == 304 && bodyFile.exists()) {
                return HttpResult(code, bodyFile.readText(), true)
            }
            if (code in 200..299) {
                val body = conn.inputStream.bufferedReader().use { it.readText() }
                if (useCache) {
                    conn.getHeaderField("ETag")?.let { etag ->
                        runCatching {
                            bodyFile.writeText(body)
                            etagFile.writeText(etag)
                        }
                    }
                }
                return HttpResult(code, body, false)
            }
            val err = conn.errorStream?.bufferedReader()?.use { it.readText() }
            val remaining = conn.getHeaderField("X-RateLimit-Remaining")
            val msg = when {
                code == 401 -> "GitHub rejected the token (401)"
                code == 403 && remaining == "0" -> "GitHub rate limit reached — add a token in Settings"
                code == 404 -> "Not found (404)"
                else -> "HTTP $code"
            }
            Log.w(TAG, "$msg for $url: ${err?.take(200)}")
            return HttpResult(code, null, false, msg)
        } catch (e: Exception) {
            Log.w(TAG, "request failed: $url", e)
            // Offline: fall back to whatever we cached last time.
            if (useCache && bodyFile.exists()) return HttpResult(0, bodyFile.readText(), true)
            return HttpResult(0, null, false, e.message ?: "network error")
        } finally {
            conn?.disconnect()
        }
    }

    // ------------------------------------------------------------------ API

    /** Login of the token's owner, or null when anonymous. */
    fun authenticatedLogin(): String? {
        if (tokenProvider().isEmpty()) return null
        val r = get("$API/user")
        val body = r.body ?: return null
        return runCatching { org.json.JSONObject(body).optString("login", "") }
            .getOrNull()?.takeIf { it.isNotEmpty() }
    }

    /**
     * All non-archived repos of [owner], paginated. When [owner] is the token's
     * own account we use /user/repos so private repos come along.
     */
    fun listRepos(owner: String, self: String?): List<Repo> {
        val isSelf = self != null && self.equals(owner, ignoreCase = true)
        val out = mutableListOf<Repo>()
        var page = 1
        while (page <= MAX_PAGES) {
            val url = if (isSelf) {
                "$API/user/repos?per_page=100&page=$page&affiliation=owner&sort=updated"
            } else {
                "$API/users/$owner/repos?per_page=100&page=$page&sort=updated"
            }
            val r = get(url)
            val batch = GitHubJson.parseRepos(r.body)
            if (batch.isEmpty()) break
            out += if (isSelf) batch.filter { it.owner.equals(owner, true) } else batch
            if (batch.size < 100) break
            page++
        }
        return out.filter { !it.archived }
    }

    fun repo(owner: String, name: String): Repo? {
        val r = get("$API/repos/$owner/$name")
        val body = r.body ?: return null
        return runCatching { GitHubJson.repo(org.json.JSONObject(body)) }.getOrNull()
    }

    /**
     * Newest usable release. We read the list rather than /releases/latest so a
     * repo that only ever published pre-releases still shows up.
     */
    fun latestRelease(owner: String, name: String, includePrereleases: Boolean): Release? {
        val r = get("$API/repos/$owner/$name/releases?per_page=10")
        val body = r.body ?: return null
        val rel = GitHubJson.parseLatestFromList(body) ?: return null
        return if (!includePrereleases && rel.prerelease) null else rel
    }

    /** Live overlay; raw.githubusercontent first, contents API second. */
    fun fetchOverlay(rawUrl: String): String? {
        get(rawUrl, accept = "application/vnd.github.raw").body?.let { if (it.isNotBlank()) return it }
        val contents = "$API/repos/nerdrx/nx-hub/contents/registry/overrides.json?ref=main"
        get(contents, accept = "application/vnd.github.raw").body?.let { if (it.isNotBlank()) return it }
        return null
    }

    // -------------------------------------------------------------- download

    /**
     * Download a release asset to [dest]. GitHub answers the API asset URL with a
     * 302 to a signed S3 URL that must NOT carry our Authorization header, so
     * redirects are followed by hand.
     */
    fun downloadAsset(apiUrl: String, dest: File, expectedSize: Long, onProgress: (Long, Long) -> Unit): String? {
        // A stream the server closes early ends cleanly at the socket level, so
        // the byte count must be verified against the API's asset size — and a
        // truncated attempt is worth one retry before giving up.
        var lastError: String? = null
        repeat(3) { attempt ->
            if (attempt > 0) Thread.sleep(1500L * attempt)
            val err = downloadAssetOnce(apiUrl, dest, expectedSize, onProgress)
                ?: run {
                    if (expectedSize > 0 && dest.length() != expectedSize) {
                        val got = dest.length()
                        dest.delete()
                        "truncated download ($got of $expectedSize bytes)"
                    } else null
                }
            if (err == null) return null
            Log.w(TAG, "download attempt ${attempt + 1} failed: $err")
            lastError = err
        }
        return lastError ?: "download failed"
    }

    private fun downloadAssetOnce(apiUrl: String, dest: File, expectedSize: Long, onProgress: (Long, Long) -> Unit): String? {
        var url = apiUrl
        var authed = true
        var hops = 0
        while (hops++ < 5) {
            var conn: HttpURLConnection? = null
            try {
                conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    instanceFollowRedirects = false
                    connectTimeout = 15000
                    readTimeout = 60000
                    setRequestProperty("Accept", "application/octet-stream")
                    setRequestProperty("User-Agent", USER_AGENT)
                    val t = tokenProvider()
                    if (authed && t.isNotEmpty()) setRequestProperty("Authorization", "Bearer $t")
                }
                val code = conn.responseCode
                if (code in 300..399) {
                    val loc = conn.getHeaderField("Location") ?: return "redirect without Location"
                    url = loc
                    authed = false // the signed URL carries its own credentials
                    conn.disconnect()
                    continue
                }
                if (code !in 200..299) {
                    return if (code == 404) "asset not found (404)" else "download failed (HTTP $code)"
                }
                val total = conn.contentLengthLong.takeIf { it > 0 } ?: expectedSize
                conn.inputStream.use { input -> writeTo(input, dest, total, onProgress) }
                return null
            } catch (e: Exception) {
                Log.w(TAG, "download failed", e)
                return e.message ?: "download failed"
            } finally {
                conn?.disconnect()
            }
        }
        return "too many redirects"
    }

    private fun writeTo(input: InputStream, dest: File, total: Long, onProgress: (Long, Long) -> Unit) {
        dest.parentFile?.mkdirs()
        FileOutputStream(dest).use { out ->
            val buf = ByteArray(64 * 1024)
            var done = 0L
            var lastReport = 0L
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                done += n
                if (done - lastReport > 128 * 1024) {
                    lastReport = done
                    onProgress(done, total)
                }
            }
            out.flush()
            onProgress(done, if (total > 0) total else done)
        }
    }

    fun clearCache() {
        httpCache.listFiles()?.forEach { it.delete() }
    }

    private fun sha1(s: String): String =
        MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

    companion object {
        private const val TAG = "NXHub/GitHub"
        private const val API = "https://api.github.com"
        private const val USER_AGENT = "NX-Hub-Android/0.1.0"
        private const val MAX_PAGES = 10
    }
}
