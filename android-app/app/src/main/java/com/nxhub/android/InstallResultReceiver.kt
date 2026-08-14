package com.nxhub.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log

/**
 * Receives the IntentSender callback of a PackageInstaller session.
 *
 * Declared in the manifest (exported=false) so the system can always reach it,
 * and it forwards to whatever Activity is currently listening. The common case
 * is STATUS_PENDING_USER_ACTION: the OS hands back a confirmation Intent that we
 * must show to the user (this is the "do you want to install this app?" sheet).
 */
class InstallResultReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: ""
        val pkg = intent.getStringExtra(PackageInstaller.EXTRA_PACKAGE_NAME)
        val token = intent.getStringExtra(EXTRA_TOKEN) ?: ""

        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                if (confirm == null) {
                    listener?.invoke(Result(token, false, "installer gave no confirmation dialog", pkg))
                    return
                }
                val handled = listener?.let { it.invoke(Result(token, null, "confirm", pkg, confirm)); true } ?: false
                if (!handled) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    runCatching { context.startActivity(confirm) }
                        .onFailure { Log.w(TAG, "cannot show install confirmation", it) }
                }
            }
            PackageInstaller.STATUS_SUCCESS ->
                listener?.invoke(Result(token, true, "installed", pkg))
            else ->
                listener?.invoke(Result(token, false, describe(status, message), pkg))
        }
    }

    private fun describe(status: Int, message: String): String = when (status) {
        PackageInstaller.STATUS_FAILURE_ABORTED -> "cancelled"
        PackageInstaller.STATUS_FAILURE_BLOCKED -> "blocked by the device policy"
        PackageInstaller.STATUS_FAILURE_CONFLICT ->
            "conflicts with the installed copy — uninstall it first (different signing key)"
        PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "not compatible with this device"
        PackageInstaller.STATUS_FAILURE_INVALID -> "the APK is invalid"
        PackageInstaller.STATUS_FAILURE_STORAGE -> "not enough storage"
        else -> if (message.isNotBlank()) message else "install failed"
    }

    /**
     * @param success null = "needs user confirmation", carried in [confirmIntent].
     */
    data class Result(
        val token: String,
        val success: Boolean?,
        val message: String,
        val packageName: String?,
        val confirmIntent: Intent? = null
    )

    companion object {
        private const val TAG = "NXHub/Install"
        const val ACTION = "com.nxhub.android.INSTALL_RESULT"
        const val EXTRA_TOKEN = "com.nxhub.android.TOKEN"

        /** Set by MainActivity while it is resumed. */
        @Volatile
        var listener: ((Result) -> Unit)? = null
    }
}
