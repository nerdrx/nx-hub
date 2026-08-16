"use strict";
// NX Hub — fleet: the wire protocol, as pure functions (SPEC v0.6 "Fleet").
//
// Everything in this file is deterministic and dependency-free (node crypto
// only), so the whole security surface — pairing codes, secret derivation,
// message authentication, replay rejection, beacon parsing — is unit-testable
// without opening a single socket.
//
// THREAT MODEL (documented deliberately, SPEC): the fleet channel runs on a
// LAN between two hubs the same person owns. Payloads travel in PLAINTEXT.
// What the protocol guarantees is authenticity and freshness, not secrecy:
//   * only a hub that knows the pairing-derived secret can open a session,
//   * every message is HMAC'd, so nothing can be injected or altered,
//   * sequence numbers are strictly monotonic, so nothing can be replayed.
// An attacker on the wire can therefore READ that "wivrn-nx 0.6.1 is
// installed"; they can never make either hub install, launch or update
// anything.
//
// Pure node: no electron, no fs, no sockets. Do not add any.

const crypto = require("crypto");

/* ------------------------------------------------------------------ */
/* constants (SPEC)                                                    */
/* ------------------------------------------------------------------ */

/** UDP beacon port — broadcast every BEACON_INTERVAL_MS. */
const BEACON_PORT = 9022;
/** WS channel port. */
const FLEET_PORT = 9023;
/** The HTTP resource the fleet WS server answers on. */
const RESOURCE = "/fleet";
/** Beacons carry this marker so a stray datagram is never mistaken for one. */
const BEACON_MAGIC = "fleet-beacon";
const BEACON_INTERVAL_MS = 5000;
/** A peer whose last beacon is older than this is not "online" any more. */
const BEACON_TTL_MS = 15000;
/** A pairing code is valid for two minutes (SPEC). */
const PAIR_WINDOW_MS = 120000;
/**
 * Message cap. Four times the connector's, because one `summary` carries every
 * app on the peer — but still a hard ceiling, so a peer cannot make us
 * allocate.
 */
const MAX_MESSAGE = 64 * 1024;

/* ------------------------------------------------------------------ */
/* identities and codes                                                */
/* ------------------------------------------------------------------ */

/** A hub id: 16 lowercase hex chars, minted once and stored in fleet.json. */
function newId() {
  return crypto.randomBytes(8).toString("hex");
}

function isId(value) {
  return typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
}

