package com.nxhub.android

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import java.io.File

/**
 * Installs an APK with the PackageInstaller session API (available since API 21,
 * we require 26). Installing over ourselves is explicitly supported — that is the
 * self-update path for com.nxhub.android.
 */
class Installer(private val context: Context) {

    private val pm: PackageManager get() = context.packageManager

    /** Android's "install unknown apps" switch for *this* app (minSdk is 26). */
    fun canInstall(): Boolean = pm.canRequestPackageInstalls()

    /** Intent that takes the user to the per-app "install unknown apps" toggle. */
    fun unknownSourcesIntent(): Intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /**
     * Start a session install of [apk]. Progress/outcome arrives through
     * [InstallResultReceiver.listener], tagged with [token] so the caller can map
     * it back to a row.
     *
     * @return null on success (session committed), else an error message.
     */
    fun install(apk: File, token: String, packageId: String?): String? {
        if (!apk.isFile || apk.length() == 0L) return "downloaded file is missing"
        val installer = pm.packageInstaller
        var sessionId = -1
        try {
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                setSize(apk.length())
                packageId?.let { setAppPackageName(it) }
                setInstallReason(PackageManager.INSTALL_REASON_USER)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    // Ask the OS not to kill us mid-update when we replace ourselves.
                    setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_UNSPECIFIED)
                }
            }
            sessionId = installer.createSession(params)
            installer.openSession(sessionId).use { session ->
                session.openWrite(apk.name, 0, apk.length()).use { out ->
                    apk.inputStream().use { input -> input.copyTo(out, 256 * 1024) }
                    session.fsync(out)
                }
                val intent = Intent(InstallResultReceiver.ACTION).apply {
                    setPackage(context.packageName)
                    setClass(context, InstallResultReceiver::class.java)
                    putExtra(InstallResultReceiver.EXTRA_TOKEN, token)
                }
                var flags = PendingIntent.FLAG_UPDATE_CURRENT
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    // The installer fills extras in, so the PendingIntent must be mutable.
                    flags = flags or PendingIntent.FLAG_MUTABLE
                }
                val pi = PendingIntent.getBroadcast(context, sessionId, intent, flags)
                session.commit(pi.intentSender)
            }
            return null
        } catch (e: Exception) {
            Log.w(TAG, "install session failed", e)
            if (sessionId >= 0) runCatching { installer.abandonSession(sessionId) }
            return e.message ?: "install failed"
        }
    }

    /** Installed version of [packageId], or null when not installed. */
    fun installedVersion(packageId: String?): String? {
        if (packageId.isNullOrBlank()) return null
        return try {
            @Suppress("DEPRECATION")
            val info: PackageInfo = pm.getPackageInfo(packageId, 0)
            info.versionName ?: info.longVersionCodeCompat().toString()
        } catch (e: PackageManager.NameNotFoundException) {
            null
        }
    }

    fun isInstalled(packageId: String?): Boolean = installedVersion(packageId) != null

    /** packageId + versionName read straight out of a downloaded APK. */
    fun readApkIdentity(apk: File): Pair<String, String?>? {
        @Suppress("DEPRECATION")
        val info = pm.getPackageArchiveInfo(apk.absolutePath, 0) ?: return null
        return info.packageName to info.versionName
    }

    fun launchIntent(packageId: String?): Intent? {
        if (packageId.isNullOrBlank()) return null
        return pm.getLaunchIntentForPackage(packageId)
    }

    private fun PackageInfo.longVersionCodeCompat(): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) longVersionCode else @Suppress("DEPRECATION") versionCode.toLong()

    companion object {
        private const val TAG = "NXHub/Installer"
    }
}
