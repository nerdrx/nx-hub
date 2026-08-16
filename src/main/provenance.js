"use strict";
/**
 * SPEC v0.8 — signed releases.
 *
 * Every asset published by the NX release scripts gets an `<asset>.sig`
 * sibling holding one line of hex:
 *
 *     sig = ed25519(privkey, sha256(asset))
 *
 * The signature covers the 32-byte digest rather than the file bytes. That is
 * deliberate: signing a 600 MB AppImage costs one hash pass on the release
 * side, and on this side the download pipeline has ALREADY hashed the file to
 * check it against the `.sha256` sidecar — so verification is a hash it may
 * reuse plus 60 microseconds of curve arithmetic, no matter how big the asset.
 *
 * The private half lives at tools/nx-signing/nx-release.key, outside every git
 * repo, 0600, and is never read by the hub. Only the public half is here, as a
 * raw 32-byte hex string pinned per GitHub OWNER (not per repo — one identity
 * signs everything nerdrx publishes). An owner with no pinned key is simply
 * not covered by this mechanism: a `.sig` from them proves nothing and is
 * ignored rather than trusted.
 *
 * Failure model: a signature that is present and wrong is fatal, always, with
 * no fallback path. Everything else is policy (see `decide`).
 *
 * Zero dependencies — node:crypto speaks ed25519 natively.
 */

const crypto = require("crypto");
const fs = require("fs");

/**
 * Pinned public keys, keyed by lowercase GitHub login.
 *
 * Generated once by scripts/gen-signing-key.sh; re-read at any time with
 * `scripts/gen-signing-key.sh --print-public`. Changing a value here breaks
 * every signature already published under the old one — read the rollover
 * note in tools/nx-signing/README.md before touching it.
 */
const PINNED_KEYS = {
  nerdrx: "398bf09f463d78e3aa68ecb8995e69d286302b8b5ac470e5e199e91207d86653",
};

/** The 12-byte ASN.1 prefix of an ed25519 SPKI DER; the raw key is the tail. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const RAW_KEY_BYTES = 32;
const SIG_BYTES = 64;

/** Parsed KeyObjects, keyed by hex — importing is cheap but not free. */
const keyCache = new Map();

function normalizeOwner(owner) {
  if (owner == null) return "";
  const s = String(owner).trim().toLowerCase();
  // Accept "owner/repo" and full_name-shaped input; the pin is on the owner.
  return s.includes("/") ? s.split("/")[0] : s;
}

function isHex(s, bytes) {
  return typeof s === "string" && s.length === bytes * 2 && /^[0-9a-f]+$/i.test(s);
}

/**
 * Constant-time comparison of two hex strings.
 *
 * Length is compared first and in the clear — hex lengths are structural, not
 * secret — and only equal-length pairs reach timingSafeEqual, which throws on
 * a length mismatch.
 */
function timingSafeHexEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length || a.length === 0 || a.length % 2 !== 0) return false;
  let bufA;
  let bufB;
  try {
    bufA = Buffer.from(a.toLowerCase(), "hex");
    bufB = Buffer.from(b.toLowerCase(), "hex");
  } catch (_) {
    return false;
  }
  if (bufA.length !== bufB.length || bufA.length !== a.length / 2) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Is this owner covered by a pinned key at all? */
function isPinnedOwner(owner) {
  const key = normalizeOwner(owner);
  return Boolean(key && Object.prototype.hasOwnProperty.call(PINNED_KEYS, key) && isHex(PINNED_KEYS[key], RAW_KEY_BYTES));
}

/** The pinned raw public key hex for an owner, or null. */
function pinnedKeyHex(owner) {
  return isPinnedOwner(owner) ? PINNED_KEYS[normalizeOwner(owner)].toLowerCase() : null;
}

/** Does `hex` match what we pinned for this owner? (constant time) */
function matchesPinnedKey(owner, hex) {
  const pinned = pinnedKeyHex(owner);
  if (!pinned || typeof hex !== "string") return false;
  return timingSafeHexEqual(pinned, hex.trim().toLowerCase());
}

/**
 * A KeyObject for an owner's pinned key, or null.
 * Raw 32 bytes → SPKI DER → crypto.createPublicKey; no PEM anywhere.
 */
