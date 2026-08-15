// Launcher (library) view logic — which tiles exist, what they say, and when
// they are clickable. Pure functions: no DOM, fully unit-testable.

import { isLaunchable, platformLabel } from './actions.js';
import { isHiddenApp } from './prefs.js';
import { captionFor } from './connector.js';

/**
 * Two-letter monogram for the generated tiles.
 * "WiVRn NX" → WN, "QuadForge" → QF, "PulseNX" → PN, "nxtakt" → NX.
 */
export function monogram(name) {
  const clean = String(name || '').trim();
  if (!clean) return '?';
  const words = clean.split(/[\s\-_/]+/).filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  const caps = words[0].match(/[A-Z0-9]/g);
  if (caps && caps.length >= 2) return (caps[0] + caps[1]).toUpperCase();
  return words[0].slice(0, 2).toUpperCase();
}

/**
 * Deterministic hue inside the brand range (cyan 187° … violet 290°) so every
 * generated tile still reads as part of the NX palette.
 */
export function tileHue(seed) {
  const s = String(seed || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 187 + (Math.abs(h) % 104);
}

/**
 * Build the launcher tiles.
 *
 * - only installed + launchable artifacts get a tile
 * - one tile per app when it has a single launchable artifact (no sublabel);
 *   one tile per artifact otherwise, each with a platform sublabel
 * - apk-adb tiles are disabled while no adb device is connected
 * - hidden apps (per-app pref or main's localHidden) never get a tile
 * - an app that is live on the connector bus carries its presence and the
 *   first streamed field as a caption
 *
 * @param {Array} apps normalized apps
 * @param {{adb?:object, platform?:string, prefs?:object, clients?:Map}} ctx
 */
export function launchTiles(apps, ctx = {}) {
  const adb = ctx.adb || { connected: false, devices: [], versions: {} };
  const prefs = ctx.prefs || {};
  const clients = ctx.clients instanceof Map ? ctx.clients : new Map();
  const list = Array.isArray(apps) ? apps : [];
  const tiles = [];

  for (const app of list) {
    if (!app || app.unpublished) continue;
    if (isHiddenApp(app, prefs)) continue;
    const pref = prefs[app.id] || null;
    const runnable = (app.artifacts || []).filter((a) => a && a.installed && isLaunchable(a));
    if (!runnable.length) continue;
    const many = runnable.length > 1;
    const client = clients.get(app.id) || null;
    const caption = client ? captionFor(client, app.connectorFields) : '';

    for (const art of runnable) {
      const needsDevice = art.kind === 'apk-adb';
      const disabled = needsDevice && !adb.connected;
      const installed = art.installed || {};
      tiles.push({
        key: `${app.id}::${art.id}`,
        appId: app.id,
        artifactId: art.id,
        name: app.name,
        artifactLabel: art.label,
        sublabel: many ? platformLabel(art.platform) : '',
        platform: art.platform,
        kind: art.kind,
        iconPath: installed.iconPath || '',
        path: installed.path || '',
        version: installed.version || '',
        monogram: monogram(app.name),
        hue: tileHue(app.id),
        favorite: !!(pref && pref.favorite),
        live: !!client,
        liveCaption: caption,
        liveTitle: client ? `${client.app}${client.version ? ` ${client.version}` : ''} is live on the bus` : '',
        updateAvailable: !!(art.updateAvailable || art.readyToInstall),
        disabled,
        disabledReason: disabled ? 'no device' : '',
        title: disabled
          ? `${app.name} — no headset connected`
          : `Launch ${app.name}${many ? ` (${art.label})` : ''}`,
      });
    }
  }
  return tiles;
}

/**
 * Order for the launcher grid: favorites first, then whatever was launched
 * recently, then everything else — each group alphabetical (English collation,
 * never the host locale).
 *
 * @param {Array} tiles
 * @param {{recents?:Array<string>}} opts recents = tile keys, newest first
 */
export function orderTiles(tiles, opts = {}) {
  const list = (Array.isArray(tiles) ? tiles : []).filter(Boolean);
  const recents = Array.isArray(opts.recents) ? opts.recents : [];

  const byKey = new Map();
  const byApp = new Map();
  recents.forEach((entry, i) => {
    const key = String(entry || '');
    if (!key) return;
    if (!byKey.has(key)) byKey.set(key, i);
    const appId = key.split('::')[0];
    if (appId && !byApp.has(appId)) byApp.set(appId, i);
  });

  const rankOf = (t) => {
    if (byKey.has(t.key)) return byKey.get(t.key);
    if (byApp.has(t.appId)) return byApp.get(t.appId);
    return -1;
  };
  const alpha = (a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), 'en') ||
    String(a.artifactLabel || '').localeCompare(String(b.artifactLabel || ''), 'en') ||
    String(a.key || '').localeCompare(String(b.key || ''), 'en');

  const favorites = list.filter((t) => t.favorite).sort(alpha);
  const rest = list.filter((t) => !t.favorite);
  const recent = rest.filter((t) => rankOf(t) >= 0).sort((a, b) => rankOf(a) - rankOf(b) || alpha(a, b));
  const others = rest.filter((t) => rankOf(t) < 0).sort(alpha);

  return [...favorites, ...recent, ...others];
}

/**
 * Menu entries for one tile (right-click / hover ⋮).
 * `caps.setAppPref === false` (a build without per-app prefs) drops the entries
 * that would need it; an absent caps object means everything is available.
 */
export function tileMenu(tile, caps = {}) {
  if (!tile) return [];
  const prefs = caps.setAppPref !== false;
  const items = [{ act: 'tile-launch', label: 'Launch', disabled: !!tile.disabled }];
  if (prefs) items.push({ act: 'toggle-fav', label: tile.favorite ? 'Remove from favorites' : 'Add to favorites' });
  if (tile.path && tile.platform !== 'android') items.push({ act: 'folder', label: 'Show in folder' });
  if (prefs) {
    items.push({ act: 'app-options', label: 'App options…' });
    items.push({ act: 'hide-app', label: 'Hide from list' });
  }
  items.push({ act: 'manage-jump', label: 'Manage' });
  return items;
}

/** Which view to open on first run when nothing was remembered. */
export function defaultView(tiles) {
  return Array.isArray(tiles) && tiles.length ? 'launch' : 'manage';
}
