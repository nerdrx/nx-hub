// Version-history model: normalizing getReleases() output and deciding what the
// per-artifact button in each release row should say and do.
//
// SPEC v0.2: getReleases(appId) → [{tag, version, notes, publishedAt,
// prerelease, assets}] — `assets` is optional here; the UI never depends on it.

import { compareVersions, stripTag } from './version.js';

function str(v) {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

export function normalizeRelease(release) {
  const r = release && typeof release === 'object' ? release : {};
  const tag = str(r.tag || r.name || r.tag_name);
  return {
    tag,
    version: str(r.version) || stripTag(tag),
    notes: str(r.notes || r.body),
    publishedAt: str(r.publishedAt || r.published_at),
    prerelease: !!r.prerelease,
    assets: Array.isArray(r.assets)
      ? r.assets.filter(Boolean).map((a) =>
          typeof a === 'string'
            ? { name: a, size: 0 }
            : { name: str(a.name || a.assetName), size: Number(a.size) || 0 }
        )
      : [],
  };
}

/**
 * Newest first. Sorts by version when both parse, falling back to publishedAt so
 * odd tag schemes still land in a sensible order.
 */
export function normalizeReleases(list) {
  const arr = Array.isArray(list) ? list : [];
  const out = arr.filter(Boolean).map(normalizeRelease).filter((r) => r.tag || r.version);
  return out.sort((a, b) => {
    const cmp = compareVersions(b.version, a.version);
    if (cmp !== 0) return cmp;
    const ta = Date.parse(a.publishedAt) || 0;
    const tb = Date.parse(b.publishedAt) || 0;
    return tb - ta;
  });
}

/** Releases the user is allowed to see, given the per-app prerelease pref. */
export function visibleReleases(releases, includePrereleases) {
  const list = Array.isArray(releases) ? releases : [];
  return includePrereleases ? list : list.filter((r) => !r.prerelease);
}

/** True when installing `target` would move the artifact backwards. */
export function isDowngrade(targetVersion, installedVersion) {
  const target = str(targetVersion).trim();
  const installed = str(installedVersion).trim();
  if (!target || !installed) return false;
  return compareVersions(target, installed) < 0;
}

export function sameVersion(a, b) {
  const x = str(a).trim();
  const y = str(b).trim();
  if (!x || !y) return false;
  return compareVersions(x, y) === 0;
}

/**
 * The button for one (release, artifact) pair.
 * @returns {{act:string, label:string, variant:string, kind:string, disabled:boolean, title:string}}
 */
export function releaseArtifactAction(release, artifact, ctx = {}) {
  const version = (release && release.version) || '';
  const installedVersion = (artifact && artifact.installed && artifact.installed.version) || '';
  const many = !!ctx.many;
  const suffix = many && artifact && artifact.label ? ` — ${artifact.label}` : '';
  const busy = !!ctx.busy;

  if (sameVersion(version, installedVersion)) {
    return {
      act: 'install-version',
      label: `Reinstall${suffix}`,
      variant: 'ghost',
      kind: 'current',
      disabled: busy,
      title: busy ? 'a job is already running for this app' : 'this version is installed',
    };
  }
  if (isDowngrade(version, installedVersion)) {
    return {
      act: 'install-version',
      label: `Downgrade${suffix}`,
      variant: 'ghost',
      kind: 'downgrade',
      disabled: busy,
      title: busy
        ? 'a job is already running for this app'
        : `replaces ${installedVersion} with the older ${version}`,
    };
  }
  return {
    act: 'install-version',
    label: many ? `Install${suffix}` : 'Install this version',
    variant: installedVersion ? 'outline' : 'violet',
    kind: installedVersion ? 'upgrade' : 'install',
    disabled: busy,
    title: busy ? 'a job is already running for this app' : '',
  };
}

/**
 * Which artifacts can be targeted by installVersion for a given release.
 *
 * Old releases are not re-classified by the renderer — the artifact list of the
 * app is the menu, minus the ones this host cannot install (windows on linux)
 * and minus artifacts that never install anything (generic-zip stays, it just
 * downloads). Main decides the truth; the UI only avoids obvious dead buttons.
 */
export function releaseTargets(app, ctx = {}) {
  const platform = ctx.platform || 'linux';
  const arts = (app && app.artifacts) || [];
  return arts.filter((a) => a && (a.platform !== 'windows' || platform === 'win32'));
}

/** Rollback entries for a card/sheet: installed artifacts that kept a `.prev`. */
export function rollbackTargets(app) {
  const arts = (app && app.artifacts) || [];
  return arts
    .filter((a) => a && a.installed && a.rollbackAvailable && a.prevVersion)
    .map((a) => ({
      artifactId: a.id,
      label: a.label,
      prevVersion: a.prevVersion,
      currentVersion: (a.installed && a.installed.version) || '',
    }));
}

/** Artifacts with a downloaded-but-not-applied update. */
export function readyTargets(app) {
  const arts = (app && app.artifacts) || [];
  return arts.filter((a) => a && a.readyToInstall);
}

/** Text for the confirm() shown before a downgrade. */
export function downgradeConfirmText(app, artifact, version) {
  const name = (app && app.name) || (app && app.id) || 'this app';
  const label = (artifact && artifact.label) || 'artifact';
  const cur = (artifact && artifact.installed && artifact.installed.version) || 'the installed version';
  return `Downgrade ${name} — ${label}?\n\n${cur} → ${version}\n\nThe current install is replaced. Settings and data are untouched.`;
}

/** Text for the confirm() shown before a rollback. */
export function rollbackConfirmText(app, target) {
  const name = (app && app.name) || (app && app.id) || 'this app';
  const label = (target && target.label) || 'artifact';
  const prev = (target && target.prevVersion) || 'the previous version';
  const cur = (target && target.currentVersion) || 'the current version';
  return `Roll back ${name} — ${label}?\n\n${cur} → ${prev}\n\nThe kept previous install is restored.`;
}