/** The server's challenge nonce — 32 hex chars, fresh per connection. */
function newNonce() {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * A pairing code: six digits, uniformly random, leading zeros kept.
 * `crypto.randomInt` is rejection-sampled, so "000000".."999999" are equally
 * likely — a `% 1000000` of random bytes would not be.
 */
function newCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function isCode(value) {
  return typeof value === "string" && /^[0-9]{6}$/.test(value);
}

/**
 * Constant-time string comparison that does not leak length either: both sides
 * are hashed first, which gives timingSafeEqual the equal lengths it demands
 * without an early, length-dependent return.
 */
function constantEquals(a, b) {
  const ha = crypto
    .createHash("sha256")
    .update(String(a == null ? "" : a))
    .digest();
  const hb = crypto
    .createHash("sha256")
    .update(String(b == null ? "" : b))
    .digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** The pairing code check. Same function, named for the call site. */
const codeMatches = constantEquals;

/**
 * secret = sha256(code + initiatorId + responderId) — SPEC.
 *
 * Both hubs compute it from values both of them have (the code the human
 * typed, and the two ids that were exchanged in the clear), so the secret
 * itself never touches the wire. The id order is FIXED: whoever dialled goes
 * first, so both sides derive the same string.
 */
function deriveSecret(code, initiatorId, responderId) {
  return crypto
    .createHash("sha256")
    .update(`${code}${initiatorId}${responderId}`)
    .digest("hex");
}

/* ------------------------------------------------------------------ */
/* message authentication                                              */
/* ------------------------------------------------------------------ */

/** The challenge answer: hmac(secret, nonce + clientId). */
function authMac(secret, nonce, clientId) {
  return crypto
    .createHmac("sha256", String(secret))
    .update(`${nonce}${clientId}`)
    .digest("hex");
}

/** Per-message tag: hmac(secret, "<seq>:<body>"), body being the JSON text. */
function macFor(secret, seq, body) {
  return crypto
    .createHmac("sha256", String(secret))
    .update(`${seq}:${body}`)
    .digest("hex");
}

/** Constant-time HMAC check. A malformed tag is simply wrong, never a throw. */
function verifyMac(secret, seq, body, presented) {
  if (typeof presented !== "string" || !/^[0-9a-f]{64}$/i.test(presented)) return false;
  const want = Buffer.from(macFor(secret, seq, body), "hex");
  const got = Buffer.from(presented, "hex");
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(want, got);
}

/**
 * Wrap one payload for the wire.
 *
 * The envelope carries the payload as a STRING, not as a nested object:
 *   {"seq":7,"mac":"<64 hex>","body":"{\"type\":\"summary\",…}"}
 * The MAC is computed over that exact string, so the receiver verifies the
 * bytes it actually got. Re-serialising a parsed object to check a MAC would
 * make the check depend on key order and number formatting — a classic way to
 * turn an authenticated protocol into an unauthenticated one.
 */
function encodeEnvelope(secret, seq, payload) {
  const body = JSON.stringify(payload);
  return JSON.stringify({ seq, mac: macFor(secret, seq, body), body });
}

/**
 * Unwrap and authenticate one envelope.
 *
 * @param {string} secret
 * @param {string} text     the raw frame payload
 * @param {object} [opts]
 * @param {number} [opts.lastSeq] highest sequence accepted so far on this
 *                                direction of this session
 * @returns {{ok:true, seq:number, payload:object}|{ok:false, reason:string}}
 */
function decodeEnvelope(secret, text, { lastSeq = 0 } = {}) {
  let env;
  try {
    env = JSON.parse(text);
  } catch (_) {
    return { ok: false, reason: "malformed envelope" };
  }
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return { ok: false, reason: "malformed envelope" };
  }
  if (typeof env.body !== "string") return { ok: false, reason: "missing body" };
  const seq = env.seq;
  if (!Number.isSafeInteger(seq) || seq <= 0) return { ok: false, reason: "bad seq" };

  // MAC first: it covers the sequence number too, so a doctored seq shows up
  // here rather than as a confusing replay complaint.
  if (!verifyMac(secret, seq, env.body, env.mac)) return { ok: false, reason: "bad mac" };
  // Only a byte-identical REPLAY of a genuine frame gets this far.
  if (seq <= lastSeq) return { ok: false, reason: "replayed seq" };

  let payload;
  try {
    payload = JSON.parse(env.body);
  } catch (_) {
    return { ok: false, reason: "malformed body" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "malformed body" };
  }
  if (typeof payload.type !== "string" || !payload.type) return { ok: false, reason: "missing type" };
  return { ok: true, seq, payload };
}

/* ------------------------------------------------------------------ */
/* beacon                                                              */
/* ------------------------------------------------------------------ */

/** `{nx:"fleet-beacon", id, name, hubVersion, port}` as a datagram body. */
function beaconMessage({ id, name, hubVersion, port } = {}) {
  return Buffer.from(
    JSON.stringify({
      nx: BEACON_MAGIC,
      id: String(id || ""),
      name: String(name || "").slice(0, 64),
      hubVersion: String(hubVersion || "0.0.0").slice(0, 32),
      port: Number(port) || FLEET_PORT,
    }),
    "utf8"
  );
}

/**
 * Parse a datagram into a beacon, or null.
 *
 * Deliberately strict — this is the one place in the fleet that accepts
 * unauthenticated input from anyone on the LAN, so anything that is not
 * exactly the shape we broadcast is dropped without a word. A beacon carries
 * no authority whatsoever: it can only make a hub TRY to dial an already-paired
 * peer, and that dial still has to pass the HMAC challenge.
 */
function parseBeacon(buf) {
  let msg;
  try {
    const text = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf == null ? "" : buf);
    if (text.length > 1024) return null;
    msg = JSON.parse(text);
  } catch (_) {
    return null;
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  if (msg.nx !== BEACON_MAGIC) return null;
  if (!isId(msg.id)) return null;
  // A real beacon always carries a NUMBER here (beaconMessage guarantees it),
  // so "9023" is somebody else's datagram, not ours. Strict beats lenient on
  // the one unauthenticated input the fleet accepts.
  const port = msg.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return {
    id: msg.id,
    name: typeof msg.name === "string" ? msg.name.slice(0, 64) : "",
    hubVersion: typeof msg.hubVersion === "string" ? msg.hubVersion.slice(0, 32) : "",
    port,
  };
}

/* ------------------------------------------------------------------ */
/* session arbitration                                                 */
/* ------------------------------------------------------------------ */

/**
 * Exactly one TCP session per peer pair, decided without any negotiation:
 * the hub with the LEXICOGRAPHICALLY GREATER id dials, the other one waits.
 *
 * Both hubs run a server and both see each other's beacons, so without a rule
 * they would connect simultaneously and each drop the other's session in a
 * loop. Ids are 16 hex chars minted from 64 random bits — a tie means the same
 * fleet.json was copied to two machines, which is a misconfiguration, and we
 * fall back to "neither dials" rather than to a connect storm.
 */
function shouldDial(localId, peerId) {
  return String(localId) > String(peerId);
}

/* ------------------------------------------------------------------ */
/* summary                                                             */
/* ------------------------------------------------------------------ */

/**
 * The `summary` payload: what this hub HAS, from the discovery model.
 *
 * Only apps that are installed or have an update pending are listed — the
 * remote's view of an app it does not own is worthless, and the cap keeps a
 * summary comfortably inside MAX_MESSAGE on a hub that watches many repos.
 */
function buildSummary(apps, { hubVersion = "0.0.0", name = "", id = "" } = {}) {
  const list = [];
  for (const app of Array.isArray(apps) ? apps : []) {
    if (!app || !app.id) continue;
    const installed = [];
    let updates = 0;
    for (const artifact of app.artifacts || []) {
      if (!artifact) continue;
      if (artifact.installed) {
        installed.push({
          artifactId: artifact.id,
          label: artifact.label || artifact.id,
          version: artifact.installed.version == null ? null : String(artifact.installed.version),
        });
      }
      if (artifact.updateAvailable) updates += 1;
    }
    if (!installed.length && !updates) continue;
    list.push({
      id: app.id,
      name: app.name || app.id,
      latest: (app.latest && app.latest.version) || null,
      installed,
      updates,
    });
  }
  // Ordinal sort — the host may run de_DE, so never localeCompare (DESIGN).
  list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { type: "summary", id: String(id || ""), name: String(name || ""), hubVersion: String(hubVersion), apps: list };
}

/** Stable fingerprint of a summary — what "pushed on state-change" compares. */
function summaryHash(summary) {
  const apps = (summary && summary.apps) || [];
  return crypto.createHash("sha256").update(JSON.stringify(apps)).digest("hex");
}

/** Total pending updates across a summary (what `nx fleet ls` counts). */
function summaryUpdates(summary) {
  return ((summary && summary.apps) || []).reduce((n, a) => n + (Number(a.updates) || 0), 0);
}

/** `::ffff:192.168.1.5` → `192.168.1.5`; everything else unchanged. */
function normalizeHost(address) {
  const addr = String(address || "");
  return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}

module.exports = {
  BEACON_PORT,
  FLEET_PORT,
  RESOURCE,
  BEACON_MAGIC,
  BEACON_INTERVAL_MS,
  BEACON_TTL_MS,
  PAIR_WINDOW_MS,
  MAX_MESSAGE,
  newId,
  isId,
  newNonce,
  newCode,
  isCode,
  constantEquals,
  codeMatches,
  deriveSecret,
  authMac,
  macFor,
  verifyMac,
  encodeEnvelope,
  decodeEnvelope,
  beaconMessage,
  parseBeacon,
  shouldDial,
  buildSummary,
  summaryHash,
  summaryUpdates,
  normalizeHost,
};
