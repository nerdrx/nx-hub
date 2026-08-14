package com.nxhub.android

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.format.Formatter
import android.util.Log
import android.view.LayoutInflater
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.nxhub.android.core.AppEntry
import java.util.concurrent.Executors

/**
 * The whole UI: header, app list, settings sheet, install flow.
 *
 * One Activity, plain android.widget views, no RecyclerView — the list is a
 * handful of rows and inflating them into a LinearLayout inside a ScrollView is
 * both simpler and smoother on the Pico's 2D panel than a recycler would be.
 */
class MainActivity : Activity() {

    private lateinit var repo: HubRepository
    private lateinit var appList: LinearLayout
    private lateinit var statusText: TextView
    private lateinit var emptyText: TextView
    private lateinit var topProgress: ProgressBar
    private lateinit var snackbar: TextView
    private lateinit var pullHint: TextView
    private lateinit var scroller: PullRefreshScrollView

    private val ui = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val downloads = Executors.newFixedThreadPool(2)

    private var apps: List<AppEntry> = emptyList()
    private val rows = HashMap<String, RowHolder>()
    private var refreshing = false
    private var pendingInstall: AppEntry? = null

    private class RowHolder(val view: View, var entry: AppEntry) {
        val name: TextView = view.findViewById(R.id.appName)
        val chip: TextView = view.findViewById(R.id.versionChip)
        val tagline: TextView = view.findViewById(R.id.tagline)
        val versionLine: TextView = view.findViewById(R.id.versionLine)
        val progress: ProgressBar = view.findViewById(R.id.rowProgress)
        val primary: Button = view.findViewById(R.id.primaryButton)
        val secondary: Button = view.findViewById(R.id.secondaryButton)
        val notesButton: Button = view.findViewById(R.id.notesButton)
        val notes: TextView = view.findViewById(R.id.notesText)
        var busy = false
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        repo = HubRepository(this)

        appList = findViewById(R.id.appList)
        statusText = findViewById(R.id.statusText)
        emptyText = findViewById(R.id.emptyText)
        topProgress = findViewById(R.id.topProgress)
        snackbar = findViewById(R.id.snackbar)
        pullHint = findViewById(R.id.pullHint)
        scroller = findViewById(R.id.scroller)

        findViewById<ImageButton>(R.id.refreshButton).setOnClickListener { refresh(force = true) }
        findViewById<ImageButton>(R.id.settingsButton).setOnClickListener { showSettings() }

        scroller.onRefresh = { refresh(force = true) }
        scroller.onPullProgress = { p ->
            if (!refreshing) {
                pullHint.text = if (p >= 1f) getString(R.string.release_to_refresh) else getString(R.string.pull_to_refresh)
                pullHint.alpha = 0.4f + 0.6f * p
            }
        }

        refresh(force = false)
    }

    override fun onResume() {
        super.onResume()
        InstallResultReceiver.listener = { result -> ui.post { onInstallResult(result) } }
        // Versions can change while we were away (user installed something else).
        if (!refreshing && apps.isNotEmpty()) reannotateAll()

        // Coming back from Settings → "Allow from this source": pick up where we left off.
        pendingInstall?.let { entry ->
            if (repo.installer.canInstall()) {
                pendingInstall = null
                rows[entry.id]?.let { startInstall(it) }
            }
        }
    }

    override fun onPause() {
        super.onPause()
        InstallResultReceiver.listener = null
    }

    override fun onDestroy() {
        super.onDestroy()
        io.shutdownNow()
        downloads.shutdownNow()
    }

    // ------------------------------------------------------------- discovery

    private fun refresh(force: Boolean) {
        if (refreshing) return
        refreshing = true
        topProgress.visibility = View.VISIBLE
        pullHint.text = getString(R.string.refreshing)
        pullHint.alpha = 1f
        statusText.text = getString(R.string.refreshing)

        io.execute {
            val result = try {
                repo.refresh(force) { msg -> ui.post { statusText.text = msg } }
            } catch (e: Exception) {
                Log.w(TAG, "refresh failed", e)
                HubRepository.Result(emptyList(), listOf(e.message ?: "refresh failed"), false)
            }
            ui.post {
                refreshing = false
                topProgress.visibility = View.GONE
                pullHint.text = getString(R.string.pull_to_refresh)
                pullHint.alpha = 0.6f
                apps = result.apps
                render()
                val updates = apps.count { it.updateAvailable }
                statusText.text = buildString {
                    append("${apps.size} app${if (apps.size == 1) "" else "s"}")
                    if (updates > 0) append(" · $updates update${if (updates == 1) "" else "s"}")
                    if (!result.overlayLive) append(" · bundled registry")
                }
                if (result.warnings.isNotEmpty()) toast(result.warnings.first())
            }
        }
    }

    private fun reannotateAll() {
        val updated = apps.map { repo.annotate(it) }
        apps = updated
        updated.forEach { e -> rows[e.id]?.let { bindRow(it, e) } }
    }

