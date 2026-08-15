"use strict";
// NX Hub — connector bus (SPEC "NX Connector" v0.5, frozen 2026-08-16).
//
// A loopback WebSocket rendezvous point on ws://127.0.0.1:9021. NX apps
// announce themselves with `hello`, stream `status`, and can be asked to stop
// politely with `shutdown-request` (that is how [stacks] tears a stack down).
//
// Zero npm dependencies: node:http gives us the GET/upgrade parse for free and
// then hands over the raw socket, on top of which ./frame.js speaks RFC 6455.
//
// Pure node: no electron require anywhere in this file, so the CLI and the
// tests can drive it under plain node.
//
// Module API (FROZEN — [stacks], [ipc] and [ui] call exactly these):
//   init({port, dataDir, emit, log, hubVersion}) -> {close}
//   getClients() -> [{app, version, pid, since, lastSeen, fields, caps}]
//   isPresent(appId) -> boolean
//   requestShutdown(appId) -> boolean
//   onChange(cb) -> unsubscribe

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const frame = require("./frame");

// ---------------------------------------------------------------------------
// Limits — all from SPEC.
// ---------------------------------------------------------------------------

/** Hard cap on any single WS message (SPEC: "<=16KB frames"). */
const MAX_FRAME_BYTES = 16 * 1024;
/** Hard cap on a status payload's `fields` once serialised (SPEC: "<=2KB"). */
const MAX_STATUS_BYTES = 2 * 1024;
/** Status messages allowed per client per second (SPEC: "throttled 4/s"). */
const STATUS_PER_SEC = 4;
/** Debounce floor for connector-changed emits (SPEC: "debounced <=4/s"). */
const CHANGE_MIN_MS = 250;
/** SPEC: "30s ping, 90s reap". */
const DEFAULT_PING_MS = 30 * 1000;
const DEFAULT_REAP_MS = 90 * 1000;
/** A socket that never says hello is dropped this fast (never above 10s). */
const HELLO_GRACE_MS = 10 * 1000;
/** Guard against a client inventing unbounded status keys across messages. */
const MAX_STATUS_KEYS = 64;

const TOKEN_FILE = "connector.token";

// ---------------------------------------------------------------------------
// Module state. `current` is the live bus; onChange listeners deliberately live
// at module scope so a subscriber that registered before init() (or across an
// init() restart) keeps working.
// ---------------------------------------------------------------------------

let current = null;
const changeListeners = new Set();

function noop() {}

/** Never let a caller's log/emit/listener throw into the bus. */
function safely(fn, ...args) {
  try {
    if (typeof fn === "function") fn(...args);
  } catch (_) {
    /* a listener must never break the bus */
  }
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/** `<dataDir>/connector.token`. */
function tokenPath(dataDir) {
  return path.join(dataDir, TOKEN_FILE);
}

/**
 * Read the shared secret, creating a fresh 32-hex one at 0600 if absent.
 * A token file that exists but is empty/corrupt is replaced — an unreadable
 * secret would lock every client out with no way back.
 */
function ensureToken(dataDir) {
  const file = tokenPath(dataDir);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{32}$/i.test(existing)) return existing;
  } catch (_) {
    /* missing or unreadable — fall through and mint one */
  }
  const token = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(dataDir, { recursive: true });
  // Written 0600 from the start: mode on open, not a chmod afterwards, so the
  // secret is never briefly world-readable.
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600); // umask can still have clipped the above
  } catch (_) {
    /* best effort — some filesystems have no modes */
  }
  return token;
}

