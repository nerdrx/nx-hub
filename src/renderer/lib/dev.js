// nx dev links — a tile per local checkout, next to the installed apps.
//
// [dev-tools] froze the bridge as a BARE ARRAY:
//   getDevLinks() → [{ appId, name, path, launchCmd, exists, known, appName }]
//   devRun(appId)    → { ok, pid, cmd, source }; toasts on its own, rejects with
//                      a readable message on the error path
//   devUnlink(appId) → { ok, links } — the fresh list, so nothing re-pulls
//
// `exists: false` is a link whose folder is gone: it still renders (that is how
// the user finds out) but it cannot be run, and its menu drops to the two
// actions that still mean something.
// `known: true` means the link shadows an app this hub already has a card for.
//
// A dev link is a PATH the user typed on their own machine, but it still
// reaches the DOM (the tile menu shows it), so nothing here builds markup and
// the views escape everything that leaves these functions.

import { monogram, tileHue } from './launcher.js';

function str(v) {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v);
  return [];
}

/**
 * One entry of dataDir/dev.json.
 *
 * The CLI's `--app <id>` defaults to the folder's basename, so the id is
 * lower-cased here exactly the way app ids are everywhere else — that is what
 * makes "does this app have a dev link?" a plain Set lookup.
 */
export function normalizeDevLink(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const appId = str(d.appId || d.id).trim().toLowerCase();
  const path = str(d.path).trim();
  const appName = str(d.appName).trim();
  const known = !!d.known;
  return {
    appId,
    path,
    launchCmd: str(d.launchCmd || d.cmd).trim(),
    // A link that shadows a catalogue app may borrow that app's real name —
    // seeing "PulseNX" twice with one marked DEV is clearer than seeing the
    // folder's basename next to it.
    name: (known && appName) || str(d.name).trim() || appId,
    appName,
    known,
    // Absent means present: an older main that never checked must not make
    // every link look broken.
    exists: d.exists !== false,
  };
}

/** `getDevLinks()` → a deduped list. Later entries win, ids are the key. */
export function normalizeDevLinks(list) {
  const byId = new Map();
  for (const link of asArray(list).map(normalizeDevLink)) {
    if (link.appId) byId.set(link.appId, link);
  }
  return [...byId.values()];
}

/** The ids that have a checkout behind them, for the card marker. */
export function devIds(links) {
  return new Set(normalizeDevLinks(links).map((l) => l.appId));
}

export function isDevLinked(appId, links) {
  if (!appId) return false;
  const want = String(appId).toLowerCase();
  return normalizeDevLinks(links).some((l) => l.appId === want);
}

/**
 * Launcher tiles for the dev links.
 *
 * They sort last among the app tiles on purpose: a checkout is a tool, not
 * something you reach for by muscle memory, and putting it in the favorites/
 * recents rotation would push installed apps around every time it is used.
 *
 * @param {Array} links getDevLinks() output
 * @param {{filter?:string}} ctx
 */
export function devTiles(links, ctx = {}) {
  const filter = str(ctx.filter).trim().toLowerCase();
  return normalizeDevLinks(links)
    .filter((l) => !filter || l.name.toLowerCase().includes(filter) || l.appId.includes(filter))
    .map((l) => ({
      key: `dev::${l.appId}`,
      dev: true,
      appId: l.appId,
      artifactId: '',
      name: l.name,
      path: l.path,
      launchCmd: l.launchCmd,
      known: l.known,
      // The folder moved or was deleted. The tile stays — vanishing silently is
      // how a user ends up wondering where their link went — but it cannot run.
      broken: !l.exists,
      monogram: monogram(l.name),
      hue: tileHue(l.appId),
      sublabel: '',
      favorite: false,
      disabled: !l.exists,
      disabledReason: l.exists ? '' : 'folder is gone',
      title: !l.exists
        ? `${l.name} — ${l.path || 'its folder'} is not there any more`
        : l.launchCmd
          ? `Run ${l.name} — ${l.launchCmd}`
          : `Run ${l.name} from ${l.path || 'its linked folder'}`,
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'en'));
}

/**
 * Menu entries for a dev tile. `caps.devUnlink === false` (a build without the
 * unlink method) drops the entry rather than offering a button that cannot fire.
 */
export function devTileMenu(tile, caps = {}) {
  if (!tile) return [];
  // A broken link gets no Run: offering it would only produce an error the user
  // can already see on the tile. What is left is looking at where it went, and
  // letting it go.
  const items = tile.broken ? [] : [{ act: 'dev-run', label: 'Run' }];
  if (tile.path) items.push({ act: 'dev-folder', label: 'Open folder' });
  if (caps.devUnlink !== false) items.push({ act: 'dev-unlink', label: 'Unlink', danger: true });
  return items;
}

/** DESIGN §9: destructive actions state the consequence plainly. */
export function devUnlinkConfirm(tile) {
  const t = tile && typeof tile === 'object' ? tile : {};
  const name = t.name || t.appId || 'this link';
  return (
    `Unlink ${name}?\n\n${t.path || ''}\n\n` +
    'Only the hub forgets it — the folder and everything in it stay exactly where they are.'
  ).replace(/\n{3,}/g, '\n\n');
}