    // ------------------------------------------------------------------ list

    private fun render() {
        appList.removeAllViews()
        rows.clear()
        val inflater = LayoutInflater.from(this)
        for (entry in apps) {
            val view = inflater.inflate(R.layout.row_app, appList, false)
            val holder = RowHolder(view, entry)
            rows[entry.id] = holder
            bindRow(holder, entry)
            appList.addView(view)
        }
        emptyText.visibility = if (apps.isEmpty()) View.VISIBLE else View.GONE
        if (apps.isEmpty()) {
            emptyText.text = if (repo.settings.hasToken()) {
                "Nothing found yet.\n\nCheck the owners and extra repos in Settings, then pull down to refresh."
            } else {
                "Nothing found yet.\n\nPrivate repos need a GitHub token — add one in Settings (top right), then pull down to refresh."
            }
        }
    }

    private fun bindRow(h: RowHolder, entry: AppEntry) {
        h.entry = entry
        h.name.text = entry.name
        h.chip.text = entry.version
        h.tagline.text = if (entry.tagline.isNotBlank()) entry.tagline else entry.repo
        h.tagline.visibility = if (h.tagline.text.isNullOrBlank()) View.GONE else View.VISIBLE

        val size = Formatter.formatShortFileSize(this, entry.asset.size)
        val meta = buildString {
            append(entry.repo)
            append(" · ").append(size)
            if (entry.prerelease) append(" · pre-release")
        }

        when {
            entry.updateAvailable -> {
                h.versionLine.text = "Installed ${entry.installedVersion}  →  ${entry.version}   ·   $meta"
                h.versionLine.setTextColor(getColor(R.color.nx_amber))
            }
            entry.installed -> {
                h.versionLine.text = "Installed ${entry.installedVersion ?: entry.version} · up to date   ·   $meta"
                h.versionLine.setTextColor(getColor(R.color.nx_dim))
            }
            else -> {
                h.versionLine.text = "Not installed   ·   $meta"
                h.versionLine.setTextColor(getColor(R.color.nx_dim))
            }
        }

        if (!h.busy) applyButtons(h, entry)

        h.notesButton.visibility = if (entry.notes.isBlank()) View.INVISIBLE else View.VISIBLE
        h.notesButton.setOnClickListener {
            if (h.notes.visibility == View.VISIBLE) {
                h.notes.visibility = View.GONE
            } else {
                h.notes.text = entry.notes.take(4000)
                h.notes.visibility = View.VISIBLE
            }
        }
    }

    private fun applyButtons(h: RowHolder, entry: AppEntry) {
        h.primary.isEnabled = true
        h.secondary.visibility = View.GONE
        val launchable = repo.installer.launchIntent(entry.packageId) != null

        when {
            entry.updateAvailable -> {
                h.primary.text = getString(R.string.update)
                h.primary.setBackgroundResource(R.drawable.btn_amber)
                h.primary.setTextColor(0xFF201400.toInt())
                h.primary.setOnClickListener { startInstall(h) }
                if (launchable) {
                    h.secondary.visibility = View.VISIBLE
                    h.secondary.text = getString(R.string.launch)
                    h.secondary.setOnClickListener { launch(entry) }
                }
            }
            entry.installed -> {
                if (launchable) {
                    h.primary.text = getString(R.string.launch)
                    h.primary.setBackgroundResource(R.drawable.btn_outline_cyan)
                    h.primary.setTextColor(getColor(R.color.nx_cyan))
                    h.primary.setOnClickListener { launch(entry) }
                } else {
                    h.primary.text = "Installed"
                    h.primary.setBackgroundResource(R.drawable.btn_ghost)
                    h.primary.setTextColor(getColor(R.color.nx_muted))
                    h.primary.isEnabled = false
                }
                h.secondary.visibility = View.VISIBLE
                h.secondary.text = "Reinstall"
                h.secondary.setBackgroundResource(R.drawable.btn_ghost)
                h.secondary.setTextColor(getColor(R.color.nx_muted))
                h.secondary.setOnClickListener { startInstall(h) }
            }
            else -> {
                h.primary.text = getString(R.string.install)
                h.primary.setBackgroundResource(R.drawable.btn_violet)
                h.primary.setTextColor(0xFFFFFFFF.toInt())
                h.primary.setOnClickListener { startInstall(h) }
            }
        }
    }

    private fun launch(entry: AppEntry) {
        val intent = repo.installer.launchIntent(entry.packageId)
        if (intent == null) {
            toast("${entry.name} has no launcher screen")
            return
        }
        try {
            startActivity(intent)
        } catch (e: Exception) {
            toast("Could not launch ${entry.name}")
        }
    }

    // --------------------------------------------------------------- install

