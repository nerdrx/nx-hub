// NX Fleet — the renderer's model of the OTHER hubs on the LAN.
//
// SPEC v0.6 freezes the bridge as
//   getFleet() → { peers:[{ id, name, host, online, lastSeen,
//                           summary:{ apps:[{ id, name, installed, updates }] } }] }
//   fleetShowCode() → { code, expiresAt } · fleetPair(host, code) · fleetUnpair(id)
//   fleetInstall(peerId, appId, artifactId) · fleetLaunch(…) · fleetUpdateAll(peerId)
//   events: fleet-changed · fleet-pair-code {code, expiresAt} · fleet-progress {peerId, …}
//
// EVERYTHING in a peer is network input: the peer's name, its hostname, the app
// ids and app names inside its summary all arrive over a LAN socket from another
// machine. Nothing here builds markup (the views escape every string that leaves
// these functions) and nothing here trusts a type.

/** How long a pairing code stays valid when the bridge does not say (SPEC: 120s). */
export const PAIR_WINDOW_MS = 120000;

/** A pairing code is exactly six digits. */
export const CODE_LENGTH = 6;

/** A fleet job row disappears if the peer stops reporting on it. */
export const JOB_STALE_MS = 45000;

function str(v) {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v);
  return [];
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function count(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * `installed` on a peer's app summary is "installed versions" — a peer may send
 * one string, a list, or a map of artifactId → version. All three become a list.
 */
export function installedVersions(raw) {
  const out = [];
  const push = (v) => {
    const text = str(v).trim();
    if (text && !out.includes(text)) out.push(text);
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) push(isPlainObject(entry) ? entry.version || entry.installed : entry);
  } else if (isPlainObject(raw)) {
    for (const entry of Object.values(raw)) push(isPlainObject(entry) ? entry.version : entry);
  } else {
    push(raw);
  }
  return out;
}

export function normalizePeerApp(raw) {
  const a = isPlainObject(raw) ? raw : {};
  const id = str(a.id || a.appId).trim().toLowerCase();
  const versions = installedVersions(a.installed);
  return {
    id,
    name: str(a.name).trim() || id,
    versions,
    installed: versions.join(' · '),
    updates: count(a.updates),
  };
}

export function normalizePeer(raw) {
  const p = isPlainObject(raw) ? raw : {};
  const summary = isPlainObject(p.summary) ? p.summary : {};
  const apps = asArray(summary.apps)
    .map(normalizePeerApp)
    .filter((a) => a.id);
  return {
    id: str(p.id).trim(),
    name: str(p.name).trim() || str(p.host).trim() || 'Unnamed hub',
    host: str(p.host).trim(),
    online: !!p.online,
    lastSeen: p.lastSeen || '',
    hubVersion: str(p.hubVersion),
    // v0.7 — main resolves the peer's MAC from the ARP table on every session
    // and persists it. Absent is the normal state for a hub that has never
    // connected from this side, and it simply means "no wake button".
    mac: str(p.mac).trim(),
    summary: { apps },
  };
}

/** `getFleet()` → `{ peers }`, deduped by id (a beacon can repeat). */
export function normalizeFleet(raw) {
  const source = isPlainObject(raw) ? raw : Array.isArray(raw) ? { peers: raw } : {};
  const byId = new Map();
  for (const peer of asArray(source.peers).map(normalizePeer)) {
    if (peer.id) byId.set(peer.id, peer);
  }
  return { peers: [...byId.values()] };
}

/** Headline numbers for the header chip and the sheet subtitle. */
export function fleetCounts(peers) {
  const list = asArray(peers);
  let online = 0;
  let updates = 0;
  for (const peer of list) {
    if (peer && peer.online) online += 1;
    for (const app of (peer && peer.summary && peer.summary.apps) || []) updates += count(app.updates);
  }
  return { peers: list.length, online, updates };
}

export function peerById(peers, id) {
  const want = str(id);
  if (!want) return null;
  return asArray(peers).find((p) => p && p.id === want) || null;
}

