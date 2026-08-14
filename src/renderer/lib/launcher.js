// Launcher (library) view logic — which tiles exist, what they say, and when
// they are clickable. Pure functions: no DOM, fully unit-testable.

import { isLaunchable, platformLabel } from './actions.js';

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
 *
 * @param {Array} apps normalized apps
 * @param {{adb?:object, platform?:string}} ctx
 */
export function launchTiles(apps, ctx = {}) {
  const adb = ctx.adb || { connected: false, devices: [], versions: {} };
  const list = Array.isArray(apps) ? apps : [];
  const tiles = [];

  for (const app of list) {
    if (!app || app.unpublished) continue;
    const runnable = (app.artifacts || []).filter((a) => a && a.installed && isLaunchable(a));
    if (!runnable.length) continue;
    const many = runnable.length > 1;

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
        updateAvailable: !!art.updateAvailable,
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

/** Menu entries for one tile (right-click / hover ⋮). */
export function tileMenu(tile) {
  if (!tile) return [];
  const items = [{ act: 'tile-launch', label: 'Launch', disabled: !!tile.disabled }];
  if (tile.path && tile.platform !== 'android') items.push({ act: 'folder', label: 'Show in folder' });
  items.push({ act: 'manage-jump', label: 'Manage' });
  return items;
}

/** Which view to open on first run when nothing was remembered. */
export function defaultView(tiles) {
  return Array.isArray(tiles) && tiles.length ? 'launch' : 'manage';
}
