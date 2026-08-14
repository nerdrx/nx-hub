// Version-history sheet: every release of one app, with per-artifact
// "install this version" buttons and the rollback entry point.
//
// The history always lists *all* releases the bridge returned — the
// includePrereleases pref governs update detection, not what the user may see.

import { esc } from '../lib/html.js';
import { renderMarkdown } from '../lib/markdown.js';
import { formatDate, relativeTime } from '../lib/version.js';
import { releaseArtifactAction, releaseTargets, rollbackTargets, sameVersion } from '../lib/releases.js';
import { renderSheet, renderSheetLoading, renderSheetError } from './sheet.js';
import * as icons from './icons.js';

function has(coll, key) {
  if (!coll) return false;
  if (typeof coll.has === 'function') return coll.has(key);
  if (Array.isArray(coll)) return coll.includes(key);
  return !!coll[key];
}

function actionButton(action, appId, artifactId, tag) {
  return `<button class="btn btn-${esc(action.variant)} btn-sm act-${esc(action.kind)}"
    data-act="${esc(action.act)}" data-app="${esc(appId)}" data-art="${esc(artifactId)}" data-tag="${esc(tag)}"
    ${action.disabled ? 'disabled' : ''}${action.title ? ` title="${esc(action.title)}"` : ''}>${esc(action.label)}</button>`;
}

export function renderRollbackBlock(app, ctx = {}) {
  const targets = rollbackTargets(app);
  if (!targets.length || ctx.caps === false) return '';
  return `
    <section class="rollback">
      <h3>${icons.rollback}<span>Roll back</span></h3>
      ${targets
        .map(
          (t) => `<div class="rollback-row">
            <span class="rollback-label">${esc(t.label)}</span>
            <span class="rollback-ver">${esc(t.currentVersion)} → ${esc(t.prevVersion)}</span>
            <button class="btn btn-ghost btn-sm" data-act="rollback" data-app="${esc(app.id)}" data-art="${esc(t.artifactId)}">Roll back to ${esc(t.prevVersion)}</button>
          </div>`
        )
        .join('')}
      <p class="field-note">The previous install is kept on disk one level deep, so this is instant.</p>
    </section>`;
}

export function renderReleaseRow(app, release, ctx = {}) {
  const targets = releaseTargets(app, ctx);
  const many = targets.length > 1;
  const open = has(ctx.expanded, release.tag);
  const installedHere = (app.artifacts || []).some(
    (a) => a.installed && sameVersion(a.installed.version, release.version)
  );
  const isLatest = !!(app.latest && sameVersion(app.latest.version, release.version));

  return `
    <article class="rel${installedHere ? ' rel-installed' : ''}" data-rel="${esc(release.tag)}">
      <div class="rel-head">
        <span class="rel-tag">${esc(release.tag || release.version)}</span>
        ${release.publishedAt ? `<span class="rel-date" title="${esc(formatDate(release.publishedAt))}">${esc(relativeTime(release.publishedAt, ctx.now))}</span>` : ''}
        ${release.prerelease ? '<span class="tag-pre">pre-release</span>' : ''}
        ${isLatest ? '<span class="badge badge-latest">latest</span>' : ''}
        ${installedHere ? '<span class="badge badge-installed">installed</span>' : ''}
      </div>
      ${
        release.notes
          ? `<button class="notes-toggle${open ? ' open' : ''}" data-act="rel-notes" data-tag="${esc(release.tag)}" aria-expanded="${open ? 'true' : 'false'}">
               ${icons.chevron}<span>Release notes</span>
             </button>
             ${open ? `<div class="notes markdown">${renderMarkdown(release.notes)}</div>` : ''}`
          : '<p class="rel-nonotes">No release notes.</p>'
      }
      <div class="rel-acts">
        ${
          targets.length
            ? targets
                .map((art) =>
                  actionButton(
                    releaseArtifactAction(release, art, { many, busy: !!ctx.busy }),
                    app.id,
                    art.id,
                    release.tag
                  )
                )
                .join('')
            : '<span class="muted">Nothing installable from this host.</span>'
        }
      </div>
    </article>`;
}

/**
 * @param {object} app  normalized app
 * @param {object} data { loading, error, releases }
 * @param {object} ctx  { expanded, platform, busy, now, caps }
 */
export function renderVersionsSheet(app, data = {}, ctx = {}) {
  const releases = Array.isArray(data.releases) ? data.releases : [];
  let body;
  if (data.loading) {
    body = renderSheetLoading('Reading the release history…');
  } else if (data.error) {
    body = renderSheetError(data.error, { act: 'versions', appId: app.id, label: 'Try again' });
  } else if (!releases.length) {
    body = '<p class="sheet-empty">No releases found for this repository.</p>';
  } else {
    body =
      renderRollbackBlock(app, ctx) +
      `<div class="rel-list">${releases.map((r) => renderReleaseRow(app, r, ctx)).join('')}</div>`;
  }

  return renderSheet({
    title: app.name,
    subtitle: 'Version history',
    label: `${app.name} version history`,
    wide: true,
    body,
  });
}