/* ------------------------------------------------------- the matching table */

/**
 * Match a peer's app summary against the LOCAL catalogue.
 *
 * SPEC's summary carries no artifact list, but `fleetInstall(peerId, appId,
 * artifactId)` wants one — so the artifact choices come from this hub's own
 * discovery model for the same app id. An app this hub has never heard of still
 * gets a row (and can still be told to install with an empty artifactId; the
 * remote resolves it exactly as `nx stack run` does).
 *
 * @param {object} peer normalized peer
 * @param {{apps?:Array, platform?:string}} ctx
 */
export function peerAppTable(peer, ctx = {}) {
  const local = new Map();
  for (const app of asArray(ctx.apps)) {
    if (app && app.id) local.set(String(app.id).toLowerCase(), app);
  }
  return ((peer && peer.summary && peer.summary.apps) || []).map((row) => {
    const app = local.get(row.id) || null;
    const artifacts = ((app && app.artifacts) || [])
      .filter((a) => a && a.id && a.platform !== 'android')
      .map((a) => ({ id: a.id, label: a.label || a.id, platform: a.platform || '' }));
    return {
      id: row.id,
      // The peer's own name for the app wins; the local catalogue is the fallback
      // so an app the peer named badly still reads sensibly here.
      name: row.name || (app && app.name) || row.id,
      localName: (app && app.name) || '',
      known: !!app,
      installed: row.installed,
      versions: row.versions,
      updates: row.updates,
      artifacts,
      canInstall: true,
      canLaunch: !!row.versions.length,
    };
  });
}

/** Buttons for one row of the matching table. */
export function peerAppActions(row) {
  const r = isPlainObject(row) ? row : {};
  const installed = !!(r.versions && r.versions.length);
  const out = [
    {
      act: 'fleet-install',
      label: r.updates > 0 ? 'Update' : installed ? 'Reinstall' : 'Install',
      variant: r.updates > 0 ? 'violet' : 'ghost',
      title: r.updates > 0 ? `${r.updates} update${r.updates === 1 ? '' : 's'} waiting on that hub` : '',
    },
  ];
  out.push({
    act: 'fleet-launch',
    label: 'Launch',
    variant: 'ghost',
    disabled: !installed,
    title: installed ? '' : 'not installed on that hub',
  });
  return out;
}

/**
 * Can this peer be woken from here?
 *
 * Both halves matter: no stored MAC means there is nothing to address the magic
 * packet to, and a hub that is already answering has nothing to wake up.
 */
export function canWake(peer) {
  return !!(peer && peer.mac && !peer.online);
}

/** The Wake button's tooltip — it names the address the packet goes to. */
export function wakeTitle(peer) {
  if (!peer || !peer.mac) return '';
  return `Send a wake-on-LAN packet to ${peer.mac}`;
}

/** "seen 3 min ago" / "" while online. */
export function peerSince(peer) {
  if (!peer || !peer.lastSeen) return '';
  const raw = peer.lastSeen;
  if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw).toISOString();
  return str(raw);
}

/* --------------------------------------------------- v0.10 settings sync */

/**
 * SPEC v0.10 [fabric2]: `fleetSync` defaults to TRUE — absent means on. Only
 * an explicit `false` turns it off, which is why every check below is
 * `!== false` and not a truthiness test.
 */
export function fleetSyncEnabled(settings) {
  return !settings || settings.fleetSync !== false;
}

/**
 * Does this peer share preferences with us right now?
 *
 * Sync is ambient — it happens over a live session, so an offline peer is not
 * syncing anything at this moment even though it will again when it comes back.
 * Saying "syncs with this hub" under an offline peer would be a promise the
 * fleet cannot keep while it is dark.
 */
export function peerSyncs(peer, settings) {
  return fleetSyncEnabled(settings) && !!(peer && peer.online);
}

