// The modal shell shared by the per-app sheets (options, versions) and the
// devices panel. Pure string renderer, same contract as the other views.

import { esc } from '../lib/html.js';
import * as icons from './icons.js';

/**
 * @param {{title:string, subtitle?:string, body:string, foot?:string,
 *          wide?:boolean, label?:string}} opts
 */
export function renderSheet(opts = {}) {
  const label = opts.label || opts.title || 'Dialog';
  return `
  <div class="sheet-backdrop" data-act="close-sheet"></div>
  <aside class="sheet${opts.wide ? ' sheet-wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(label)}">
    <header class="sheet-head">
      <div class="sheet-titles">
        <h2>${esc(opts.title || '')}</h2>
        ${opts.subtitle ? `<p class="sheet-sub">${esc(opts.subtitle)}</p>` : ''}
      </div>
      <button class="btn btn-icon" data-act="close-sheet" title="Close (Esc)" aria-label="Close">${icons.close}</button>
    </header>
    <div class="sheet-body">${opts.body || ''}</div>
    ${opts.foot ? `<footer class="sheet-foot">${opts.foot}</footer>` : ''}
  </aside>`;
}

/** Inline "loading…" block used while a sheet waits for the bridge. */
export function renderSheetLoading(text = 'Loading…') {
  return `<div class="sheet-loading"><span class="spinner" aria-hidden="true"></span><span>${esc(text)}</span></div>`;
}

export function renderSheetError(message, retry) {
  return `<div class="sheet-error" role="alert">
      <span>${esc(message || 'Something went wrong.')}</span>
      ${retry ? `<button class="btn btn-ghost btn-sm" data-act="${esc(retry.act)}" data-app="${esc(retry.appId || '')}">${esc(retry.label || 'Retry')}</button>` : ''}
    </div>`;
}
