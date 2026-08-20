// Settings slide-over. Pure renderer over a local draft of the settings object;
// app.js owns the draft and only calls setSettings() on save.
//
// v0.2 sections (updates, startup, downloads, storage, logs, backup) hide
// themselves when the matching bridge method is missing — `ctx.caps.<name> ===
// false` means "this build cannot do it", anything else means available.

import { esc } from '../lib/html.js';
import { isValidRepoRef } from '../lib/model.js';
import { GLOBAL_POLICIES, policyLabel } from '../lib/prefs.js';
import { usageRows, usageTotalLabel } from '../lib/storage.js';
import { problemLabel, problemChip, auditSummaryText, rowSummaryText } from '../lib/audit.js';
import * as icons from './icons.js';

function chip(value, kind) {
  return `<span class="chip-edit">${esc(value)}<button class="chip-x" data-act="remove-${esc(kind)}" data-value="${esc(value)}" title="Remove">${icons.close}</button></span>`;
}

function check(field, label, checked, note) {
  return `
    <label class="check">
      <input type="checkbox" data-field="${esc(field)}"${checked ? ' checked' : ''}>
      <span class="check-box" aria-hidden="true"></span>
      <span class="check-text">${esc(label)}${note ? `<span class="check-note">${esc(note)}</span>` : ''}</span>
    </label>`;
}

/**
 * v0.10 [audit] — one install's verdict.
 *
 * A clean row is one quiet line with a cyan check; a broken one lists every
 * problem it has, each with the path that failed, and offers Repair. Repair is
 * a reinstall through the normal pipeline, so it reports through the normal job
 * bar on the app's card — the button says so rather than pretending the row
 * will animate.
 */
export function renderAuditRow(row, ctx = {}) {
  const apps = Array.isArray(ctx.apps) ? ctx.apps : [];
  const app = apps.find((a) => a && a.id === row.appId);
  const name = (app && app.name) || row.appId;
  const canRepair = ctx.caps ? ctx.caps.repairInstall !== false : true;
  const busy = ctx.repairing === `${row.appId}::${row.artifactId}`;

  return `
    <div class="audit-row${row.ok ? ' is-ok' : ' is-bad'}${
      row.deviceResident ? ' is-device' : ''
    }" data-audit="${esc(row.appId)}::${esc(row.artifactId)}">
      <div class="audit-top">
        <span class="audit-mark" aria-hidden="true">${row.ok ? (row.deviceResident ? '·' : '✓') : '!'}</span>
        <span class="audit-name">${esc(name)}</span>
        ${row.artifactId ? `<span class="audit-art mono">${esc(row.artifactId)}</span>` : ''}
        <span class="audit-sum">${esc(rowSummaryText(row))}</span>
        ${
          !row.ok && canRepair
            ? `<button class="btn btn-outline btn-sm" data-act="repair-install" data-app="${esc(row.appId)}"
                 data-art="${esc(row.artifactId)}"${busy ? ' disabled' : ''}
                 title="${esc(`Reinstall ${name} from its release`)}">${busy ? 'Repairing…' : 'Repair'}</button>`
            : ''
        }
      </div>
      ${
        row.problems.length
          ? `<ul class="audit-problems">${row.problems
              .map(
                (p) => `<li class="audit-problem">
                  <span class="audit-kind">${esc(problemChip(p.kind))}</span>
                  <span class="audit-what">${esc(problemLabel(p.kind))}</span>
                  ${p.path ? `<span class="audit-path mono" title="${esc(p.path)}">${esc(p.path)}</span>` : ''}
                  ${p.detail ? `<span class="audit-detail">${esc(p.detail)}</span>` : ''}
                </li>`
              )
              .join('')}</ul>`
          : ''
      }
    </div>`;
}