/**
 * The note itself. Deliberately one quiet line and nothing else: SPEC says
 * "nothing louder (sync is ambient)", so there is no toggle here, no count, no
 * last-synced clock — the Settings panel owns the switch.
 */
export function syncNote(peer, settings) {
  return peerSyncs(peer, settings) ? 'preferences sync with this hub' : '';
}

/** Peers currently in the sync circle — used for the sheet's own subtitle. */
export function syncingPeers(peers, settings) {
  if (!fleetSyncEnabled(settings)) return [];
  return (Array.isArray(peers) ? peers : []).filter((p) => p && p.online);
}

/* ------------------------------------------------------- pairing state machine */

export const PAIR_MODES = ['idle', 'show', 'enter'];

export function blankPairState() {
  return { mode: 'idle', code: '', expiresAt: 0, host: '', input: '', busy: false, error: '', ok: '' };
}

function withState(state, patch) {
  const base = isPlainObject(state) ? state : blankPairState();
  return { ...blankPairState(), ...base, ...patch };
}

/** "Show pairing code" pressed — arm the window, wait for the code. */
export function pairShowStart(state) {
  return withState(state, { mode: 'show', busy: true, error: '', ok: '', code: '', expiresAt: 0 });
}

/** A code arrived, from fleetShowCode() or the `fleet-pair-code` event. */
export function pairCodeArrived(state, payload, now = Date.now()) {
  const p = isPlainObject(payload) ? payload : {};
  const code = normalizeCode(p.code);
  if (!code) return withState(state, { busy: false, error: 'That hub did not return a pairing code.' });
  const expires = Number(p.expiresAt);
  return withState(state, {
    mode: 'show',
    busy: false,
    error: '',
    code,
    expiresAt: Number.isFinite(expires) && expires > 0 ? expires : now + PAIR_WINDOW_MS,
  });
}

/** "Pair with hub…" pressed. */
export function pairEnterStart(state) {
  return withState(state, { mode: 'enter', busy: false, error: '', ok: '', code: '', expiresAt: 0 });
}

export function pairSubmitStart(state, host, input) {
  return withState(state, { mode: 'enter', busy: true, error: '', ok: '', host: str(host), input: str(input) });
}

/** Fold whatever fleetPair() answered. `null` = the call itself failed. */
export function pairResult(state, res, ctx = {}) {
  const host = (isPlainObject(state) && state.host) || ctx.host || '';
  if (res === null || res === undefined) {
    return withState(state, { busy: false, error: `Could not reach ${host || 'that hub'} — is it on the same network?` });
  }
  if (res === false || (isPlainObject(res) && res.ok === false)) {
    const message = (isPlainObject(res) && str(res.error || res.message)) || '';
    return withState(state, {
      busy: false,
      error: message || 'That code did not match — ask the other hub to show a fresh one.',
    });
  }
  const name = (isPlainObject(res) && isPlainObject(res.peer) && str(res.peer.name)) || host;
  return { ...blankPairState(), ok: `Paired with ${name || 'the other hub'}.` };
}

export function pairCancel() {
  return blankPairState();
}

/** Six digits, punctuation and spaces forgiven ("123 456" and "123-456" pass). */
export function normalizeCode(raw) {
  const digits = str(raw).replace(/[^0-9]/g, '');
  return digits.length === CODE_LENGTH ? digits : '';
}

/** Validation for the "Pair with hub…" form. Errors are per field. */
export function validatePairForm(host, code) {
  const errors = {};
  const h = str(host).trim();
  if (!h) errors.host = 'Enter the other hub’s address, e.g. 192.168.1.50.';
  else if (/\s/.test(h) || !/^[A-Za-z0-9._:[\]-]+$/.test(h)) errors.host = `“${h}” is not a valid address.`;
  else {
    const idx = h.lastIndexOf(':');
    if (idx > 0 && !h.startsWith('[') && !h.slice(idx + 1).includes(':')) {
      const port = h.slice(idx + 1);
      if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
        errors.host = `“${port}” is not a valid port.`;
      }
    }
  }
  const digits = str(code).replace(/[^0-9]/g, '');
  if (!digits) errors.code = 'Enter the six digits the other hub is showing.';
  else if (digits.length !== CODE_LENGTH) errors.code = `A pairing code has ${CODE_LENGTH} digits.`;
  return { ok: !Object.keys(errors).length, errors, host: h, code: digits };
}

