"use strict";
// Shared harness for the connector tests: real sockets on ephemeral ports,
// temp data dirs, and a raw WebSocket client for the negative cases the
// well-behaved drop-in client would never produce.
// (Not a test file — exports helpers only.)

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");

process.env.NX_HUB_QUIET = process.env.NX_HUB_QUIET || "1";
process.env.NX_HUB_NO_FILE_LOG = process.env.NX_HUB_NO_FILE_LOG || "1";

const server = require("../../src/main/connector/server");
const frame = require("../../src/main/connector/frame");

const tempDirs = [];

function tempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nxhub-connector-"));
  tempDirs.push(dir);
  return dir;
}

function cleanupTempDirs() {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * Start a bus on an ephemeral port with a fresh data dir.
 * Returns {handle, port, url, dataDir, token, events, changes, stop}.
 * `pingMs`/`reapMs` are the documented test-only knobs.
 */
async function startBus(opts = {}) {
  const dataDir = opts.dataDir || tempDataDir();
  const events = [];
  const logs = [];
  const handle = server.init(
    Object.assign(
      {
        port: 0,
        dataDir,
        hubVersion: "9.9.9",
        emit: (e) => events.push(e),
        log: (m) => logs.push(String(m)),
      },
      opts
    )
  );
  const ready = await handle.ready;
  const port = ready.port;
  const token = fs.readFileSync(path.join(dataDir, "connector.token"), "utf8").trim();
  return {
    handle,
    ready,
    port,
    url: `ws://127.0.0.1:${port}`,
    dataDir,
    token,
    events,
    logs,
    tokenFile: path.join(dataDir, "connector.token"),
    stop: () => handle.close(),
  };
}

/** Resolve on the next `connector-changed` (or reject after `ms`). */
function nextChange(ms = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("timed out waiting for connector-changed"));
    }, ms);
    const off = server.onChange(() => {
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

/** Poll a predicate until it holds. Used only where no event exists. */
async function waitUntil(pred, ms = 4000, label = "condition") {
  const deadline = Date.now() + ms;
  for (;;) {
    let value;
    try {
      value = await pred();
    } catch (_) {
      value = false;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Resolve the first time `handle.on(event)` fires. */
function once(handle, event, ms = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
    handle.on(event, (arg) => {
      clearTimeout(timer);
      resolve(arg);
    });
  });
}

/**
 * A deliberately dumb raw WS client: it can send malformed, unmasked, oversized
 * or out-of-order traffic, which is exactly what the negative tests need.
 * Resolves once the handshake is accepted.
 */
function rawConnect(port, opts = {}) {
  return new Promise((resolve, reject) => {
    const key = frame.makeKey();
    const socket = net.connect({ host: "127.0.0.1", port });
    const messages = [];
    const waiters = [];
    let closed = false;
    let closeCode = null;
    let handshake = false;
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error("raw handshake timed out")), 4000);

    const api = {
      socket,
      messages,
      get closed() {
        return closed;
      },
      get closeCode() {
        return closeCode;
      },
      /** Wait for the next JSON message (or one already buffered). */
      next(ms = 4000) {
        if (messages.length) return Promise.resolve(messages.shift());
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error("timed out waiting for a message")), ms);
          waiters.push((msg) => {
            clearTimeout(t);
            res(msg);
          });
        });
      },
      /** Wait until the server hangs up. */
      untilClosed(ms = 4000) {
        if (closed) return Promise.resolve(closeCode);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error("socket did not close")), ms);
          socket.once("close", () => {
            clearTimeout(t);
            res(closeCode);
          });
        });
      },
      sendJson(obj) {
        socket.write(frame.text(JSON.stringify(obj), true));
      },
      sendRaw(buf) {
        socket.write(buf);
      },
      hello(extra = {}) {
        api.sendJson(Object.assign({ type: "hello", app: "testapp", version: "1.0.0", pid: 4242, caps: ["status"] }, extra));
      },
      close() {
        try {
          socket.destroy();
        } catch (_) {
          /* ignore */
        }
      },
    };

    const parser = new frame.Parser({
      requireMask: false, // server -> client frames are never masked
      maxMessage: 64 * 1024,
      onMessage: (opcode, payload) => {
        if (opcode !== frame.OP_TEXT) return;
        let msg;
        try {
          msg = JSON.parse(payload.toString("utf8"));
        } catch (_) {
          return;
        }
        if (waiters.length) waiters.shift()(msg);
        else messages.push(msg);
      },
      onControl: (opcode, payload) => {
        if (opcode === frame.OP_CLOSE && payload.length >= 2) closeCode = payload.readUInt16BE(0);
      },
      onError: () => {},
    });

    socket.on("data", (chunk) => {
      if (handshake) return parser.push(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return undefined;
      const text = head.subarray(0, end).toString("latin1");
      const rest = head.subarray(end + 4);
      clearTimeout(timer);
      if (!/^HTTP\/1\.1 101/.test(text)) {
        socket.destroy();
        return reject(new Error(`handshake rejected: ${text.split("\r\n")[0]}`));
      }
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(text);
      if (!accept || accept[1] !== frame.acceptKey(key)) {
        socket.destroy();
        return reject(new Error("bad Sec-WebSocket-Accept"));
      }
      handshake = true;
      if (rest.length) parser.push(rest);
      if (opts.hello) api.hello(opts.hello === true ? {} : opts.hello);
      return resolve(api);
    });

    socket.on("close", () => {
      closed = true;
    });
    socket.on("error", (e) => {
      clearTimeout(timer);
      if (!handshake) reject(e);
    });
    socket.on("connect", () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
  });
}

/**
 * Grab a port that is free right now. Used by the tests that must know the port
 * *before* anything listens on it (client-before-hub, restart-on-same-port).
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** One plain HTTP request against the bus port (no upgrade headers). */
function plainGet(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let out = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("plain GET timed out"));
    }, 4000);
    socket.on("connect", () => {
      const extra = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("");
      socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${extra}\r\n`);
    });
    socket.on("data", (c) => {
      out += c.toString("latin1");
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

module.exports = {
  server,
  frame,
  tempDataDir,
  cleanupTempDirs,
  startBus,
  nextChange,
  waitUntil,
  once,
  rawConnect,
  plainGet,
  freePort,
};
