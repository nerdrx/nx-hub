"use strict";
// NX Hub — fleet: resolving a peer's MAC address (SPEC v0.7 "WOL + peer MAC").
//
// Wake-on-LAN needs a hardware address, and a hardware address is exactly the
// thing a hub cannot ask a sleeping machine for. So we take it while the peer
// is AWAKE: the moment a fleet session's TCP socket is up, the kernel has
// necessarily just exchanged packets with that IP, which means the local ARP
// cache holds an entry for it. We read that cache — no ping, no raw socket, no
// privilege — and remember the answer in fleet.json.
//
// Two cache formats, one per platform:
//
//   linux   /proc/net/arp, a fixed-column text file. `Flags` 0x0 means the
//           entry is INCOMPLETE (the kernel asked and is still waiting), and
//           the HW address column is then all zeroes — that is a "not yet",
//           not a "never", so the caller retries.
//   win32   `arp -a`, whose columns are localised but whose SHAPE is not: an
//           IPv4 address followed by six hex pairs. We parse on shape alone,
//           so a German or Japanese Windows works without a table of headings.
//
// Everything here is a pure function over text except `lookup`, which is the
// one place that touches the filesystem or spawns a process — and both of
// those are injectable, so the parsers are tested against fixture text on any
// platform.

const PROC_NET_ARP = "/proc/net/arp";

/** ff:ff:ff:ff:ff:ff and 00:00:00:00:00:00 are never a real peer. */
const NULL_MAC = "00:00:00:00:00:00";
const BROADCAST_MAC = "ff:ff:ff:ff:ff:ff";

/**
 * Canonical form: six lowercase hex pairs joined by colons.
 * Accepts `aa-bb-cc-dd-ee-ff`, `AA:BB:…`, `aabb.ccdd.eeff` and bare hex.
 * Returns null for anything else, and for the two useless well-known values.
 */
function normalizeMac(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return null;
  const hex = raw.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (hex.length !== 12) return null;
  const mac = hex.match(/.{2}/g).join(":");
  if (mac === NULL_MAC || mac === BROADCAST_MAC) return null;
  return mac;
}

function isMac(value) {
  return typeof value === "string" && /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(value);
}

/** Loopback and the unspecified address never have an ARP entry worth having. */
function isLocalAddress(ip) {
  const addr = String(ip || "").trim();
  if (!addr) return true;
  if (addr === "::1" || addr === "::" || addr === "0.0.0.0") return true;
  return /^127\./.test(addr);
}

/**
 * Parse `/proc/net/arp`.
 *
 * @param {string} text  the whole file
 * @param {string} [ip]  when given, only that IP's entry is returned
 * @returns {string|null|Array} a mac, null, or (without `ip`) every entry
 */
function parseProcNetArp(text, ip) {
  const rows = [];
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    // IP · HW type · Flags · HW address · Mask · Device
    if (parts.length < 4) continue;
    const address = parts[0];
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) continue; // skips the header
    const flags = parseInt(parts[2], 16);
    const mac = normalizeMac(parts[3]);
    // Flags 0x0 = ATF_INCOMPLETE: the kernel is still resolving. Treated as
    // "ask again in a moment", which is what lookup()'s retry is for.
    const complete = Number.isFinite(flags) ? flags !== 0 : true;
    rows.push({ ip: address, mac: complete ? mac : null, incomplete: !complete || !mac, device: parts[5] || null });
  }
  if (ip == null) return rows;
  const hit = rows.find((r) => r.ip === String(ip));
  return hit ? hit.mac : null;
}

/**
 * Parse Windows `arp -a`.
 *
 * Shape-driven on purpose (see the header): any line carrying an IPv4 address
 * and a six-pair hardware address is an entry, whatever the locale calls the
 * columns. The "Interface:" heading lines carry an IP but no MAC, so they fall
 * out naturally.
 */
function parseArpA(text, ip) {
  const rows = [];
  for (const line of String(text == null ? "" : text).split(/\r?\n/)) {
    const m = /(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F]{2}(?:[-:][0-9a-fA-F]{2}){5})/.exec(line);
    if (!m) continue;
    const mac = normalizeMac(m[2]);
    // `arp -a` marks unresolved entries as all-zero with type "invalid";
    // normalizeMac already rejects those, so a null mac IS the incomplete case.
    rows.push({ ip: m[1], mac, incomplete: !mac, device: null });
  }
  if (ip == null) return rows;
  const hit = rows.find((r) => r.ip === String(ip));
  return hit ? hit.mac : null;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
  });
}

/**
 * One read of the platform's ARP cache.
 *
 * @param {object} o
 * @param {string} o.ip
 * @param {string} [o.platform]  defaults to process.platform
 * @param {function} [o.readFile] (path) => Promise<string>
 * @param {function} [o.exec]     (cmd, args) => Promise<string>
 * @returns {Promise<string|null>}
 */
async function readOnce({ ip, platform = process.platform, readFile, exec } = {}) {
  if (platform === "win32") {
    const run =
      exec ||
      ((cmd, args) =>
        new Promise((resolve) => {
          // eslint-disable-next-line global-require
          const { execFile } = require("child_process");
          execFile(cmd, args, { timeout: 5000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) =>
            resolve(err ? "" : String(stdout || ""))
          );
        }));
    const out = await run("arp", ["-a"]);
    return parseArpA(out, ip);
  }
  const read =
    readFile ||
    ((file) =>
      new Promise((resolve) => {
        // eslint-disable-next-line global-require
        require("fs").readFile(file, "utf8", (err, data) => resolve(err ? "" : String(data || "")));
      }));
  const text = await read(PROC_NET_ARP);
  return parseProcNetArp(text, ip);
}

/**
 * Resolve one IP to a MAC, retrying a couple of times for an entry that is
 * still INCOMPLETE.
 *
 * Deliberately ping-LESS: the TCP session that triggered this lookup has
 * already put packets on the wire, so the kernel is resolving that IP right
 * now whether we prod it or not. Sending our own probe would only buy a
 * quarter of a second and cost a raw-socket capability we do not want.
 *
 * Never throws and never rejects: a missing /proc, a Windows box with no
 * `arp.exe`, a peer reached through a router (whose ARP entry is the ROUTER's
 * MAC — see the WOL caveat in SPEC) all come back as null, and the caller
 * simply keeps whatever mac it already had.
 *
 * @returns {Promise<string|null>} lowercase aa:bb:cc:dd:ee:ff, or null
 */
async function lookup(ip, o = {}) {
  const address = String(ip || "").trim();
  if (!address || isLocalAddress(address)) return null;
  const attempts = Number.isInteger(o.retries) ? Math.max(0, o.retries) : 2;
  const waitMs = Number.isFinite(o.retryMs) ? Math.max(0, o.retryMs) : 2000;
  const nap = typeof o.sleep === "function" ? o.sleep : sleep;

  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    let mac = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      mac = await readOnce({ ip: address, platform: o.platform, readFile: o.readFile, exec: o.exec });
    } catch (_) {
      mac = null; // an unreadable cache is a "no", never a crash
    }
    if (isMac(mac)) return mac;
    // eslint-disable-next-line no-await-in-loop
    if (attempt < attempts) await nap(waitMs);
  }
  return null;
}

module.exports = {
  PROC_NET_ARP,
  NULL_MAC,
  BROADCAST_MAC,
  normalizeMac,
  isMac,
  isLocalAddress,
  parseProcNetArp,
  parseArpA,
  readOnce,
  lookup,
};
