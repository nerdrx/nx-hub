"use strict";
// NX Hub — fleet: an authenticated session over one Channel.
//
// Once the HMAC challenge-response is done, EVERY message in both directions
// is an envelope {seq, mac, body} (see protocol.encodeEnvelope). This class
// owns the two counters that make that meaningful:
//
//   * `outSeq` — our own strictly increasing sequence, one per sent message
//   * `inSeq`  — the highest sequence we have accepted from the peer
//
// A message that fails its MAC, or repeats/rewinds a sequence number, is not
// "ignored": the session is closed. There is no legitimate way to produce one,
// so the only thing on the other end of such a frame is a bug or an attacker,
// and neither deserves a second attempt on a live channel.

const frame = require("../connector/frame");
const protocol = require("./protocol");

class Session {
  /**
   * @param {object} o
   * @param {import("./wire").Channel} o.channel
   * @param {string} o.secret     the pairing-derived shared secret
   * @param {string} o.peerId
   * @param {string} [o.peerName]
   * @param {string} [o.host]
   * @param {number} [o.port]
   * @param {"server"|"client"} [o.role]
   * @param {function} [o.log]
   */
  constructor({ channel, secret, peerId, peerName = "", host = "", port = null, role = "client", log } = {}) {
    this.channel = channel;
    this.secret = secret;
    this.peerId = peerId;
    this.peerName = peerName || peerId;
    this.host = host;
    this.port = port;
    this.role = role;
    this.log = typeof log === "function" ? log : () => {};
    this.openedAt = Date.now();
    this.lastSeen = this.openedAt;
    this.outSeq = 0;
    this.inSeq = 0;
    this.closed = false;
    /** Set by the owner: (payload, session) => void */
    this.onPayload = () => {};
    /** Set by the owner: (reason, session) => void */
    this.onClose = () => {};

    channel.onText = (text) => this.receive(text);
    channel.onClose = (reason) => this.finish(reason || "socket closed");
  }

  get alive() {
    return !this.closed && !this.channel.closed;
  }

  /** Send one payload object. Returns false when the channel is gone. */
  send(payload) {
    if (!this.alive) return false;
    this.outSeq += 1;
    return this.channel.send(protocol.encodeEnvelope(this.secret, this.outSeq, payload));
  }

  /** One inbound frame. Any violation closes the session. */
  receive(text) {
    if (!this.alive) return;
    const result = protocol.decodeEnvelope(this.secret, text, { lastSeq: this.inSeq });
    if (!result.ok) {
      this.log(`fleet: ${this.peerId} sent a bad message (${result.reason}) — closing`);
      this.close(frame.CLOSE_POLICY_VIOLATION, result.reason);
      return;
    }
    this.inSeq = result.seq;
    this.lastSeen = Date.now();
    try {
      this.onPayload(result.payload, this);
    } catch (e) {
      this.log(`fleet: handling ${result.payload.type} from ${this.peerId} failed — ${e.message}`);
    }
  }

  close(code = frame.CLOSE_NORMAL, reason = "") {
    if (this.closed) {
      return;
    }
    this.channel.close(code, reason);
    this.finish(reason || "closed");
  }

  /** Internal: fire onClose exactly once, whoever hung up first. */
  finish(reason) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.onClose(reason, this);
    } catch (_) {
      /* a listener must never break teardown */
    }
  }

  /** What getPeers() shows about a live session. */
  describe() {
    return {
      peerId: this.peerId,
      role: this.role,
      host: this.host,
      port: this.port,
      since: this.openedAt,
      lastSeen: this.lastSeen,
      sent: this.outSeq,
      received: this.inSeq,
    };
  }
}

module.exports = { Session };
