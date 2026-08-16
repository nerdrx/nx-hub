// Wide stack tiles for the Launch view — one per saved stack, ahead of the app
// tiles, with a lit edge so they never read as "just another app".
//
// Pure string renderer; every bit of state comes from lib/stacks.js.

import { esc } from '../lib/html.js';
import * as icons from './icons.js';

const GATE_TEXT = {
  port: 'port gate',
  delay: 'delay gate',
  'peer-online': 'waits for that hub',
};

function stepMarkup(step, index) {
  const gate = GATE_TEXT[step.health] || 'waits for the bus';
  const base = step.wake
    ? `Wake ${step.name}${step.optional ? ' (optional)' : ''}`
    : `${step.name} — ${gate}${step.peerName ? ` on ${step.peerName}` : ''}${step.optional ? ' (optional)' : ''}`;
  // Pairing changed under this stack: still shown, still runnable, but the run
  // will fail at this step and the tile should say so before it is pressed.
  const title = step.unknownPeer ? `${base} — that hub is not paired any more` : base;
  // A wake step is a machine, not a program: the power glyph replaces the two
  // letters that would otherwise abbreviate an app nobody launched.
  const mono = step.wake
    ? `<span class="st-mono st-mono-wake" style="--h:${Number(step.hue) || 265}" aria-hidden="true">${icons.power}</span>`
    : `<span class="st-mono" style="--h:${Number(step.hue) || 265}">${esc(step.monogram)}</span>`;

  return `<span class="st-step st-${esc(step.state)}${step.optional ? ' st-opt' : ''}${step.peer ? ' st-peered' : ''}${
    step.unknownPeer ? ' st-unpaired' : ''
  }" title="${esc(title)}" data-step="${index}">
      ${mono}
      ${
        step.peer
          ? `<span class="st-link" title="${esc(`runs on ${step.peerName || step.peer}`)}" aria-hidden="true">${icons.link}</span>`
          : ''
      }
      ${step.phase ? `<span class="st-glyph" aria-hidden="true">${esc(step.glyph)}</span>` : ''}
    </span>`;
}

export function renderStackTile(tile, ctx = {}) {
  if (!tile) return '';
  const steps = tile.steps.map(stepMarkup).join('<span class="st-arrow" aria-hidden="true">›</span>');
  const canEdit = ctx.canEdit !== false;
  const status = tile.status || `${tile.steps.length} step${tile.steps.length === 1 ? '' : 's'}`;

  return `
  <div class="tile tile-stack${tile.running ? ' is-running' : ''}${tile.phase ? ` phase-${esc(tile.phase)}` : ''}" data-stack-tile="${esc(tile.id)}">
    <button class="tile-hit stack-hit" data-act="stack-run" data-stack="${esc(tile.id)}"
            ${tile.running ? 'disabled' : ''} title="${esc(tile.running ? `${tile.name} is running` : `Run ${tile.name}`)}">
      <span class="st-top">
        <span class="st-kicker">Stack${
          tile.triggered
            ? `<span class="st-bolt" title="${esc(tile.triggerTitle || 'runs itself')}" aria-hidden="true">${icons.bolt}</span><span class="st-auto" title="${esc(
                tile.triggerTitle || 'runs itself'
              )}">auto</span>`
            : ''
        }</span>
        <span class="tile-name st-name">${esc(tile.name)}</span>
      </span>
      <span class="st-steps">${steps || '<span class="st-empty">no steps yet</span>'}</span>
      <span class="st-status">${esc(status)}</span>
    </button>
    <span class="st-tools">
      ${
        tile.running
          ? `<button class="btn btn-ghost btn-sm st-stop" data-act="stack-stop" data-stack="${esc(tile.id)}">Stop</button>`
          : ''
      }
      ${
        canEdit
          ? `<button class="btn btn-icon st-edit" data-act="stack-edit" data-stack="${esc(tile.id)}" title="Edit ${esc(tile.name)}" aria-label="Edit ${esc(tile.name)}">${icons.sliders}</button>`
          : ''
      }
    </span>
  </div>`;
}

/** The "New stack" ghost tile — same footprint, no fill. */
export function renderStackGhost() {
  return `
  <div class="tile tile-stack tile-ghost">
    <button class="tile-hit stack-hit ghost-hit" data-act="stack-new" title="Build a new stack">
      <span class="st-plus" aria-hidden="true">+</span>
      <span class="tile-name st-name">New stack</span>
      <span class="st-status">Launch several apps in order</span>
    </button>
  </div>`;
}

/**
 * @param {Array} tiles  stackTiles() output
 * @param {{canEdit?:boolean, canCreate?:boolean}} ctx
 */
export function renderStackTiles(tiles, ctx = {}) {
  const list = Array.isArray(tiles) ? tiles : [];
  const ghost = ctx.canCreate === false ? '' : renderStackGhost();
  if (!list.length && !ghost) return '';
  return list.map((t) => renderStackTile(t, ctx)).join('') + ghost;
}