    private fun startInstall(h: RowHolder) {
        val entry = h.entry
        if (!repo.installer.canInstall()) {
            pendingInstall = entry
            showUnknownSourcesDialog()
            return
        }
        h.busy = true
        h.primary.isEnabled = false
        h.secondary.visibility = View.GONE
        h.primary.text = "Downloading…"
        h.progress.visibility = View.VISIBLE
        h.progress.progress = 0

        downloads.execute {
            val dest = repo.apkCacheFile(entry)
            var error: String? = null
            if (!(dest.isFile && dest.length() == entry.asset.size && entry.asset.size > 0)) {
                dest.delete()
                error = repo.github.downloadAsset(entry.asset.apiUrl, dest, entry.asset.size) { done, total ->
                    val pct = if (total > 0) ((done * 100) / total).toInt() else 0
                    ui.post { h.progress.progress = pct }
                }
            } else {
                ui.post { h.progress.progress = 100 }
            }
            if (error != null) {
                dest.delete()
                ui.post { failRow(h, "Download failed: $error") }
                return@execute
            }

            // Learn the real packageId from the APK when the overlay has none.
            val learned = if (entry.packageId == null) repo.learnFromApk(entry, dest) else entry.packageId
            ui.post {
                h.entry = entry.copy(packageId = learned)
                h.primary.text = "Installing…"
            }
            val err = repo.installer.install(dest, entry.id, learned)
            if (err != null) ui.post { failRow(h, "Install failed: $err") }
        }
    }

    private fun failRow(h: RowHolder, message: String) {
        h.busy = false
        h.progress.visibility = View.GONE
        applyButtons(h, h.entry)
        toast(message)
    }

    private fun onInstallResult(result: InstallResultReceiver.Result) {
        val h = rows[result.token]
        when (result.success) {
            null -> {
                // System wants the user to confirm — show its dialog.
                result.confirmIntent?.let {
                    try {
                        startActivity(it)
                    } catch (e: Exception) {
                        h?.let { row -> failRow(row, "Could not open the install dialog") }
                    }
                }
                h?.primary?.text = "Confirm…"
            }
            true -> {
                val entry = h?.entry
                if (h != null && entry != null) {
                    h.busy = false
                    h.progress.visibility = View.GONE
                    val pkg = entry.packageId ?: result.packageName
                    val updated = repo.annotate(entry.copy(packageId = pkg))
                    apps = apps.map { if (it.id == updated.id) updated else it }
                    bindRow(h, updated)
                    repo.apkCacheFile(entry).delete()
                    toast("${entry.name} ${entry.version} installed")
                } else {
                    toast("Installed")
                    reannotateAll()
                }
            }
            false -> {
                if (h != null) failRow(h, result.message.replaceFirstChar { it.uppercase() })
                else toast(result.message)
            }
        }
    }

    private fun showUnknownSourcesDialog() {
        AlertDialog.Builder(this, R.style.Theme_NXHub_Dialog)
            .setTitle(R.string.unknown_sources_title)
            .setMessage(R.string.unknown_sources_body)
            .setPositiveButton(R.string.open_settings) { _, _ ->
                try {
                    startActivity(repo.installer.unknownSourcesIntent())
                } catch (e: Exception) {
                    toast("Open Settings → Apps → NX Hub → Install unknown apps")
                }
            }
            .setNegativeButton(R.string.not_now, null)
            .show()
    }

    // -------------------------------------------------------------- settings

    private fun showSettings() {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_settings, null)
        val owners = view.findViewById<EditText>(R.id.ownersInput)
        val extras = view.findViewById<EditText>(R.id.extraReposInput)
        val token = view.findViewById<EditText>(R.id.tokenInput)
        val prerelease = view.findViewById<CheckBox>(R.id.prereleaseCheck)

        owners.setText(repo.settings.owners.joinToString("\n"))
        extras.setText(repo.settings.extraRepos.joinToString("\n"))
        token.setText(repo.settings.token)
        prerelease.isChecked = repo.settings.includePrereleases

        val dialog = AlertDialog.Builder(this, R.style.Theme_NXHub_Dialog)
            .setTitle(R.string.sources)
            .setView(view)
            .setPositiveButton(R.string.save) { _, _ ->
                repo.settings.owners = owners.text.toString().split('\n', ',')
                repo.settings.extraRepos = extras.text.toString().split('\n', ',')
                repo.settings.token = token.text.toString()
                repo.settings.includePrereleases = prerelease.isChecked
                refresh(force = true)
            }
            .setNegativeButton(R.string.cancel, null)
            .create()

        view.findViewById<Button>(R.id.clearCacheButton).setOnClickListener {
            repo.github.clearCache()
            repo.clearApkCache()
            toast("Cache cleared")
            dialog.dismiss()
            refresh(force = true)
        }
        dialog.show()
    }

    // ------------------------------------------------------------- snackbar

    private val hideSnack = Runnable { snackbar.visibility = View.GONE }

    private fun toast(message: String) {
        snackbar.text = message
        snackbar.visibility = View.VISIBLE
        ui.removeCallbacks(hideSnack)
        ui.postDelayed(hideSnack, 5000)
    }

    companion object {
        private const val TAG = "NXHub/Main"
    }
}