/** The "Verify installs" block inside Storage. Absent without getAudit(). */
export function renderAuditBlock(audit, ctx = {}) {
  const state = audit || {};
  const ran = !!state.ran;
  const rows = Array.isArray(state.rows) ? state.rows : [];

  const body = state.loading
    ? '<p class="field-note">Checking every install…</p>'
    : state.error
      ? `<p class="field-error">${esc(state.error)}</p>`
      : !ran
        ? '<p class="field-note">Checks every installed file against what the hub recorded — folders, manifests, binaries and checksums.</p>'
        : rows.length
          ? `<p class="field-note">${esc(auditSummaryText(rows))}</p>
             <div class="audit-list">${rows.map((r) => renderAuditRow(r, ctx)).join('')}</div>`
          : '<p class="field-note">Nothing installed by the hub to check.</p>';

  return `
    <div class="audit">
      ${body}
      <div class="row row-wrap">
        <button class="btn btn-ghost btn-sm" data-act="verify-installs"${state.loading ? ' disabled' : ''}>${
          icons.shield
        }<span>${state.loading ? 'Verifying…' : ran ? 'Verify again' : 'Verify installs'}</span></button>
      </div>
    </div>`;
}

/** Storage bars — one per app plus the download cache, biggest first. */
export function renderStorageSection(usage, apps, ctx = {}) {
  const rows = usageRows(usage, apps);
  const total = usageTotalLabel(usage);
  const caps = ctx.caps || {};
  const canClear = caps.clearDownloadCache !== false;
  const canAudit = caps.getAudit !== false;
  // A build can have the audit without the measurer: the bars go, the section
  // (and its Verify button) stay.
  const canMeasure = caps.getDiskUsage !== false;

  const body = ctx.loading
    ? '<p class="field-note">Measuring…</p>'
    : !usage
      ? `<p class="field-note">Not measured yet.</p>`
      : rows.length
        ? `<div class="usage">${rows
            .map(
              (r) => `<div class="usage-row${r.cache ? ' usage-cache' : ''}">
                <div class="usage-top"><span class="usage-name">${esc(r.name)}</span><span class="usage-size">${esc(r.size)}</span></div>
                <div class="usage-bar"><span style="width:${r.pct}%"></span></div>
              </div>`
            )
            .join('')}</div>`
        : '<p class="field-note">Nothing installed by the hub yet.</p>';

  return `
    <section class="fieldset">
      <h3>${icons.disk}<span>Storage</span></h3>
      ${canMeasure ? body : ''}
      ${canMeasure && total ? `<p class="usage-total">Total <strong>${esc(total)}</strong></p>` : ''}
      ${
        canMeasure || canClear
          ? `<div class="row row-wrap">
               ${canMeasure ? `<button class="btn btn-ghost btn-sm" data-act="disk-usage">${icons.refresh}<span>${usage ? 'Re-measure' : 'Measure'}</span></button>` : ''}
               ${canClear ? `<button class="btn btn-ghost btn-sm" data-act="clear-cache">${icons.trash}<span>Clear download cache</span></button>` : ''}
             </div>`
          : ''
      }
      ${ctx.freed ? `<p class="field-ok">${esc(ctx.freed)}</p>` : ''}
      ${canAudit ? renderAuditBlock(ctx.audit, { caps, apps, repairing: ctx.repairing }) : ''}
    </section>`;
}

export function renderLogsSection(logs = {}) {
  const body = logs.loading
    ? '<p class="field-note">Reading the log…</p>'
    : logs.error
      ? `<p class="field-error">${esc(logs.error)}</p>`
      : logs.text
        ? `<pre class="logbox" tabindex="0">${esc(logs.text)}</pre>`
        : '<p class="field-note">The last 200 lines of the hub log, on demand.</p>';

  return `
    <section class="fieldset">
      <h3>${icons.terminal}<span>Logs</span></h3>
      ${body}
      <div class="row row-wrap">
        <button class="btn btn-ghost btn-sm" data-act="load-logs">${icons.refresh}<span>${logs.text ? 'Reload' : 'Show last 200 lines'}</span></button>
        ${logs.text ? `<button class="btn btn-ghost btn-sm" data-act="copy-logs">${icons.copy}<span>Copy</span></button>` : ''}
      </div>
    </section>`;
}