export function codeMsLeft(expiresAt, now = Date.now()) {
  const at = Number(expiresAt);
  if (!Number.isFinite(at) || at <= 0) return 0;
  return Math.max(0, at - now);
}

/** "1:58" — locale-independent, always m:ss. */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(Number(ms) / 1000) || 0);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

export function isCodeLive(state, now = Date.now()) {
  return !!(state && state.code && codeMsLeft(state.expiresAt, now) > 0);
}

/** The code split into two groups of three, for the big mono display. */
export function codeGroups(code) {
  const digits = str(code).replace(/[^0-9]/g, '');
  if (!digits) return [];
  return [digits.slice(0, 3), digits.slice(3, 6)].filter(Boolean);
}

/* --------------------------------------------------------- fleet progress */

function jobKey(ev) {
  return `${str(ev.jobId) || `${str(ev.appId)}::${str(ev.artifactId)}`}`;
}

/**
 * Fold one `fleet-progress` event into the per-peer job map.
 *
 * The event carries the job-progress fields plus `peerId`. A terminal event
 * (phase "done"/"error", or an explicit done/error flag) drops the row.
 *
 * @param {object} jobs  { [peerId]: { [key]: job } }
 * @param {object} ev
 * @returns {object} a NEW map (never mutated in place)
 */
export function foldFleetProgress(jobs, ev, now = Date.now()) {
  const base = isPlainObject(jobs) ? jobs : {};
  if (!isPlainObject(ev)) return base;
  const peerId = str(ev.peerId);
  if (!peerId) return base;
  const key = jobKey(ev);
  if (!key) return base;

  const forPeer = { ...(isPlainObject(base[peerId]) ? base[peerId] : {}) };
  const phase = str(ev.phase);
  const terminal = phase === 'done' || phase === 'error' || ev.done === true || !!ev.error;
  if (terminal) {
    delete forPeer[key];
  } else {
    const pct = Number(ev.pct);
    forPeer[key] = {
      key,
      peerId,
      jobId: str(ev.jobId),
      appId: str(ev.appId),
      artifactId: str(ev.artifactId),
      phase: phase || 'download',
      pct: Number.isFinite(pct) ? pct : -1,
      message: str(ev.message),
      at: now,
    };
  }
  const next = { ...base };
  if (Object.keys(forPeer).length) next[peerId] = forPeer;
  else delete next[peerId];
  return next;
}

/** Drop rows no peer has spoken about for a while (a hub can vanish mid-job). */
export function pruneFleetJobs(jobs, now = Date.now(), maxAgeMs = JOB_STALE_MS) {
  const base = isPlainObject(jobs) ? jobs : {};
  const next = {};
  for (const [peerId, rows] of Object.entries(base)) {
    const kept = {};
    for (const [key, job] of Object.entries(isPlainObject(rows) ? rows : {})) {
      if (job && now - Number(job.at || 0) < maxAgeMs) kept[key] = job;
    }
    if (Object.keys(kept).length) next[peerId] = kept;
  }
  return next;
}

export function peerJobs(jobs, peerId) {
  const rows = isPlainObject(jobs) ? jobs[str(peerId)] : null;
  return isPlainObject(rows) ? Object.values(rows) : [];
}

/** One line for a fleet job row: "PulseNX · Downloading 43%". */
export function fleetJobLabel(job, ctx = {}) {
  if (!job) return '';
  const names = ctx.names instanceof Map ? ctx.names : new Map();
  return names.get(String(job.appId).toLowerCase()) || job.appId || 'a job';
}
