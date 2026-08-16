"use strict";
// NX Hub — fleet: the WS server half.
//
// Listens on 0.0.0.0:9023 (the ONE part of the hub that is deliberately not
// loopback-only) and runs the pre-session state machine. Two things can happen
// on a fresh connection, and exactly one of them per connection:
//
//   PAIR    the peer answers the challenge with {type:"pair", code, …}. If a
//           pairing window is open and the code matches (constant time), both
//           hubs derive the same secret, we persist the peer, reply "paired"
//           and hang up. Pairing is a ONE-SHOT exchange: the initiator dials
//           again straight afterwards for a real, authenticated session. That
//           keeps the unauthenticated code path exactly one message long.
//
//   AUTH    the peer answers with {type:"auth", id, mac}. The MAC is checked
//           against EVERY known peer's secret — that is what identifies the
//           caller, so a claimed id with somebody else's secret gets nowhere.
//           On success the connection is promoted to a Session and everything
//           after it is sequenced and MAC'd.
//
// A connection that says neither within AUTH_GRACE_MS is dropped. Everything
// before the promotion is plain JSON: it has to be, since the whole point of
// the exchange is to establish which secret (if any) applies.

const fs = require("fs");

const protocol = require("./protocol");
const wire = require("./wire");
const assetsMod = require("./assets");
const { Session } = require("./session");

const frame = wire.frame;

/** A connection that neither pairs nor authenticates dies this fast. */
const AUTH_GRACE_MS = 10000;

function noop() {}

/**
 * @param {object} o
 * @param {number} [o.port]      0 in tests (ephemeral)
 * @param {string} [o.host]      "0.0.0.0" in production, "127.0.0.1" in tests
 * @param {function} o.local     () => {id, name, port, hubVersion}
 * @param {function} o.peers     () => [{id, name, host, port, secret}]
 * @param {function} [o.pairCode] () => {code, expiresAt} | null
 * @param {function} [o.onPair]  ({peerId, name, host, port, secret, code}) => peer
 * @param {function} [o.onSession] (session) => void
 * @param {object} [o.assets]    v0.7 asset index — enables GET /asset/<sha256>
 * @param {function} [o.log]
 * @returns {{ready:Promise, close:function, port:number}}
 */
