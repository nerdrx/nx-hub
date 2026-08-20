// The live status strip — cyan presence dot, a LIVE micro-chip and the fields
// an app is streaming over the connector bus.
//
// Bus data is APP-SUPPLIED: every key, value, unit and label goes through esc()
// on its way into the markup. Pure string renderer, same contract as card.js.
//
// v0.10 adds two things to the same strip rather than a second surface:
//
//  * a **sparkline** beside every numeric field, drawn from that field's ring
//    buffer (`client.history[key]`). The tabular value keeps its place — the
//    line is the movement, the number is still the reading.
//  * a **peer microchip** ("on NX-WIN") in violet, for a client another hub
//    relayed. Violet, not cyan, on purpose (DESIGN §1): cyan is this machine's
//    live light, and identity — whose machine it is — is violet's job.

import { esc } from '../lib/html.js';
import { formatFields, captionFor, presenceTitle, historyFor } from '../lib/connector.js';
import { relativeTime } from '../lib/version.js';
import { renderSparkline } from './spark.js';
import { REMOTE_MAX_POINTS } from '../lib/sparkline.js';

/** How many fields a card's strip shows before it stops (cards stay compact). */
export const CARD_FIELD_LIMIT = 6;

function fieldMarkup(field, ctx = {}) {
  if (field.kind === 'bool') {
    return `<span class="live-f live-b ${field.on ? 'is-on' : 'is-off'}" title="${esc(field.title)}">
        <span class="live-g" aria-hidden="true">${field.on ? '●' : '○'}</span>
        <span class="live-k">${esc(field.label)}</span>
      </span>`;
  }
  // Only numbers have a series: SPEC's ring buffer is numeric-only, and a
  // sparkline of a text field would be a line through nothing.
  const spark =
    field.kind === 'number'
      ? renderSparkline(historyFor(ctx.client, field.key), {
          key: field.key,
          label: field.label,
          max: ctx.maxPoints,
        })
      : '';
  return `<span class="live-f${spark ? ' has-spark' : ''}" title="${esc(field.title)}">
      <span class="live-k">${esc(field.label)}</span>
      <span class="live-v${field.kind === 'number' ? ' live-num' : ''}">${esc(field.text)}${
        field.unit ? `<span class="live-u">${esc(field.unit)}</span>` : ''
      }</span>${spark}
    </span>`;
}

/**
 * The violet peer microchip. It carries the peer's NAME, not its id — the name
 * is what the fleet sheet shows and what the user typed at pairing time.
 */
export function renderPeerMark(peerName, peerId = '') {
  const name = String(peerName || '').trim();
  if (!name) return '';
  return `<span class="live-peer" title="${esc(`running on ${name} — relayed by that hub`)}"${
    peerId ? ` data-peer="${esc(peerId)}"` : ''
  }>on ${esc(name)}</span>`;
}

/**
 * @param {object|null} client  a bus client from getState().connector
 * @param {Array} defs          app.connectorFields (absent → generic rendering)
 * @param {{now?:number, limit?:number, peerName?:string, peerId?:string,
 *          maxPoints?:number}} opts
 */
export function renderStatusStrip(client, defs, opts = {}) {
  if (!client) return '';
  const limit = Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : CARD_FIELD_LIMIT;
  const fields = formatFields(client.fields, defs, { limit });
  const peerName = String(opts.peerName || '').trim();
  const title = presenceTitle(client, relativeTime(client.since, opts.now || Date.now()), peerName);
  const ctx = { client, maxPoints: opts.maxPoints };
  return `
    <div class="live${peerName ? ' live-remote' : ''}" data-live="${esc(client.app)}"${
      peerName && opts.peerId ? ` data-live-peer="${esc(opts.peerId)}"` : ''
    } role="status">
      <span class="live-dot" aria-hidden="true"></span>
      <span class="live-chip" title="${esc(title)}">LIVE</span>
      ${renderPeerMark(peerName, opts.peerId)}
      ${
        fields.length
          ? `<span class="live-fields">${fields.map((f) => fieldMarkup(f, ctx)).join('')}</span>`
          : '<span class="live-none">connected — no status yet</span>'
      }
    </div>`;
}

/**
 * The strips for every hub that is seeing this app on ITS bus.
 *
 * @param {{peerId:string, peerName:string, client:object}[]} entries
 *   as lib/connector.js's remoteClientsFor() hands them over
 */
export function renderRemoteStrips(entries, defs, opts = {}) {
  return (Array.isArray(entries) ? entries : [])
    .map((e) =>
      e && e.client
        ? renderStatusStrip(e.client, defs, {
            ...opts,
            peerName: e.peerName,
            peerId: e.peerId,
            // A relayed roster is capped at 20 points per field on the wire —
            // asking for 60 would just be a lie about how much we know.
            maxPoints: REMOTE_MAX_POINTS,
          })
        : ''
    )
    .join('');
}

/**
 * Caption under a launcher tile's name: the first live field, nothing more.
 * (The tile's own renderer draws the dot — it needs the tile's geometry.)
 */
export function tileCaption(client, defs) {
  return captionFor(client, defs);
}
