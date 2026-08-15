"use strict";
// NX Hub — connector: RFC 6455 frame codec (SPEC "NX Connector" v0.5).
//
// Hand-rolled, zero dependencies. This is the transport layer under
// src/main/connector/server.js. Only the subset the connector needs:
//
//   * text frames (0x1), binary (0x2) recognised so it can be rejected
//   * close (0x8), ping (0x9), pong (0xA)
//   * continuation frames (0x0) — assembled, with the message cap enforced
//     across the whole message, not just the individual frame
//   * client -> server frames are ALWAYS masked (RFC 6455 §5.1); an unmasked
//     one is a protocol error and the parser reports it
//
// Extended payload lengths above 2^32-1 are refused outright — the connector
// caps messages at 16 KB, so a length that large is either a broken client or
// an attempt to make us allocate.
//
// Pure node: no electron require anywhere in this file.

const crypto = require("crypto");

/** The RFC 6455 handshake GUID — appended to Sec-WebSocket-Key before SHA-1. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

// Close codes we actually use.
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_UNSUPPORTED_DATA = 1003;
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_TOO_LARGE = 1009;

/** Sec-WebSocket-Accept for a client's Sec-WebSocket-Key. */
function acceptKey(key) {
  return crypto
    .createHash("sha1")
    .update(String(key) + WS_GUID)
    .digest("base64");
}

/** A fresh client-side Sec-WebSocket-Key (16 random bytes, base64). */
function makeKey() {
  return crypto.randomBytes(16).toString("base64");
}

/**
 * Encode one frame.
 * @param {number} opcode
 * @param {Buffer} payload
 * @param {boolean} mask  true for client -> server (RFC 6455 requires it)
 */
function encode(opcode, payload, mask = false) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ""));
  const len = body.length;

  let lenBytes = 0;
  if (len >= 65536) lenBytes = 8;
  else if (len >= 126) lenBytes = 2;

  const header = Buffer.alloc(2 + lenBytes + (mask ? 4 : 0));
  header[0] = 0x80 | (opcode & 0x0f); // FIN=1, RSV=0 — we never fragment on send
  const maskBit = mask ? 0x80 : 0x00;

  if (lenBytes === 0) {
    header[1] = maskBit | len;
  } else if (lenBytes === 2) {
    header[1] = maskBit | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header[1] = maskBit | 127;
    // Lengths never exceed 2^32-1 here, so the high word is always zero.
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }

  if (!mask) return Buffer.concat([header, body], header.length + len);

  const key = crypto.randomBytes(4);
  key.copy(header, 2 + lenBytes);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) masked[i] = body[i] ^ key[i & 3];
  return Buffer.concat([header, masked], header.length + len);
}

const text = (s, mask) => encode(OP_TEXT, Buffer.from(String(s), "utf8"), mask);
const pong = (payload, mask) => encode(OP_PONG, payload || Buffer.alloc(0), mask);

/** A close frame carrying `code` and an optional short reason. */
function close(code = CLOSE_NORMAL, reason = "", mask = false) {
  const reasonBuf = Buffer.from(String(reason || ""), "utf8").subarray(0, 123);
  const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);
  return encode(OP_CLOSE, payload, mask);
}

/**
 * Incremental frame parser.
 *
 * Feed it socket chunks with push(); it invokes the callbacks in order:
 *   onMessage(opcode, payload)  — a complete (possibly reassembled) message
 *   onControl(opcode, payload)  — close / ping / pong, never fragmented
 *   onError(code, message)      — protocol violation; the caller should close
 *
 * After onError the parser latches shut and ignores further input, so one bad
 * client cannot keep generating work while the socket is being torn down.
 */
class Parser {
  /**
   * @param {object} opts
   * @param {boolean} opts.requireMask  true on the server (clients must mask),
   *                                    false on the client (servers must not)
   * @param {number}  opts.maxMessage   byte cap across a whole message
   */
  constructor(opts = {}) {
    this.requireMask = opts.requireMask !== false;
    this.maxMessage = opts.maxMessage || 16 * 1024;
    this.onMessage = opts.onMessage || (() => {});
    this.onControl = opts.onControl || (() => {});
    this.onError = opts.onError || (() => {});
    this.buf = Buffer.alloc(0);
    this.fragments = null; // Buffer[] while a fragmented message is in flight
    this.fragmentOpcode = 0;
    this.fragmentSize = 0;
    this.dead = false;
  }

