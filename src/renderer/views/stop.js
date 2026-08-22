// v0.11 "stop" — the control that ends a running app.
//
// Ghost, never red. DESIGN §1 reserves `--danger` for genuinely destructive
// actions and cyan for live values; stopping an app you launched a minute ago
// is neither — it is the other half of Launch. A red button sitting beside a
// LIVE strip all day would read as a warning about the app itself.
//
// One click, no confirmation (SPEC: the same rule stacks already follow). What
// the control owes the user instead is honesty while the ladder runs: the hub
// asks politely, waits up to 2.5 seconds and only then signals, so the button
// says "Stopping…" and disables itself for as long as that takes.
//
// Pure string renderer: every name here — an app's, a peer's — is somebody
// else's string and goes through esc() on the way into markup and attributes.

import { esc } from '../lib/html.js';
import { stopKey, isStopping } from '../lib/running.js';
import * as icons from './icons.js';

/** The tooltip and the accessible name — one sentence, and it says WHERE. */
export function stopTitle(appName, peerName, pending) {
  const name = String(appName || '').trim() || 'this app';
  const peer = String(peerName || '').trim();
  if (pending) return peer ? `Stopping ${name} on ${peer}…` : `Stopping ${name}…`;
  return peer ? `Stop ${name} on ${peer}` : `Stop ${name}`;
}

/**
 * @param {{appId:string, appName?:string, artifactId?:string, peerName?:string,
 *          peerId?:string}} target
 * @param {{variant?:'strip'|'tile', pending?:boolean}} opts
 */
export function renderStopControl(target = {}, opts = {}) {
  const appId = String(target.appId || '').trim();
  if (!appId) return '';
  const tile = opts.variant === 'tile';
  const pending = !!opts.pending;
  const peerId = String(target.peerId || '').trim();
  // A peer's build is not ours to name: the artifact id this hub knows means
  // nothing on the other machine, and `stopApp` reaches it through {peer}.
  const artifactId = peerId ? '' : String(target.artifactId || '');
  const title = stopTitle(target.appName, target.peerName, pending);
  const cls = [
    'btn',
    tile ? 'btn-icon' : 'btn-ghost btn-sm',
    'stop-btn',
    tile ? 'tile-stop' : 'stop-strip',
    pending ? 'is-stopping' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return `<button class="${cls}" data-act="stop-app" data-app="${esc(appId)}" data-art="${esc(artifactId)}"${
    peerId ? ` data-peer="${esc(peerId)}"` : ''
  }${pending ? ' disabled aria-busy="true"' : ''} title="${esc(title)}" aria-label="${esc(title)}">${icons.stop}${
    tile ? '' : `<span>${pending ? 'Stopping…' : 'Stop'}</span>`
  }</button>`;
}

/**
 * The control for one strip, from the `stop` bundle the card handed down.
 * Returns '' when there is no bundle — which is how a build without `stopApp`,
 * and a process this hub has no handle on, both end up showing nothing.
 *
 * @param {object|null} stop  lib/running.js stopOptions() output
 * @param {{appId:string, peerName?:string, peerId?:string}} where
 */
export function renderStripStop(stop, where = {}) {
  if (!stop) return '';
  const appId = String(where.appId || '').trim();
  if (!appId) return '';
  const peerId = String(where.peerId || '').trim();
  const artifactId = peerId ? '' : stop.artifactId || '';
  return `<span class="live-stop">${renderStopControl(
    {
      appId,
      appName: stop.appName,
      artifactId,
      peerName: where.peerName,
      peerId,
    },
    { variant: 'strip', pending: isStopping(stop.pending, stopKey(appId, artifactId, peerId)) }
  )}</span>`;
}
