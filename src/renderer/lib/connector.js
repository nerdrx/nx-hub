// NX Connector — the renderer's view of the rendezvous bus, local and federated.
//
// `getState().connector = { clients: [{app, version, pid, since, lastSeen,
// fields}] }` per SPEC v0.5. EVERYTHING in a client is app-supplied: the app id,
// the field KEYS and the field VALUES all arrive over a socket from another
// process. Nothing here builds markup — the views escape every string that
// leaves these functions — and nothing here trusts a type.
//
// v0.10 [fabric2] widens that in two ways, and both arrive from even further
// away, so the same rule applies twice over:
//
//   * clients gain `history: {field: [{ts, v}, ...]}` for numeric fields — the
//     series behind the sparklines (lib/sparkline.js does the geometry).
//   * the connector gains `remote: [{peerId, peerName, clients: [...]}]` — a
//     roster another HUB relayed over its fleet session. A peer name is a
//     hostname somebody else chose, an app id in there was never validated by
//     this machine, and the whole array may simply be absent in a build whose
//     main process predates federation. Every consumer below degrades to the
//     local-only answer instead of assuming.

import { normalizeHistories, MAX_POINTS, REMOTE_MAX_POINTS } from './sparkline.js';

/** Field kinds an overlay may declare (`app.connectorFields[].kind`). */
export const FIELD_KINDS = ['number', 'text', 'bool'];

/** Longest a single text value may render before it is clipped. */
const TEXT_MAX = 42;

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v);
  return [];
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function normalizeClient(raw, opts = {}) {
  const c = isPlainObject(raw) ? raw : {};
  const pid = Math.round(Number(c.pid));
  return {
    // The bus normalizes ids to lowercase; do it again so a stale client or a
    // hand-rolled non-JS app can never miss its card.
    app: String(c.app || c.appId || '').trim().toLowerCase(),
    version: c.version ? String(c.version) : '',
    pid: Number.isFinite(pid) && pid > 0 ? pid : 0,
    since: c.since || '',
    lastSeen: c.lastSeen || '',
    fields: isPlainObject(c.fields) ? c.fields : {},
    // v0.10 — absent in a pre-federation build, and absent per field for
    // anything non-numeric. `{}` is the shape the views can always index into.
    history: normalizeHistories(c.history, { max: opts.maxPoints || MAX_POINTS }),
  };
}

/** Clients from one source, deduped by app id — latest hello wins, as on the bus. */
function clientList(raw, opts) {
  const byApp = new Map();
  for (const client of asArray(raw).map((c) => normalizeClient(c, opts))) {
    if (client.app) byApp.set(client.app, client);
  }
  return [...byApp.values()];
}

/**
 * One relayed roster: {peerId, peerName, clients}. A roster with no usable peer
 * id is dropped — it could not be attributed to a hub, and an unattributed
 * "somewhere on the fleet" chip is worse than no chip.
 */
export function normalizeRemotePeer(raw) {
  const p = isPlainObject(raw) ? raw : {};
  const peerId = String(p.peerId || p.id || '').trim();
  if (!peerId) return null;
  return {
    peerId,
    // Falls back to the id so the microchip always has something to say; the
    // views escape it either way.
    peerName: String(p.peerName || p.name || '').trim() || peerId,
    clients: clientList(p.clients, { maxPoints: REMOTE_MAX_POINTS }),
  };
}

/**
 * `{ clients: [...], remote: [{peerId, peerName, clients}] }`.
 *
 * `remote` is always an array — a build without federation simply produces an
 * empty one, which is what keeps every remote surface off the screen instead of
 * half-rendered.
 */
export function normalizeConnector(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const byPeer = new Map();
  for (const entry of asArray(source.remote)) {
    const peer = normalizeRemotePeer(entry);
    // Two rosters from one peer: the newer session's wins, same rule as a
    // duplicate hello on the local bus.
    if (peer) byPeer.set(peer.peerId, peer);
  }
  return { clients: clientList(source.clients), remote: [...byPeer.values()] };
}

/* ------------------------------------------------------------- federation */

export function remotePeers(connector) {
  const list = (connector && connector.remote) || [];
  return Array.isArray(list) ? list : [];
}

/**
 * Every hub that is currently seeing `appId` on ITS bus.
 * @returns {{peerId:string, peerName:string, client:object}[]}
 */
export function remoteClientsFor(connector, appId) {
  const id = String(appId || '').trim().toLowerCase();
  if (!id) return [];
  const out = [];
  for (const peer of remotePeers(connector)) {
    const client = (peer.clients || []).find((c) => c.app === id);
    if (client) out.push({ peerId: peer.peerId, peerName: peer.peerName, client });
  }
  return out;
}

/** appId → [{peerId, peerName, client}], built once per render. */
export function remoteByApp(connector) {
  const map = new Map();
  for (const peer of remotePeers(connector)) {
    for (const client of peer.clients || []) {
      if (!client.app) continue;
      const list = map.get(client.app) || [];
      list.push({ peerId: peer.peerId, peerName: peer.peerName, client });
      map.set(client.app, list);
    }
  }
  return map;
}