  fail(code, message) {
    if (this.dead) return;
    this.dead = true;
    this.buf = Buffer.alloc(0);
    this.fragments = null;
    this.onError(code, message);
  }

  push(chunk) {
    if (this.dead) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // A single chunk can carry several frames; drain until one is incomplete.
    while (!this.dead && this.step());
  }

  /** Parse one frame if the buffer holds a whole one. Returns true if it did. */
  step() {
    const buf = this.buf;
    if (buf.length < 2) return false;

    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;

    if (rsv !== 0) {
      this.fail(CLOSE_PROTOCOL_ERROR, "reserved bits set");
      return false;
    }
    if (masked !== this.requireMask) {
      this.fail(
        CLOSE_PROTOCOL_ERROR,
        this.requireMask ? "client frames must be masked" : "server frames must not be masked"
      );
      return false;
    }

    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return false;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return false;
      const high = buf.readUInt32BE(offset);
      if (high !== 0) {
        this.fail(CLOSE_TOO_LARGE, "payload too large");
        return false;
      }
      len = buf.readUInt32BE(offset + 4);
      offset += 8;
    }

    const isControl = (opcode & 0x08) !== 0;
    if (isControl) {
      // RFC 6455 §5.5: control frames are <=125 bytes and never fragmented.
      if (len > 125 || !fin) {
        this.fail(CLOSE_PROTOCOL_ERROR, "invalid control frame");
        return false;
      }
    } else if (len > this.maxMessage || this.fragmentSize + len > this.maxMessage) {
      // Refuse before buffering the body — the point of the cap is to not
      // allocate for an oversized message in the first place.
      this.fail(CLOSE_TOO_LARGE, "message too large");
      return false;
    }

    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) return false; // wait for more

    let payload;
    if (masked) {
      const key = buf.subarray(offset, offset + 4);
      const start = offset + 4;
      payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i += 1) payload[i] = buf[start + i] ^ key[i & 3];
    } else {
      payload = Buffer.from(buf.subarray(offset, offset + len));
    }

    this.buf = buf.subarray(offset + maskLen + len);

    if (isControl) {
      this.onControl(opcode, payload);
      return true;
    }

    if (opcode === OP_CONTINUATION) {
      if (!this.fragments) {
        this.fail(CLOSE_PROTOCOL_ERROR, "continuation without start");
        return false;
      }
      this.fragments.push(payload);
      this.fragmentSize += len;
      if (!fin) return true;
      const whole = Buffer.concat(this.fragments, this.fragmentSize);
      const op = this.fragmentOpcode;
      this.fragments = null;
      this.fragmentSize = 0;
      this.onMessage(op, whole);
      return true;
    }

    if (opcode !== OP_TEXT && opcode !== OP_BINARY) {
      this.fail(CLOSE_PROTOCOL_ERROR, `unknown opcode ${opcode}`);
      return false;
    }
    if (this.fragments) {
      this.fail(CLOSE_PROTOCOL_ERROR, "interleaved message");
      return false;
    }

    if (fin) {
      this.onMessage(opcode, payload);
      return true;
    }
    this.fragments = [payload];
    this.fragmentOpcode = opcode;
    this.fragmentSize = len;
    return true;
  }
}

module.exports = {
  WS_GUID,
  OP_CONTINUATION,
  OP_TEXT,
  OP_BINARY,
  OP_CLOSE,
  OP_PING,
  OP_PONG,
  CLOSE_NORMAL,
  CLOSE_PROTOCOL_ERROR,
  CLOSE_UNSUPPORTED_DATA,
  CLOSE_POLICY_VIOLATION,
  CLOSE_TOO_LARGE,
  acceptKey,
  makeKey,
  encode,
  text,
  pong,
  close,
  Parser,
};