function publicKeyFor(owner) {
  const hex = pinnedKeyHex(owner);
  if (!hex) return null;
  if (keyCache.has(hex)) return keyCache.get(hex);
  let key = null;
  try {
    const der = Buffer.concat([SPKI_PREFIX, Buffer.from(hex, "hex")]);
    key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  } catch (_) {
    key = null; // a malformed pin must not take the app down
  }
  keyCache.set(hex, key);
  return key;
}

/** sha256 of a file, streamed, as lowercase hex. */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (c) => hash.update(c));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Pull the signature out of a `.sig` file's text.
 * One line of hex is the format; leading/trailing whitespace and a trailing
 * "  filename" (sha256sum habits die hard) are tolerated. Anything else → null.
 */
function parseSignature(text) {
  if (Buffer.isBuffer(text)) text = text.toString("utf8");
  if (typeof text !== "string") return null;
  const m = text.trim().match(/^([0-9a-fA-F]{128})\b/);
  return m ? m[1].toLowerCase() : null;
}

/** The 32-byte digest to verify, from a path, a Buffer, or a precomputed hex. */
async function digestOf(target, sha256Hex) {
  if (isHex(sha256Hex, 32)) return Buffer.from(sha256Hex.toLowerCase(), "hex");
  if (Buffer.isBuffer(target)) return crypto.createHash("sha256").update(target).digest();
  if (typeof target === "string") return Buffer.from(await sha256File(target), "hex");
  throw new Error("nothing to hash");
}

/**
 * Verify `<asset>.sig` against an asset.
 *
 * @param {string} owner      GitHub owner login (app.owner). Unpinned → false.
 * @param {string|Buffer} target  file path, or the bytes themselves
 * @param {string} sigHex     the `.sig` contents (hex, whitespace tolerated)
 * @param {object} [opts]
 * @param {string} [opts.sha256]  precomputed sha256 hex of the asset, so a file
 *                                the download path already hashed is not read
 *                                a second time
 * @returns {Promise<boolean>} true ONLY for a signature that verifies against
 *          the owner's pinned key. Never throws: every malformed input, unknown
 *          owner, unreadable file and bad signature is the same answer, false.
 */
async function verifyAsset(owner, target, sigHex, opts = {}) {
  const key = publicKeyFor(owner);
  if (!key) return false;
  const sig = parseSignature(sigHex);
  if (!sig || !isHex(sig, SIG_BYTES)) return false;
  let digest;
  try {
    digest = await digestOf(target, opts.sha256);
  } catch (_) {
    return false;
  }
  try {
    // ed25519 verification is constant time by construction; a wrong signature
    // and a wrong key are indistinguishable from the outside.
    return crypto.verify(null, digest, key, Buffer.from(sig, "hex")) === true;
  } catch (_) {
    return false;
  }
}

/**
 * The whole policy in one table, so the download path stays a straight line
 * and the matrix is testable without a job, a server or a file.
 *
 *   sig present + pinned owner  → "verify"  (mismatch is fatal, no fallback)
 *   sig present + unknown owner → "skip"    (a signature we cannot judge)
 *   no sig + pinned + require   → "refuse"  (requireSignatures earns its name)
 *   no sig, anything else       → "skip"    (logged "unsigned", installs)
 *
 * @returns {{action: "verify"|"skip"|"refuse", pinned: boolean, reason: string}}
 */
function decide({ owner, hasSignature, requireSignatures } = {}) {
  const pinned = isPinnedOwner(owner);
  const who = normalizeOwner(owner) || "an unknown owner";
  if (hasSignature) {
    if (pinned) return { action: "verify", pinned, reason: `signed by ${who}` };
    return { action: "skip", pinned, reason: `signature present but ${who} has no pinned key` };
  }
  if (pinned && requireSignatures) {
    return { action: "refuse", pinned, reason: `unsigned asset from a pinned owner (${who})` };
  }
  return { action: "skip", pinned, reason: "unsigned" };
}

module.exports = {
  PINNED_KEYS,
  isPinnedOwner,
  pinnedKeyHex,
  matchesPinnedKey,
  publicKeyFor,
  sha256File,
  parseSignature,
  verifyAsset,
  decide,
  timingSafeHexEqual,
};