/** The roster one peer relayed, by peer id. */
export function rosterFor(connector, peerId) {
  const id = String(peerId || '').trim();
  if (!id) return [];
  const peer = remotePeers(connector).find((p) => p.peerId === id);
  return peer ? peer.clients || [] : [];
}

/**
 * Presence anywhere on the fleet. `isPresent()` deliberately stays local-only:
 * a card's own LIVE dot means "running here", and widening it silently would
 * have made every launcher tile claim a process this machine does not have.
 */
export function isPresentAnywhere(connector, appId) {
  return isPresent(connector, appId) || remoteClientsFor(connector, appId).length > 0;
}

export function clientsByApp(connector) {
  const map = new Map();
  for (const c of (connector && connector.clients) || []) map.set(c.app, c);
  return map;
}

export function clientFor(connector, appId) {
  const id = String(appId || '').toLowerCase();
  if (!id) return null;
  return ((connector && connector.clients) || []).find((c) => c.app === id) || null;
}

export function isPresent(connector, appId) {
  return !!clientFor(connector, appId);
}

/** Overlay-declared field descriptors, defensively. */
export function normalizeFieldDefs(defs) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(defs)) {
    const d = isPlainObject(raw) ? raw : {};
    const key = String(d.key || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: d.label ? String(d.label) : key,
      unit: d.unit ? String(d.unit) : '',
      kind: FIELD_KINDS.includes(d.kind) ? d.kind : '',
    });
  }
  return out;
}

/** Locale-independent number rendering — never toLocaleString. */
export function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return formatText(value);
  if (Number.isInteger(n)) return String(n);
  const rounded = Math.round(n * 100) / 100;
  return String(rounded);
}

export function formatText(value) {
  if (value === null || value === undefined) return '—';
  let text;
  if (typeof value === 'object') {
    try {
      text = JSON.stringify(value);
    } catch {
      text = '[object]';
    }
  } else {
    text = String(value);
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '—';
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text;
}

/** How an app-supplied value reads as a boolean when the overlay says "bool". */
export function truthy(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (!s) return false;
    return !['false', 'off', 'no', '0', 'null', 'none'].includes(s);
  }
  return !!value;
}

function pickKind(declared, value) {
  if (FIELD_KINDS.includes(declared)) return declared;
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  return 'text';
}

function makeField(key, value, def) {
  const kind = pickKind(def && def.kind, value);
  const label = (def && def.label) || key;
  if (kind === 'bool') {
    const on = truthy(value);
    return {
      key,
      label,
      kind: 'bool',
      on,
      text: on ? 'yes' : 'no',
      unit: '',
      display: label,
      title: `${label}: ${on ? 'yes' : 'no'}`,
    };
  }
  const unit = (def && def.unit) || '';
  const text = kind === 'number' ? formatNumber(value) : formatText(value);
  return {
    key,
    label,
    kind,
    on: false,
    text,
    unit,
    display: unit ? `${text} ${unit}` : text,
    title: `${label}: ${text}${unit ? ` ${unit}` : ''}`,
  };
}

/**
 * Live fields as display rows: declared fields first (in overlay order, only
 * the ones the client actually sent), then everything else the client sent —
 * those render `key value` generically, exactly as SPEC prescribes.
 *
 * @param {object} fields client-supplied `fields`
 * @param {Array}  defs   `app.connectorFields` (may be absent — derive nothing)
 * @param {{limit?:number}} opts
 */
export function formatFields(fields, defs, opts = {}) {
  const raw = isPlainObject(fields) ? fields : {};
  const limit = Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : 0;
  const declared = normalizeFieldDefs(defs);
  const out = [];
  const seen = new Set();

  const push = (key, def) => {
    if (seen.has(key)) return;
    if (!Object.prototype.hasOwnProperty.call(raw, key)) return;
    seen.add(key);
    out.push(makeField(key, raw[key], def));
  };

  for (const def of declared) push(def.key, def);
  for (const key of Object.keys(raw)) push(key, null);
  return limit > 0 ? out.slice(0, limit) : out;
}

/** One-line caption for a launcher tile: the first field, nothing more. */
export function captionFor(client, defs) {
  if (!client) return '';
  const [first] = formatFields(client.fields, defs, { limit: 1 });
  if (!first) return '';
  if (first.kind === 'bool') return first.on ? first.label : `${first.label} off`;
  return first.display;
}

/** Tooltip for the presence dot / LIVE chip. */
export function presenceTitle(client, relative = '', peerName = '') {
  if (!client) return '';
  const bits = [client.app];
  if (client.version) bits.push(client.version);
  const head = bits.join(' ');
  // "connected" alone would read as "connected here" on a peer's strip.
  const where = peerName ? `connected on ${peerName}` : 'connected';
  return relative ? `${head} · ${where} ${relative}` : `${head} · ${where}`;
}

/** One field's series off a client, `[]` when the hub sent none. */
export function historyFor(client, key) {
  const bag = client && isPlainObject(client.history) ? client.history : null;
  if (!bag || !key) return [];
  const series = bag[key];
  return Array.isArray(series) ? series : [];
}

/** Does this client carry a series for any field at all? */
export function hasHistory(client) {
  return !!(client && isPlainObject(client.history) && Object.keys(client.history).length);
}
