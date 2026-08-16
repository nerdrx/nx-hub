"use strict";
// NX Hub — fleet: the WebSocket transport, on top of the connector's codec.
//
// src/main/connector/frame.js already speaks RFC 6455 and is already tested,
// so the fleet reuses it rather than growing a second parser. The only new
// work here is the two ends of the handshake and a JSON-text channel object
// that both the server and the client sides can drive.
//
// Masking (RFC 6455 §5.1): a CLIENT always masks its frames, a SERVER never
// does. Both directions are checked, not just assumed — the parsers are
// configured with `requireMask` accordingly, so a peer that gets it wrong is a
// protocol error rather than a silent stream of garbage.
//
// Pure node: net + http only.

const http = require("http");
const net = require("net");

const frame = require("../connector/frame");
const protocol = require("./protocol");

/**
 * A JSON-text channel over one upgraded socket.
 *
 * `mask` decides which half of RFC 6455 we are: true on a dialled connection,
 * false on an accepted one. Callers set `onText` / `onClose`, then send().
 */
class Channel {
  constructor(socket, { mask, maxMessage = protocol.MAX_MESSAGE, label = "" } = {}) {
    this.socket = socket;
    this.mask = Boolean(mask);
    this.label = label;
    this.closed = false;
    this.closeCode = null;
    this.onText = () => {};
    this.onClose = () => {};

    this.parser = new frame.Parser({
      // We mask ⇒ we are the client ⇒ the peer is a server ⇒ it must NOT mask.
      requireMask: !this.mask,
      maxMessage,
      onMessage: (opcode, payload) => {
        if (opcode !== frame.OP_TEXT) {
          this.close(frame.CLOSE_UNSUPPORTED_DATA, "text frames only");
          return;
        }
        try {
          this.onText(payload.toString("utf8"));
        } catch (_) {
          /* a handler must never break the channel */
        }
      },
      onControl: (opcode, payload) => {
        if (opcode === frame.OP_CLOSE) {
          if (payload.length >= 2) this.closeCode = payload.readUInt16BE(0);
          this.destroy();
        } else if (opcode === frame.OP_PING) {
          this.write(frame.pong(payload, this.mask));
        }
      },
      onError: (code, message) => this.close(code, message),
    });

    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      if (this.closed) return;
      this.parser.push(chunk);
    });
    socket.on("error", () => this.destroy());
    socket.on("close", () => this.destroy());
    // Upgraded sockets are half-open capable: without this a vanished peer
    // gives us 'end' and never 'close', and the session would linger.
    socket.on("end", () => this.destroy());
  }

  write(buf) {
    if (this.closed || !this.socket || this.socket.destroyed || !this.socket.writable) return false;
    try {
      this.socket.write(buf);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Send one text frame. Returns false when the socket is already gone. */
  send(text) {
    return this.write(frame.text(String(text), this.mask));
  }

  /**
   * Send a close frame, then hang up. Idempotent.
   *
   * The socket is END'ed rather than destroyed so the close frame (and the
   * `{type:"error"}` that usually precedes it) actually reaches the peer —
   * destroying immediately is how you get a "connection reset" instead of the
   * reason you carefully wrote. A short timer guarantees the socket dies even
   * if the peer never answers the close.
   */
  close(code = frame.CLOSE_NORMAL, reason = "") {
    if (this.closed) return;
    this.write(frame.close(code, reason, this.mask));
    this.closed = true;
    try {
      this.socket.end();
    } catch (_) {
      /* peer already gone */
    }
    const timer = setTimeout(() => {
      try {
        this.socket.destroy();
      } catch (_) {
        /* ignore */
      }
    }, 50);
    if (timer.unref) timer.unref();
    try {
      this.onClose(reason);
    } catch (_) {
      /* ignore */
    }
  }

  /** Tear the socket down without ceremony and fire onClose exactly once. */
  destroy(reason = "") {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch (_) {
      /* ignore */
    }
    try {
      this.onClose(reason);
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * Accept one HTTP upgrade and turn it into a server-side Channel.
 * Returns null (and answers 400) when the request is not a valid WS upgrade.
 */
function acceptUpgrade(req, socket, head, { maxMessage } = {}) {
  const key = req.headers["sec-websocket-key"];
  const version = req.headers["sec-websocket-version"];
  const upgrade = String(req.headers.upgrade || "").toLowerCase();
  if (upgrade !== "websocket" || !key || String(version) !== "13") {
    try {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
    } catch (_) {
      /* ignore */
    }
    return null;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${frame.acceptKey(key)}\r\n\r\n`
  );
  const channel = new Channel(socket, { mask: false, maxMessage, label: "server" });
  // Bytes the HTTP parser already read past the header boundary: a peer that
  // pipelines its first message into the handshake segment would lose it.
  if (head && head.length) channel.parser.push(head);
  return channel;
}

/**
 * Dial a fleet peer and complete the client half of the handshake.
 *
 * @returns {Promise<Channel>} rejects on connect error, timeout, non-101 or a
 *                             bad Sec-WebSocket-Accept (wrong/stale listener)
 */
function dial({ host, port, resource = protocol.RESOURCE, timeoutMs = 8000, maxMessage } = {}) {
  return new Promise((resolve, reject) => {
    const key = frame.makeKey();
    const expect = frame.acceptKey(key);
    const socket = net.connect({ host, port });
    let settled = false;
    let handshake = false;
    let head = Buffer.alloc(0);

    const timer = setTimeout(() => fail(new Error(`fleet: ${host}:${port} did not answer`)), timeoutMs);
    if (timer.unref) timer.unref();

    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch (_) {
        /* ignore */
      }
      reject(err);
    }

    socket.setNoDelay(true);
    socket.on("connect", () => {
      socket.write(
        `GET ${resource} HTTP/1.1\r\n` +
          `Host: ${host}:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n\r\n"
      );
    });

    socket.on("data", (chunk) => {
      if (handshake || settled) return;
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > 8192) fail(new Error("fleet: oversized handshake response"));
        return;
      }
      const text = head.subarray(0, end).toString("latin1");
      const rest = head.subarray(end + 4);
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(text);
      if (!/^HTTP\/1\.1 101/i.test(text)) {
        fail(new Error(`fleet: ${host}:${port} refused the upgrade`));
        return;
      }
      if (!accept || accept[1] !== expect) {
        fail(new Error(`fleet: ${host}:${port} is not an NX Hub`));
        return;
      }
      handshake = true;
      settled = true;
      clearTimeout(timer);
      // Hand the socket over BEFORE replaying leftovers, so the caller's
      // onText is already attached when the peer pipelined its challenge.
      const channel = new Channel(socket, { mask: true, maxMessage, label: "client" });
      resolve(channel);
      if (rest.length) setImmediate(() => channel.parser.push(rest));
    });

    socket.on("error", (e) => fail(e));
    socket.on("close", () => fail(new Error(`fleet: ${host}:${port} closed the connection`)));
  });
}

/**
 * An http.Server that only exists to parse GET/Upgrade. Anything else gets the
 * RFC 7231 brush-off, which is handy when a human curls the port.
 */
function createHttpServer(onUpgrade) {
  const server = http.createServer((req, res) => {
    res.writeHead(426, { "Content-Type": "text/plain", Connection: "close" });
    res.end("nx-fleet: websocket upgrade required\n");
  });
  server.on("upgrade", onUpgrade);
  server.on("clientError", (_err, socket) => {
    try {
      socket.destroy();
    } catch (_) {
      /* ignore */
    }
  });
  return server;
}

module.exports = { Channel, acceptUpgrade, dial, createHttpServer, frame };
