package com.nxhub.android

import android.content.Context
import android.content.SharedPreferences

/**
 * All persisted state: sources, token, and the packageIds we learned from APKs
 * we downloaded (so a repo without an overlay packageId still shows the
 * installed version on the next launch).
 *
 * Storage is a private SharedPreferences file in the app's own data dir. The
 * token is additionally encrypted with an AES/GCM key held in the hardware-backed
 * AndroidKeyStore (see [TokenCrypto]) — this gives the same protection as
 * androidx.security's EncryptedSharedPreferences without adding a dependency
 * (androidx.security-crypto would pull in tink + androidx.core for ~1 MB and its
 * only public release is an alpha).
 */
class Settings(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val crypto = TokenCrypto(context.applicationContext)

    var owners: List<String>
        get() {
            val stored = prefs.getString(KEY_OWNERS, null)?.toList() ?: return DEFAULT_OWNERS
            // Default upgrade: a stored list equal to the ORIGINAL default gets
            // the new default; an explicit custom list is left alone.
            return if (stored == listOf("nerdrx")) DEFAULT_OWNERS else stored
        }
        set(v) = prefs.edit().putString(KEY_OWNERS, v.clean().toStored()).apply()

    var extraRepos: List<String>
        get() = prefs.getString(KEY_EXTRA_REPOS, null)?.toList() ?: emptyList()
        set(v) = prefs.edit().putString(KEY_EXTRA_REPOS, v.clean().toStored()).apply()

    /** GitHub PAT. Needed for private repos and for the live overlay fetch. */
    var token: String
        get() {
            val stored = prefs.getString(KEY_TOKEN, "") ?: ""
            if (stored.isEmpty()) return ""
            return crypto.decrypt(stored) ?: ""
        }
        set(v) {
            val e = prefs.edit()
            if (v.isBlank()) e.remove(KEY_TOKEN) else e.putString(KEY_TOKEN, crypto.encrypt(v.trim()))
            e.apply()
        }

    var includePrereleases: Boolean
        get() = prefs.getBoolean(KEY_PRERELEASE, true)
        set(v) = prefs.edit().putBoolean(KEY_PRERELEASE, v).apply()

    /** packageId learned by parsing a downloaded APK, keyed by app id. */
    fun learnedPackageId(appId: String): String? =
        prefs.getString(KEY_PKG_PREFIX + appId.lowercase(), null)

    fun rememberPackageId(appId: String, packageId: String) {
        prefs.edit().putString(KEY_PKG_PREFIX + appId.lowercase(), packageId).apply()
    }

    fun hasToken(): Boolean = token.isNotEmpty()

    private fun String.toList(): List<String> =
        split('\n', ',').map { it.trim() }.filter { it.isNotEmpty() }

    private fun List<String>.clean(): List<String> =
        map { it.trim() }.filter { it.isNotEmpty() }.distinct()

    private fun List<String>.toStored(): String = joinToString("\n")

    companion object {
        const val PREFS = "nxhub"
        private const val KEY_OWNERS = "owners"
        private const val KEY_EXTRA_REPOS = "extraRepos"
        private const val KEY_TOKEN = "token_enc"
        private const val KEY_PRERELEASE = "includePrereleases"
        private const val KEY_PKG_PREFIX = "pkg."
        val DEFAULT_OWNERS = listOf("nerdrx", "Arikazei")
        const val OVERLAY_URL =
            "https://raw.githubusercontent.com/nerdrx/nx-hub/main/registry/overrides.json"
    }
}