/** Result block after importSettings() — normalized shape from lib/storage.js. */
export function renderImportResult(result) {
  if (!result) return '';
  return `
    <div class="import-result ${result.ok ? 'ok' : 'bad'}" role="status">
      <span>${esc(result.message)}</span>
      ${
        result.warnings && result.warnings.length
          ? `<ul class="import-warnings">${result.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
          : ''
      }
    </div>`;
}

export function renderBackupSection(ctx = {}) {
  const caps = ctx.caps || {};
  const canExport = caps.exportSettings !== false;
  const canImport = caps.importSettings !== false;
  if (!canExport && !canImport) return '';
  return `
    <section class="fieldset">
      <h3>Backup</h3>
      <p class="field-note">Sources, tokens excluded on request, per-app options — everything in one JSON file.</p>
      <div class="row row-wrap">
        ${canExport ? `<button class="btn btn-ghost btn-sm" data-act="export-settings">${icons.download}<span>Export settings</span></button>` : ''}
        ${canImport ? `<button class="btn btn-ghost btn-sm" data-act="import-settings">${icons.upload}<span>Import settings</span></button>` : ''}
      </div>
      ${renderImportResult(ctx.importResult)}
    </section>`;
}

export function renderSettingsPanel(draft, ctx = {}) {
  const d = draft || {};
  const caps = ctx.caps || {};
  const owners = Array.isArray(d.owners) ? d.owners : [];
  const extra = Array.isArray(d.extraRepos) ? d.extraRepos : [];
  const tokenPlaceholder = ctx.tokenSource === 'gh' ? 'using gh CLI token' : 'ghp_… (optional)';
  const concurrency = Number(d.maxConcurrentDownloads) || 2;

  return `
  <div class="panel-backdrop" data-act="close-settings"></div>
  <aside class="panel" role="dialog" aria-label="Settings" aria-modal="true">
    <header class="panel-head">
      <h2>Settings</h2>
      <button class="btn btn-icon" data-act="close-settings" title="Close (Esc)">${icons.close}</button>
    </header>

    <div class="panel-body">
      <section class="fieldset">
        <h3>Sources</h3>
        <label class="lbl" for="set-owner">GitHub owners — every repo of these accounts is scanned</label>
        <div class="chips">${owners.map((o) => chip(o, 'owner')).join('') || '<span class="muted">none — add one below</span>'}</div>
        <div class="row">
          <input id="set-owner" class="input" type="text" placeholder="github username or org" autocomplete="off" data-field="ownerInput">
          <button class="btn btn-violet btn-sm" data-act="add-owner">Add</button>
        </div>

        <label class="lbl" for="set-repo">Extra repositories — hand-pinned <code>owner/repo</code></label>
        <div class="chips">${extra.map((r) => chip(r, 'repo')).join('') || '<span class="muted">none</span>'}</div>
        <div class="row">
          <input id="set-repo" class="input ${ctx.repoError ? 'invalid' : ''}" type="text" placeholder="owner/repo" autocomplete="off" data-field="repoInput">
          <button class="btn btn-violet btn-sm" data-act="add-repo">Add</button>
        </div>
        ${ctx.repoError ? `<p class="field-error">${esc(ctx.repoError)}</p>` : ''}
      </section>

      <section class="fieldset">
        <h3>Access</h3>
        <label class="lbl" for="set-token">GitHub token — needed for private repos and higher rate limits</label>
        <input id="set-token" class="input" type="password" data-field="token" value="${esc(d.token || '')}" placeholder="${esc(tokenPlaceholder)}" autocomplete="off" spellcheck="false">
        ${
          !d.token && ctx.tokenSource === 'gh'
            ? '<p class="field-note">Leave empty to keep using the token from the <code>gh</code> CLI.</p>'
            : ''
        }
      </section>

      <section class="fieldset">
        <h3>Updates</h3>
        <label class="lbl" for="set-policy">When a new release appears</label>
        <select id="set-policy" class="input" data-field="updatePolicy">
          ${GLOBAL_POLICIES.map(
            (p) => `<option value="${esc(p)}"${d.updatePolicy === p ? ' selected' : ''}>${esc(policyLabel(p, d))}</option>`
          ).join('')}
        </select>
        <p class="field-note">Single apps can override this under “App options…”.</p>
        ${check('includePrereleases', 'Include pre-releases', !!d.includePrereleases, 'alpha/beta tags count as updates')}
        ${check('notifications', 'Desktop notifications', d.notifications !== false, 'a system notification when an update lands')}
        ${check(
          'requireSignatures',
          'Require signed releases',
          !!d.requireSignatures,
          'refuse unsigned assets from trusted publishers'
        )}
        <label class="lbl" for="set-interval">Check for updates every (hours)</label>
        <input id="set-interval" class="input input-num" type="number" min="0" max="168" step="1" data-field="checkIntervalHours" value="${esc(d.checkIntervalHours ?? 6)}">
      </section>

      <section class="fieldset">
        <h3>Startup &amp; desktop</h3>
        ${check('autostart', 'Start NX Hub at login', !!d.autostart, 'creates an XDG autostart entry')}
        ${check('startMinimized', 'Start minimized to the tray', !!d.startMinimized)}
        ${check('createDesktopEntries', 'Create desktop entries for installed apps', d.createDesktopEntries !== false, 'menu entries + icons under ~/.local/share/applications')}
        ${check('cliShim', 'Install the nx terminal command', d.cliShim !== false, 'keeps ~/.local/bin/nx pointing at this hub — list, install, update and launch from any shell')}
        ${check('autoRunPostInstallCmd', 'Auto-run post-install commands', !!d.autoRunPostInstallCmd, 'runs an app’s declared command right after install; privileged commands are never auto-run by background updates')}
      </section>

      <section class="fieldset">
        <h3>Downloads</h3>
        <label class="lbl" for="set-conc">Parallel downloads</label>
        <div class="stepper">
          <button class="btn btn-ghost btn-icon" data-act="step" data-field="maxConcurrentDownloads" data-delta="-1" aria-label="Fewer"${concurrency <= 1 ? ' disabled' : ''}>−</button>
          <input id="set-conc" class="input input-num stepper-value" type="number" min="1" max="4" step="1" data-field="maxConcurrentDownloads" value="${esc(concurrency)}" aria-label="Parallel downloads">
          <button class="btn btn-ghost btn-icon" data-act="step" data-field="maxConcurrentDownloads" data-delta="1" aria-label="More"${concurrency >= 4 ? ' disabled' : ''}>+</button>
        </div>
        <p class="field-note">One job per app at a time either way — this caps how many apps download at once.</p>
      </section>

      <section class="fieldset">
        <h3>Locations</h3>
        <label class="lbl" for="set-root">Install root</label>
        <input id="set-root" class="input" type="text" data-field="installRoot" value="${esc(d.installRoot || '')}" placeholder="~/Applications" spellcheck="false">
        <label class="lbl" for="set-adb">adb path</label>
        <input id="set-adb" class="input" type="text" data-field="adbPath" value="${esc(d.adbPath || '')}" placeholder="adb" spellcheck="false">
      </section>

      ${
        caps.getDiskUsage === false && caps.getAudit === false && caps.clearDownloadCache === false
          ? ''
          : renderStorageSection(ctx.diskUsage, ctx.apps, {
              caps,
              loading: ctx.diskLoading,
              freed: ctx.freed,
              audit: ctx.audit,
              repairing: ctx.repairing,
            })
      }
      ${caps.getLogs === false ? '' : renderLogsSection(ctx.logs)}
      ${renderBackupSection({ caps, importResult: ctx.importResult })}

      <section class="fieldset">
        <h3>About</h3>
        <p class="about-row">NX Hub <strong>${esc(ctx.hubVersion || 'dev')}</strong></p>
        <button class="btn btn-ghost btn-sm" data-act="check-hub">Check for hub update</button>
        <p class="field-note">The hub appears in the grid as a card labelled “this app” — updates install like any other app.</p>
      </section>
    </div>

    <footer class="panel-foot">
      <button class="btn btn-ghost" data-act="close-settings">Cancel</button>
      <button class="btn btn-violet" data-act="save-settings">Save</button>
    </footer>
  </aside>`;
}

/** Validation used by both the panel and the tests. */
export function validateRepoRef(value) {
  const v = String(value || '').trim();
  if (!v) return 'Enter a repository as owner/repo.';
  if (!isValidRepoRef(v)) return `“${v}” is not a valid owner/repo reference.`;
  return '';
}