/** Constant-time secret comparison that does not leak length either. */
function tokenMatches(secret, presented) {
  if (typeof presented !== "string") return false;
  // Hash both sides first: timingSafeEqual needs equal lengths, and hashing
  // gives us that without an early length-dependent return.
  const a = crypto.createHash("sha256").update(secret).digest();
  const b = crypto.createHash("sha256").update(presented).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

function normalizeAppId(app) {
  return String(app || "")
    .trim()
    .toLowerCase();
}

function isLoopback(address) {
  if (!address) return false;
  const addr = address.startsWith("::ffff:") ? address.slice(7) : address;
  return addr === "127.0.0.1" || addr.startsWith("127.") || addr === "::1";
}

/**
 * One bus instance. Everything is per-instance so init() can cleanly replace a
 * previous one without leaking timers or sockets.
 */
function createBus(opts) {
  const dataDir = opts.dataDir;
  const port = typeof opts.port === "number" ? opts.port : 9021;
  const emit = typeof opts.emit === "function" ? opts.emit : noop;
  const log = typeof opts.log === "function" ? opts.log : noop;
  const hubVersion = String(opts.hubVersion || "0.0.0");
  // {pingMs, reapMs} are TEST-ONLY knobs (see docs/connector/PROTOCOL.md).
  const pingMs = Number(opts.pingMs) > 0 ? Number(opts.pingMs) : DEFAULT_PING_MS;
  const reapMs = Number(opts.reapMs) > 0 ? Number(opts.reapMs) : DEFAULT_REAP_MS;
  const helloGraceMs = Math.min(HELLO_GRACE_MS, reapMs);

  const secret = ensureToken(dataDir);

  /** Every open socket, hello'd or not. */
  const conns = new Set();
  /** appId -> conn, for the hello'd ones. Latest hello wins. */
  const byApp = new Map();

  let closed = false;
  let listening = false;
  let changeTimer = null;
  let changePending = false;
  let lastChangeAt = 0;
  let sweepTimer = null;
  let closePromise = null;

  // -- change notification (leading-ish, hard-capped at 1 per CHANGE_MIN_MS) --

  function fireChange() {
    safely(emit, { type: "connector-changed" });
    for (const cb of Array.from(changeListeners)) safely(cb);
  }

  function notifyChange() {
    if (closed) return;
    changePending = true;
    if (changeTimer) return;
    const wait = Math.max(0, CHANGE_MIN_MS - (Date.now() - lastChangeAt));
    changeTimer = setTimeout(() => {
      changeTimer = null;
      if (!changePending || closed) return;
      changePending = false;
      lastChangeAt = Date.now();
      fireChange();
    }, wait);
    if (changeTimer.unref) changeTimer.unref();
  }

  // -- socket plumbing ------------------------------------------------------

  function send(conn, obj) {
    if (!conn.socket || conn.socket.destroyed || !conn.socket.writable) return false;
    try {
      conn.socket.write(frame.text(JSON.stringify(obj)));
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Reply {type:"error"} and hang up — the SPEC response to a violation. */
  function fail(conn, message, code = frame.CLOSE_POLICY_VIOLATION) {
    send(conn, { type: "error", message });
    dropConn(conn, code, message);
  }

  function dropConn(conn, code = frame.CLOSE_NORMAL, reason = "") {
    if (conn.gone) return;
    conn.gone = true;
    conns.delete(conn);

    // Only unregister the app if this socket is still the registered one —
    // a superseded socket (latest-hello-wins) must not evict its replacement.
    let wasPresent = false;
    if (conn.appId && byApp.get(conn.appId) === conn) {
      byApp.delete(conn.appId);
      wasPresent = true;
    }

    const socket = conn.socket;
    if (socket && !socket.destroyed) {
      try {
        socket.write(frame.close(code, reason));
      } catch (_) {
        /* peer already gone */
      }
      // Give the close frame a tick to flush, then make sure it is really shut.
      try {
        socket.end();
      } catch (_) {
        /* ignore */
      }
      const t = setTimeout(() => {
        try {
          socket.destroy();
        } catch (_) {
          /* ignore */
        }
      }, 50);
      if (t.unref) t.unref();
    }

    if (wasPresent) {
      log(`connector: ${conn.appId} disconnected`);
      notifyChange();
    }
  }

  function handleUpgrade(req, socket, head) {
    if (closed) {
      socket.destroy();
      return;
    }
    // Belt and braces: we bind loopback, but never serve a non-loopback peer.
    if (!isLoopback(socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    const version = req.headers["sec-websocket-version"];
    const upgrade = String(req.headers.upgrade || "").toLowerCase();
    if (upgrade !== "websocket" || !key || String(version) !== "13") {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    socket.setNoDelay(true);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${frame.acceptKey(key)}\r\n\r\n`
    );

    const now = Date.now();
    const conn = {
      socket,
      appId: null,
      version: null,
      pid: null,
      caps: [],
      fields: {},
      since: now,
      lastSeen: now,
      statusTimes: [],
      gone: false,
    };
    conns.add(conn);

    const parser = new frame.Parser({
      requireMask: true, // RFC 6455 §5.1 — client frames are always masked
      maxMessage: MAX_FRAME_BYTES,
      onMessage: (opcode, payload) => {
        conn.lastSeen = Date.now();
        if (opcode === frame.OP_BINARY) {
          fail(conn, "binary frames are not supported", frame.CLOSE_UNSUPPORTED_DATA);
          return;
        }
        onText(conn, payload);
      },
      onControl: (opcode, payload) => {
        conn.lastSeen = Date.now();
        if (opcode === frame.OP_CLOSE) dropConn(conn, frame.CLOSE_NORMAL, "");
        else if (opcode === frame.OP_PING) {
          try {
            socket.write(frame.pong(payload));
          } catch (_) {
            /* ignore */
          }
        }
        // OP_PONG: liveness only, already recorded in lastSeen.
      },
      onError: (code, message) => fail(conn, message, code),
    });

    socket.on("data", (chunk) => {
      if (conn.gone) return;
      parser.push(chunk);
    });
    socket.on("error", () => dropConn(conn, frame.CLOSE_NORMAL, ""));
    socket.on("close", () => dropConn(conn, frame.CLOSE_NORMAL, ""));
    // http.Server hands upgraded sockets over with allowHalfOpen set, so a peer
    // that vanishes gives us 'end' and *never* 'close' until we hang up too.
    // Without this, a killed app would keep its presence slot until the reaper
    // noticed 90s later.
    socket.on("end", () => dropConn(conn, frame.CLOSE_NORMAL, ""));

    // Bytes the HTTP parser had already read past the header boundary: a client
    // that pipelines its hello into the handshake segment would otherwise
    // silently lose it.
    if (head && head.length) parser.push(head);
  }

  function onText(conn, payload) {
    let msg;
    try {
      msg = JSON.parse(payload.toString("utf8"));
    } catch (_) {
      fail(conn, "malformed json", frame.CLOSE_PROTOCOL_ERROR);
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      fail(conn, "malformed message", frame.CLOSE_PROTOCOL_ERROR);
      return;
    }

    switch (msg.type) {
      case "hello":
        return onHello(conn, msg);
      case "status":
        return onStatus(conn, msg);
      case "bye":
        return dropConn(conn, frame.CLOSE_NORMAL, "bye");
      case "pong":
        return undefined; // keepalive; lastSeen already bumped
      default:
        // Forward compatibility: an unknown verb earns a complaint, not a
        // hangup, so a newer client can still hold its presence slot.
        send(conn, { type: "error", message: `unknown type: ${String(msg.type)}` });
        return undefined;
    }
  }

  function onHello(conn, msg) {
    if (!tokenMatches(secret, msg.token)) {
      fail(conn, "unauthorized", frame.CLOSE_POLICY_VIOLATION);
      return;
    }
    const appId = normalizeAppId(msg.app);
    if (!appId) {
      fail(conn, "hello requires an app id", frame.CLOSE_POLICY_VIOLATION);
      return;
    }

    // Latest hello wins: an older socket for the same id is evicted. Clear its
    // appId first so its teardown does not delete our fresh registration.
    const previous = byApp.get(appId);
    if (previous && previous !== conn) {
      byApp.delete(appId);
      previous.appId = null;
      dropConn(previous, frame.CLOSE_NORMAL, "superseded");
    }

    // A socket that re-hellos under a new id releases the old one.
    if (conn.appId && conn.appId !== appId && byApp.get(conn.appId) === conn) {
      byApp.delete(conn.appId);
    }

    conn.appId = appId;
    conn.version = typeof msg.version === "string" ? msg.version : null;
    conn.pid = Number.isInteger(msg.pid) ? msg.pid : null;
    conn.caps = Array.isArray(msg.caps) ? msg.caps.filter((c) => typeof c === "string").slice(0, 16) : [];
    conn.since = Date.now();
    conn.lastSeen = conn.since;
    conn.fields = {};
    byApp.set(appId, conn);

    send(conn, { type: "welcome", hub: hubVersion });
    log(`connector: ${appId}${conn.version ? ` ${conn.version}` : ""} connected`);
    notifyChange();
  }

  function onStatus(conn, msg) {
    if (!conn.appId) {
      fail(conn, "hello required before status", frame.CLOSE_POLICY_VIOLATION);
      return;
    }
    const fields = msg.fields;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      fail(conn, "status requires a fields object", frame.CLOSE_PROTOCOL_ERROR);
      return;
    }

    // Size cap is on the serialised `fields` — that is what we retain and what
    // the UI eventually renders.
    let encoded;
    try {
      encoded = JSON.stringify(fields);
    } catch (_) {
      fail(conn, "status fields are not serialisable", frame.CLOSE_PROTOCOL_ERROR);
      return;
    }
    if (Buffer.byteLength(encoded, "utf8") > MAX_STATUS_BYTES) {
      fail(conn, `status payload exceeds ${MAX_STATUS_BYTES} bytes`, frame.CLOSE_TOO_LARGE);
      return;
    }

    // Throttle: 4 per rolling second, excess dropped *silently* (SPEC) — a
    // chatty app should not be punished with a disconnect.
    const now = Date.now();
    conn.statusTimes = conn.statusTimes.filter((t) => now - t < 1000);
    if (conn.statusTimes.length >= STATUS_PER_SEC) return;
    conn.statusTimes.push(now);

    // Shallow MERGE, not replace: apps send partial updates (a HR strap sends
    // {hr} every beat without restating {connected}). Documented in PROTOCOL.md.
    const merged = Object.assign({}, conn.fields, fields);
    if (Object.keys(merged).length > MAX_STATUS_KEYS) {
      fail(conn, `status exceeds ${MAX_STATUS_KEYS} keys`, frame.CLOSE_TOO_LARGE);
      return;
    }
    if (Buffer.byteLength(JSON.stringify(merged), "utf8") > MAX_STATUS_BYTES) {
      fail(conn, `merged status exceeds ${MAX_STATUS_BYTES} bytes`, frame.CLOSE_TOO_LARGE);
      return;
    }
    conn.fields = merged;
    notifyChange();
  }

  // -- ping / reap ----------------------------------------------------------

  function sweep() {
    if (closed) return;
    const now = Date.now();
    for (const conn of Array.from(conns)) {
      const silent = now - conn.lastSeen;
      if (!conn.appId) {
        // Never said hello: drop it well before the full reap window.
        if (now - conn.since > helloGraceMs) dropConn(conn, frame.CLOSE_POLICY_VIOLATION, "no hello");
        continue;
      }
      if (silent > reapMs) {
        log(`connector: reaping ${conn.appId} (silent ${silent}ms)`);
        dropConn(conn, frame.CLOSE_NORMAL, "reaped");
        continue;
      }
      send(conn, { type: "ping" });
    }
  }

  // -- HTTP server ----------------------------------------------------------

  const server = http.createServer((req, res) => {
    // Anything that is not an upgrade gets the RFC 7231 brush-off. Handy for a
    // human curling the port to see whether the bus is up.
    res.writeHead(426, { "Content-Type": "text/plain", Connection: "close" });
    res.end("nx-connector: websocket upgrade required\n");
  });
  server.on("upgrade", handleUpgrade);
  server.on("clientError", (_err, socket) => {
    try {
      socket.destroy();
    } catch (_) {
      /* ignore */
    }
  });

  const bus = {
    port,
    secret,
    tokenFile: tokenPath(dataDir),
    /** Resolves {ok, port, error} once listening succeeds or fails. */
    ready: null,
    getClients() {
      const out = [];
      for (const conn of byApp.values()) {
        out.push({
          app: conn.appId,
          version: conn.version,
          pid: conn.pid,
          since: conn.since,
          lastSeen: conn.lastSeen,
          fields: Object.assign({}, conn.fields),
          caps: conn.caps.slice(),
        });
      }
      // Ordinal sort — the host may run de_DE, so never localeCompare.
      out.sort((a, b) => (a.app < b.app ? -1 : a.app > b.app ? 1 : 0));
      return out;
    },
    isPresent(appId) {
      return byApp.has(normalizeAppId(appId));
    },
    requestShutdown(appId) {
      const conn = byApp.get(normalizeAppId(appId));
      if (!conn) return false;
      const ok = send(conn, { type: "shutdown-request" });
      if (ok) log(`connector: shutdown-request -> ${conn.appId}`);
      return ok;
    },
    /**
     * Stop the bus. Idempotent. Returns a promise that settles once the
     * listening socket is really released — callers may ignore it, but tests
     * (and a restart on the same port) can await it instead of sleeping.
     */
    close() {
      if (closed) return closePromise || Promise.resolve();
      closed = true;
      if (sweepTimer) clearInterval(sweepTimer);
      if (changeTimer) clearTimeout(changeTimer);
      sweepTimer = null;
      changeTimer = null;
      for (const conn of Array.from(conns)) {
        conn.appId = null; // no change storm on shutdown
        dropConn(conn, frame.CLOSE_NORMAL, "hub closing");
      }
      byApp.clear();
      conns.clear();
      closePromise = new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        // Upgraded sockets are detached from the http server's own tracking,
        // so nudge anything still lingering (node >= 18).
        try {
          server.closeAllConnections?.();
        } catch (_) {
          /* ignore */
        }
        return undefined;
      });
      listening = false;
      return closePromise;
    },
  };

  bus.ready = new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    server.once("error", (err) => {
      // A busy port almost always means another hub instance already owns the
      // bus. That is a normal condition, not a crash: log it and stay inert.
      listening = false;
      if (err && err.code === "EADDRINUSE") {
        log(`connector: port ${port} is busy — another NX Hub owns the bus`);
      } else {
        log(`connector: listen failed — ${(err && err.message) || err}`);
      }
      closed = true;
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      settle({ ok: false, port, error: err });
    });
    server.listen(port, "127.0.0.1", () => {
      listening = true;
      bus.port = server.address().port;
      sweepTimer = setInterval(sweep, pingMs);
      if (sweepTimer.unref) sweepTimer.unref();
      log(`connector: listening on ws://127.0.0.1:${bus.port}`);
      settle({ ok: true, port: bus.port });
    });
  });

  return bus;
}

// ---------------------------------------------------------------------------
// Public module API (frozen)
// ---------------------------------------------------------------------------

/**
 * Start the bus. A second call closes the previous instance first.
 * Never throws: a busy port (another hub instance) resolves to an inert handle.
 *
 * @param {object} o
 * @param {number} [o.port]        default config.NX_CONNECTOR_PORT (9021)
 * @param {string} o.dataDir       where connector.token lives
 * @param {function} [o.emit]      hub event sink; gets {type:"connector-changed"}
 * @param {function} [o.log]
 * @param {string} [o.hubVersion]  echoed back in `welcome`
 * @param {number} [o.pingMs]      TEST-ONLY: ping/sweep interval (default 30s)
 * @param {number} [o.reapMs]      TEST-ONLY: silence before reap (default 90s)
 * @returns {{close: function}}    plus {ready, port} for tests/diagnostics
 */
function init(o = {}) {
  if (current) {
    try {
      current.close();
    } catch (_) {
      /* ignore */
    }
    current = null;
  }
  if (!o.dataDir) throw new Error("connector.init requires dataDir");

  let bus;
  try {
    bus = createBus(o);
  } catch (e) {
    // Token creation on an unwritable dataDir, and nothing else realistic.
    safely(o.log, `connector: init failed — ${e.message}`);
    return { close: noop, ready: Promise.resolve({ ok: false, error: e }), port: o.port || null };
  }
  current = bus;
  return bus;
}

/** Every app currently on the bus. Empty when the bus is not running. */
function getClients() {
  return current ? current.getClients() : [];
}

/** Is this app id on the bus right now? (presence === open socket) */
function isPresent(appId) {
  return current ? current.isPresent(appId) : false;
}

/** Ask an app to exit politely. False when it is not connected. */
function requestShutdown(appId) {
  return current ? current.requestShutdown(appId) : false;
}

/**
 * Subscribe to bus changes (same debounce as the connector-changed event).
 * Survives init() restarts. Returns an unsubscribe function.
 */
function onChange(cb) {
  if (typeof cb !== "function") return noop;
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

/** Test/diagnostic helper: the live instance, or null. */
function _current() {
  return current;
}

module.exports = {
  init,
  getClients,
  isPresent,
  requestShutdown,
  onChange,
  tokenPath,
  ensureToken,
  _current,
  MAX_FRAME_BYTES,
  MAX_STATUS_BYTES,
  STATUS_PER_SEC,
  CHANGE_MIN_MS,
  DEFAULT_PING_MS,
  DEFAULT_REAP_MS,
};
