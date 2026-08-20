"use strict";
// NX Hub — fleet: the bus roster that travels between hubs (SPEC v0.10
// "Bus federation").
//
// Each hub pushes what is on ITS connector bus over every fleet session, so a
// status strip can show "PulseNX · 72 bpm — on Workshop PC" without the app
// having to know anything about either machine.
//
// Pure functions only: building a roster out of connector clients, and — the
// half that matters — turning a PEER's roster back into something this hub is
// willing to hold. The session is authenticated, so the sender is a hub the
// user paired; that makes the payload trustworthy about ITS OWN bus and about
// nothing else. It is still parsed as hostile input: it is forwarded straight
// into a renderer and into a stack's health gate, and neither wants a 4MB
// string or a 10,000-entry field map.

/** SPEC's bandwidth cap: at most 20 history points per field on the wire. */
const MAX_ROSTER_HISTORY = 20;
/** A bus caps itself at 64 fields per client (connector/server.js). */
const MAX_ROSTER_FIELDS = 64;
/** More apps than any real hub runs, and a hard ceiling either way. */
const MAX_ROSTER_CLIENTS = 32;
/** App ids are slugs; names/versions are short by construction. */
const MAX_ID_CHARS = 64;
const MAX_TEXT_CHARS = 128;
/**
 * A roster must fit comfortably inside protocol.MAX_MESSAGE (64KB) once it is
 * wrapped in an envelope — the envelope is MAC'd and JSON-escaped, so leave
 * plenty of room rather than discovering the ceiling on a hub with 30 apps.
 */
const MAX_ROSTER_BYTES = 32 * 1024;

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function text(value, max) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return s ? s.slice(0, max) : null;
}

function timestamp(value) {
  if (!isFiniteNumber(value)) return null;
  const n = Math.round(value);
  // Epoch ms, and never a date the far side made up out of thin air. Anything
  // outside a plausible range is simply not a timestamp.
  if (n <= 0 || n > 4102444800000) return null; // > year 2100
  return n;
}

/**
 * One field map: scalars only, capped in count and in length. Objects and
 * arrays are dropped rather than flattened — a status field is a thing you
 * print beside an app's name.
 */
function sanitizeFields(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let kept = 0;
  for (const key of Object.keys(raw)) {
    if (kept >= MAX_ROSTER_FIELDS) break;
    const name = text(key, MAX_ID_CHARS);
    if (!name) continue;
    const value = raw[key];
    if (isFiniteNumber(value)) out[name] = value;
    else if (typeof value === "boolean") out[name] = value;
    else if (typeof value === "string") out[name] = value.slice(0, MAX_TEXT_CHARS);
    else continue;
    kept += 1;
  }
  return out;
}

/** `{field: [{ts, v}, …]}` — numeric samples only, newest 20 per field. */
function sanitizeHistory(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let kept = 0;
  for (const key of Object.keys(raw)) {
    if (kept >= MAX_ROSTER_FIELDS) break;
    const name = text(key, MAX_ID_CHARS);
    if (!name) continue;
    const samples = raw[key];
    if (!Array.isArray(samples) || !samples.length) continue;
    const points = [];
    for (const sample of samples.slice(-MAX_ROSTER_HISTORY)) {
      if (!sample || typeof sample !== "object" || Array.isArray(sample)) continue;
      const ts = timestamp(sample.ts);
      if (ts == null || !isFiniteNumber(sample.v)) continue;
      points.push({ ts, v: sample.v });
    }
    if (!points.length) continue;
    // Time only ever goes forwards on a chart, whatever the sender did.
    points.sort((a, b) => a.ts - b.ts);
    out[name] = points;
    kept += 1;
  }
  return out;
}

/** One entry as this hub is willing to hold it, or null. */
function sanitizeClient(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const app = text(raw.app, MAX_ID_CHARS);
  if (!app) return null;
  const entry = {
    app: app.toLowerCase(),
    version: text(raw.version, MAX_TEXT_CHARS),
    since: timestamp(raw.since),
    fields: sanitizeFields(raw.fields),
    history: sanitizeHistory(raw.history),
  };
  return entry;
}

/** A whole roster, deduplicated by app id and sorted ordinally. */
function sanitizeRoster(raw) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (out.length >= MAX_ROSTER_CLIENTS) break;
    const client = sanitizeClient(entry);
    if (!client || seen.has(client.app)) continue;
    seen.add(client.app);
    out.push(client);
  }
  // Ordinal — the host may run de_DE, so never localeCompare (DESIGN).
  out.sort((a, b) => (a.app < b.app ? -1 : a.app > b.app ? 1 : 0));
  return out;
}

function encodedSize(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch (_) {
    return Infinity;
  }
}

/**
 * `bus-roster {clients:[…]}` from this hub's connector clients.
 *
 * Shrinks rather than refuses: history goes first (it is the decoration), then
 * the tail of the list. A roster that would not fit is still worth sending —
 * "these apps are up over there" is the part the user asked for.
 */
function buildRoster(clients) {
  const list = sanitizeRoster(clients);
  let payload = { type: "bus-roster", clients: list };
  if (encodedSize(payload) <= MAX_ROSTER_BYTES) return payload;

  payload = {
    type: "bus-roster",
    clients: list.map((c) => ({ app: c.app, version: c.version, since: c.since, fields: c.fields, history: {} })),
  };
  while (payload.clients.length > 1 && encodedSize(payload) > MAX_ROSTER_BYTES) {
    payload.clients.pop();
  }
  return payload;
}

/** Whether two rosters would look any different on screen. */
function differs(a, b) {
  try {
    return JSON.stringify(a) !== JSON.stringify(b);
  } catch (_) {
    return true;
  }
}

module.exports = {
  MAX_ROSTER_HISTORY,
  MAX_ROSTER_FIELDS,
  MAX_ROSTER_CLIENTS,
  MAX_ROSTER_BYTES,
  sanitizeFields,
  sanitizeHistory,
  sanitizeClient,
  sanitizeRoster,
  buildRoster,
  differs,
};
