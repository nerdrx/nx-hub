// The live status strip — cyan presence dot, a LIVE micro-chip and the fields
// an app is streaming over the connector bus.
//
// Bus data is APP-SUPPLIED: every key, value, unit and label goes through esc()
// on its way into the markup. Pure string renderer, same contract as card.js.

import { esc } from '../lib/html.js';
import { formatFields, captionFor, presenceTitle } from '../lib/connector.js';
import { relativeTime } from '../lib/version.js';

/** How many fields a card's strip shows before it stops (cards stay compact). */
export const CARD_FIELD_LIMIT = 6;

function fieldMarkup(field) {
  if (field.kind === 'bool') {
    return `<span class="live-f live-b ${field.on ? 'is-on' : 'is-off'}" title="${esc(field.title)}">
        <span class="live-g" aria-hidden="true">${field.on ? '●' : '○'}</span>
        <span class="live-k">${esc(field.label)}</span>
      </span>`;
  }
  return `<span class="live-f" title="${esc(field.title)}">
      <span class="live-k">${esc(field.label)}</span>
      <span class="live-v${field.kind === 'number' ? ' live-num' : ''}">${esc(field.text)}${
        field.unit ? `<span class="live-u">${esc(field.unit)}</span>` : ''
      }</span>
    </span>`;
}

/**
 * @param {object|null} client  a bus client from getState().connector
 * @param {Array} defs          app.connectorFields (absent → generic rendering)
 * @param {{now?:number, limit?:number}} opts
 */
export function renderStatusStrip(client, defs, opts = {}) {
  if (!client) return '';
  const limit = Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : CARD_FIELD_LIMIT;
  const fields = formatFields(client.fields, defs, { limit });
  const title = presenceTitle(client, relativeTime(client.since, opts.now || Date.now()));
  return `
    <div class="live" data-live="${esc(client.app)}" role="status">
      <span class="live-dot" aria-hidden="true"></span>
      <span class="live-chip" title="${esc(title)}">LIVE</span>
      ${
        fields.length
          ? `<span class="live-fields">${fields.map(fieldMarkup).join('')}</span>`
          : '<span class="live-none">connected — no status yet</span>'
      }
    </div>`;
}

/**
 * Caption under a launcher tile's name: the first live field, nothing more.
 * (The tile's own renderer draws the dot — it needs the tile's geometry.)
 */
export function tileCaption(client, defs) {
  return captionFor(client, defs);
}
