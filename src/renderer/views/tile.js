// Launcher view renderers — big square tiles, one per installed launchable
// artifact. Pure string renderers, same contract as views/card.js.

import { esc } from '../lib/html.js';
import { tileMenu } from '../lib/launcher.js';
import { renderStackTiles } from './stacktile.js';
import * as icons from './icons.js';

/** file:// URL for an icon recorded by the install manifest. */
export function iconSrc(iconPath) {
  const p = String(iconPath || '').trim();
  if (!p) return '';
  if (/^(file|https?):\/\//i.test(p)) return p;
  if (!p.startsWith('/')) return '';
  return `file://${p.split('/').map(encodeURIComponent).join('/')}`;
}

function menuMarkup(tile, open, caps) {
  const items = tileMenu(tile, caps)
    .map(
      (m) =>
        `<button class="menu-item" data-act="${esc(m.act)}" data-app="${esc(tile.appId)}" data-art="${esc(tile.artifactId)}"${m.disabled ? ' disabled' : ''}>${esc(m.label)}</button>`
    )
    .join('');
  return `
    <div class="tile-menu-wrap">
      <button class="btn btn-icon tile-dots" data-act="tile-menu" data-tile="${esc(tile.key)}" aria-haspopup="menu" aria-expanded="${open ? 'true' : 'false'}" title="More actions" tabindex="-1">${icons.dots}</button>
      ${open ? `<div class="menu" role="menu">${items}</div>` : ''}
    </div>`;
}

export function renderTile(tile, ctx = {}) {
  if (!tile) return '';
  const open = ctx.openMenu === tile.key;
  const src = iconSrc(tile.iconPath);
  const art = src
    ? `<img class="tile-icon" src="${esc(src)}" alt="" data-fallback="${esc(tile.monogram)}">`
    : `<span class="tile-mono" style="--h:${Number(tile.hue) || 265}">${esc(tile.monogram)}</span>`;

  return `
  <div class="tile ${tile.disabled ? 'is-disabled' : ''}" data-tile="${esc(tile.key)}"
       data-app="${esc(tile.appId)}" data-art="${esc(tile.artifactId)}" style="--h:${Number(tile.hue) || 265}">
    <button class="tile-hit" data-act="tile-launch" data-app="${esc(tile.appId)}" data-art="${esc(tile.artifactId)}" data-tile="${esc(tile.key)}"
            ${tile.disabled ? 'disabled' : ''} title="${esc(tile.title)}">
      <span class="tile-art" style="--h:${Number(tile.hue) || 265}">${art}</span>
      <span class="tile-name">${esc(tile.name)}</span>
      ${
        tile.live && tile.liveCaption
          ? `<span class="tile-cap">${esc(tile.liveCaption)}</span>`
          : tile.sublabel
            ? `<span class="tile-sub">${esc(tile.sublabel)}</span>`
            : ''
      }
      ${tile.live && tile.liveCaption && tile.sublabel ? `<span class="tile-sub">${esc(tile.sublabel)}</span>` : ''}
      ${tile.disabled ? `<span class="tile-off">${esc(tile.disabledReason || 'unavailable')}</span>` : ''}
    </button>
    ${tile.live ? `<span class="tile-live" title="${esc(tile.liveTitle || 'live on the bus')}" aria-label="live"></span>` : ''}
    ${tile.updateAvailable ? '<span class="tile-dot" title="update available"></span>' : ''}
    ${
      tile.crashLoop
        ? `<span class="tile-crash" title="${esc(
            tile.crashCount
              ? `crashed ${tile.crashCount}× right after launching — see the card`
              : 'crashes right after launching — see the card'
          )}" aria-label="crashing"></span>`
        : ''
    }
    ${tile.favorite ? `<span class="tile-star" title="favorite">${icons.starFilled}</span>` : ''}
    ${menuMarkup(tile, open, ctx.caps)}
  </div>`;
}

/**
 * The Launch view: stack tiles first (wide, lit edge), then the app tiles.
 *
 * @param {Array} tiles  launchTiles() output
 * @param {{stacks?:Array, canEditStacks?:boolean, openMenu?:string, filter?:string, caps?:object}} ctx
 */
export function renderLaunchGrid(tiles, ctx = {}) {
  const list = Array.isArray(tiles) ? tiles : [];
  // Stacks are not filtered — while the user is searching for an app, they only
  // get in the way.
  const stacks = ctx.filter ? [] : Array.isArray(ctx.stacks) ? ctx.stacks : [];
  const showStacks = !ctx.filter && (ctx.canEditStacks !== false || stacks.length);
  // A build whose bridge lacks the stack methods gets neither tiles nor ghost.
  const stackMarkup = showStacks
    ? renderStackTiles(stacks, { canEdit: ctx.canEditStacks !== false, canCreate: ctx.canEditStacks !== false })
    : '';
  if (!list.length && !stacks.length) {
    return `${stackMarkup ? `<div class="tiles-grid">${stackMarkup}</div>` : ''}${renderLaunchEmpty(ctx.filter)}`;
  }
  return `<div class="tiles-grid">${stackMarkup}${list.map((t) => renderTile(t, ctx)).join('')}</div>`;
}

export function renderSkeletonTiles(n = 6) {
  return `<div class="tiles-grid">${new Array(n).fill('<div class="tile"><div class="sk sk-tile"></div></div>').join('')}</div>`;
}

export function renderLaunchEmpty(filter) {
  if (filter) {
    return `<div class="empty">Nothing installed matches “${esc(filter)}”.
      <button class="btn btn-ghost btn-sm" data-act="clear-filter">Clear filter</button></div>`;
  }
  return `<div class="empty empty-launch">
      <p class="empty-title">Nothing installed yet</p>
      <p>Head to Manage, pick an app and install it — it will show up here.</p>
      <button class="btn btn-violet" data-act="view" data-view="manage">Go to Manage</button>
    </div>`;
}