function createServer(o = {}) {
  const log = typeof o.log === "function" ? o.log : noop;
  const local = typeof o.local === "function" ? o.local : () => ({});
  const peersOf = typeof o.peers === "function" ? o.peers : () => [];
  const pairCode = typeof o.pairCode === "function" ? o.pairCode : () => null;
  const onPair = typeof o.onPair === "function" ? o.onPair : null;
  const onSession = typeof o.onSession === "function" ? o.onSession : noop;
  const graceMs = Number(o.authGraceMs) > 0 ? Number(o.authGraceMs) : AUTH_GRACE_MS;
  /** v0.7: the asset index this hub seeds from, or null (no seeding). */
  const assets = o.assets || null;
  const wantPort = Number.isInteger(o.port) ? o.port : protocol.FLEET_PORT;
  const host = o.host || "0.0.0.0";

  /** Connections that have not been promoted to a Session yet. */
  const pending = new Set();
  let closed = false;

  function handleUpgrade(req, socket, head) {
    if (closed) {
      try {
        socket.destroy();
      } catch (_) {
        /* ignore */
      }
      return;
    }
    // Only our own resource — a stray browser hitting :9023 gets nothing.
    const url = String(req.url || "").split("?")[0];
    if (url !== protocol.RESOURCE && url !== "/") {
      try {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
      } catch (_) {
        /* ignore */
      }
      return;
    }

    const remote = protocol.normalizeHost(socket.remoteAddress);
    const channel = wire.acceptUpgrade(req, socket, head, { maxMessage: protocol.MAX_MESSAGE });
    if (!channel) return;

    const me = local() || {};
    const nonce = protocol.newNonce();
    const conn = { channel, remote, nonce, done: false, timer: null };
    pending.add(conn);

    conn.timer = setTimeout(() => {
      if (conn.done) return;
      log(`fleet: ${remote} never authenticated — dropping`);
      drop(conn, frame.CLOSE_POLICY_VIOLATION, "authentication timeout");
    }, graceMs);
    if (conn.timer.unref) conn.timer.unref();

    channel.onClose = () => {
      if (conn.timer) clearTimeout(conn.timer);
      pending.delete(conn);
    };
    channel.onText = (text) => onPreAuthText(conn, text);

    plain(channel, {
      type: "challenge",
      nonce,
      id: me.id || null,
      name: me.name || "",
      hubVersion: me.hubVersion || "0.0.0",
    });
  }

  /** Unauthenticated, unsequenced JSON — only used before the promotion. */
  function plain(channel, obj) {
    return channel.send(JSON.stringify(obj));
  }

  function drop(conn, code, reason) {
    if (conn.timer) clearTimeout(conn.timer);
    conn.timer = null;
    conn.done = true;
    pending.delete(conn);
    try {
      conn.channel.close(code, reason);
    } catch (_) {
      /* ignore */
    }
  }

  function refuse(conn, message, code = frame.CLOSE_POLICY_VIOLATION) {
    plain(conn.channel, { type: "error", message });
    drop(conn, code, message);
  }

  function onPreAuthText(conn, text) {
    if (conn.done) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (_) {
      refuse(conn, "malformed json", frame.CLOSE_PROTOCOL_ERROR);
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      refuse(conn, "malformed message", frame.CLOSE_PROTOCOL_ERROR);
      return;
    }
    if (msg.type === "pair") return handlePair(conn, msg);
    if (msg.type === "auth") return handleAuth(conn, msg);
    return refuse(conn, "expected pair or auth");
  }

  /* ---------------- pairing ---------------- */

  function handlePair(conn, msg) {
    const window = pairCode();
    const now = Date.now();
    if (!window || !window.code) {
      refuse(conn, "no pairing window is open on this hub");
      return;
    }
    if (!(Number(window.expiresAt) > now)) {
      refuse(conn, "the pairing code has expired");
      return;
    }
    if (!protocol.isId(msg.id)) {
      refuse(conn, "pair requires a hub id");
      return;
    }
    // Constant-time, and only AFTER the cheap structural checks — those leak
    // nothing about the code itself.
    if (!protocol.isCode(String(msg.code || "")) || !protocol.codeMatches(window.code, String(msg.code))) {
      log(`fleet: ${conn.remote} offered the wrong pairing code`);
      refuse(conn, "that code is not right");
      return;
    }

    const me = local() || {};
    // Fixed id order: the INITIATOR (whoever dialled) always goes first, so
    // both hubs hash the same string.
    const secret = protocol.deriveSecret(window.code, msg.id, me.id);
    const port = Number(msg.port);
    const peer = {
      id: msg.id,
      name: typeof msg.name === "string" && msg.name.trim() ? msg.name.trim().slice(0, 64) : msg.id,
      // The responder learns the initiator's address from the socket itself —
      // never from the message, which a peer could lie about.
      host: conn.remote,
      port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : protocol.FLEET_PORT,
      secret,
      lastSeen: now,
    };
    try {
      if (onPair) onPair(peer);
    } catch (e) {
      refuse(conn, `could not store the peer — ${e.message}`);
      return;
    }
    plain(conn.channel, {
      type: "paired",
      id: me.id,
      name: me.name || "",
      port: me.port || protocol.FLEET_PORT,
      hubVersion: me.hubVersion || "0.0.0",
    });
    log(`fleet: paired with ${peer.name} (${peer.id}) at ${peer.host}`);
    // One-shot: the initiator reconnects for the authenticated session.
    conn.done = true;
    if (conn.timer) clearTimeout(conn.timer);
    pending.delete(conn);
    const timer = setTimeout(() => {
      try {
        conn.channel.close(frame.CLOSE_NORMAL, "paired");
      } catch (_) {
        /* ignore */
      }
    }, 50);
    if (timer.unref) timer.unref();
  }

  /* ---------------- authentication ---------------- */

  /**
   * Identify the caller BY SECRET. We compute the expected MAC with every
   * known peer's secret and compare in constant time; the peer whose secret
   * produces the presented MAC is who we are talking to. The claimed id is
   * only an input to the MAC, never a shortcut around it.
   */
  function identify(nonce, claimedId, presented) {
    if (!protocol.isId(claimedId) || typeof presented !== "string") return null;
    let found = null;
    for (const peer of peersOf() || []) {
      if (!peer || !peer.secret) continue;
      const want = protocol.authMac(peer.secret, nonce, claimedId);
      // constantEquals over the hex strings — no early exit on the first
      // differing byte, and the loop always visits every peer.
      const hit = protocol.constantEquals(want, presented);
      if (hit && !found && peer.id === claimedId) found = peer;
    }
    return found;
  }

  function handleAuth(conn, msg) {
    const peer = identify(conn.nonce, msg.id, msg.mac);
    if (!peer) {
      log(`fleet: ${conn.remote} failed the challenge (claimed ${String(msg.id).slice(0, 16)})`);
      refuse(conn, "unauthorized");
      return;
    }

    const me = local() || {};
    conn.done = true;
    if (conn.timer) clearTimeout(conn.timer);
    conn.timer = null;
    pending.delete(conn);

    // The last plain message on this connection; everything after it is
    // sequenced and MAC'd by the Session.
    plain(conn.channel, {
      type: "ready",
      id: me.id,
      name: me.name || "",
      hubVersion: me.hubVersion || "0.0.0",
    });

    const session = new Session({
      channel: conn.channel,
      secret: peer.secret,
      peerId: peer.id,
      peerName: peer.name,
      host: conn.remote,
      port: peer.port,
      role: "server",
      log,
    });
    log(`fleet: ${peer.name} (${peer.id}) authenticated from ${conn.remote}`);
    onSession(session);
  }

  /* ---------------- v0.7: GET /asset/<sha256> ---------------- */

  /**
   * The seeding route (SPEC v0.7). Plain HTTP on the same port, deliberately
   * NOT a websocket message: the payload is a whole AppImage and it wants a
   * streamed body with a Content-Length, not a 64 KB-capped frame.
   *
   * Order matters and is the security of the thing:
   *   1. shape — a 64-hex path segment or nothing
   *   2. AUTH — before any disk access, so an unauthorised caller learns
   *      nothing about what this hub holds (403 for everyone, always)
   *   3. the index, revalidated — a stale entry 404s and is dropped
   *
   * There is no path anywhere in the request, so there is no traversal to
   * defend against: a hash is only servable because this hub hashed it itself.
   */
  function handleAssetRequest(req, res) {
    const raw = String(req.url || "");
    const [pathname, query] = raw.split("?");
    const m = /^\/asset\/([0-9a-fA-F]{64})$/.exec(pathname);
    if (!m) return false;
    if (req.method !== "GET" && req.method !== "HEAD") {
      end(res, 405, "method not allowed\n");
      return true;
    }
    const sha = m[1].toLowerCase();
    const auth = readAuth(query);
    const peer = assetsMod.authorizePeer(peersOf() || [], sha, auth);
    if (!peer) {
      log(`fleet: refused an unauthorised /asset request from ${remoteOf(req)}`);
      end(res, 403, "forbidden\n");
      return true;
    }
    if (!assets) {
      end(res, 404, "not found\n");
      return true;
    }
    assets
      .validate(sha)
      .then((entry) => {
        if (!entry) {
          end(res, 404, "not found\n");
          return;
        }
        streamAsset(req, res, entry, peer, sha);
      })
      .catch((e) => {
        log(`fleet: /asset/${sha.slice(0, 12)} failed — ${e.message}`);
        end(res, 404, "not found\n");
      });
    return true;
  }

  function readAuth(query) {
    for (const pair of String(query || "").split("&")) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      if (pair.slice(0, eq) !== "auth") continue;
      try {
        return decodeURIComponent(pair.slice(eq + 1));
      } catch (_) {
        return pair.slice(eq + 1);
      }
    }
    return "";
  }

  function remoteOf(req) {
    return protocol.normalizeHost(req.socket && req.socket.remoteAddress);
  }

  function end(res, code, body) {
    try {
      res.writeHead(code, { "Content-Type": "text/plain", Connection: "close" });
      res.end(body);
    } catch (_) {
      /* the caller hung up */
    }
  }

  function streamAsset(req, res, entry, peer, sha) {
    let stream;
    try {
      stream = fs.createReadStream(entry.path);
    } catch (e) {
      end(res, 404, "not found\n");
      return;
    }
    stream.on("error", () => {
      // The file vanished between validate() and open — the only honest
      // answer is 404, and the socket dies with it since the body started.
      if (!res.headersSent) end(res, 404, "not found\n");
      else res.destroy();
    });
    stream.once("open", () => {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(entry.size),
        "Cache-Control": "no-store",
      });
      if (req.method === "HEAD") {
        stream.destroy();
        res.end();
        return;
      }
      log(`fleet: seeding ${sha.slice(0, 12)}… (${entry.size} bytes) to ${peer.name}`);
      stream.pipe(res);
    });
    res.on("close", () => stream.destroy());
  }

  /* ---------------- listening ---------------- */

  const server = wire.createHttpServer(handleUpgrade, handleAssetRequest);

  const api = {
    port: wantPort,
    host,
    ready: null,
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      for (const conn of Array.from(pending)) drop(conn, frame.CLOSE_NORMAL, "hub closing");
      pending.clear();
      return new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        try {
          server.closeAllConnections?.();
        } catch (_) {
          /* ignore */
        }
        return undefined;
      });
    },
  };

  api.ready = new Promise((resolve) => {
    let settled = false;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    server.once("error", (err) => {
      // A busy port is a normal condition (a second hub on this machine), not
      // a crash: log it and stay inert, exactly like the connector does.
      if (err && err.code === "EADDRINUSE") log(`fleet: port ${wantPort} is busy — another NX Hub owns it`);
      else log(`fleet: listen failed — ${(err && err.message) || err}`);
      closed = true;
      settle({ ok: false, port: wantPort, error: err });
    });
    server.listen(wantPort, host, () => {
      api.port = server.address().port;
      log(`fleet: listening on ws://${host}:${api.port}${protocol.RESOURCE}`);
      settle({ ok: true, port: api.port });
    });
  });

  return api;
}

module.exports = { createServer, AUTH_GRACE_MS };
