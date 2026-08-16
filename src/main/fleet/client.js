"use strict";
// NX Hub — fleet: the dialling half.
//
// Used by TWO callers, which is why it lives apart from index.js:
//   * the hub, when session arbitration says this side dials (protocol.shouldDial)
//   * the `nx fleet …` CLI, which talks to peers DIRECTLY from its own process
//     and never needs a local hub to be running
//
// Both get the same thing back: an authenticated, sequenced Session.

const protocol = require("./protocol");
const wire = require("./wire");
const { Session } = require("./session");

const frame = wire.frame;

/**
 * Collect the plain (pre-session) JSON messages a channel delivers, and let
 * callers await the next one. Everything before the promotion is unsequenced,
 * so a tiny inbox is all the state we need.
 */
function plainInbox(channel) {
  const queue = [];
  const waiters = [];
  let failure = null;

  channel.onText = (text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (_) {
      msg = null;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      settleAll(new Error("fleet: the peer sent a malformed handshake message"));
      return;
    }
    if (waiters.length) waiters.shift().resolve(msg);
    else queue.push({ raw: text, msg });
  };
  channel.onClose = (reason) => settleAll(new Error(`fleet: the peer hung up (${reason || "closed"})`));

  function settleAll(err) {
    failure = failure || err;
    while (waiters.length) waiters.shift().reject(failure);
  }

  return {
    next(timeoutMs = 8000) {
      if (queue.length) return Promise.resolve(queue.shift().msg);
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === resolve);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error("fleet: the peer went quiet during the handshake"));
        }, timeoutMs);
        if (timer.unref) timer.unref();
        waiters.push({
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
      });
    },
    /**
     * Detach, and hand back anything still queued.
     *
     * This matters more than it looks. A peer writes `ready` and its first
     * sequenced message in the same tick, so both usually arrive in ONE TCP
     * segment and the frame parser delivers them in ONE synchronous loop — by
     * which time our `await` on `ready` has not resumed yet (promises settle
     * on the microtask queue). The second message therefore lands here, in the
     * handshake inbox, and would be silently lost. The caller replays these
     * into the Session instead.
     */
    release() {
      channel.onText = () => {};
      channel.onClose = () => {};
      const rest = queue.splice(0, queue.length).map((entry) => entry.raw);
      return rest;
    },
  };
}

function plainSend(channel, obj) {
  return channel.send(JSON.stringify(obj));
}

/** A peer's `error` reply, turned into something a human can read. */
function peerError(msg, fallback) {
  if (msg && msg.type === "error" && msg.message) return new Error(String(msg.message));
  return new Error(fallback);
}

/**
 * Dial a paired peer and complete the HMAC challenge-response.
 *
 * @param {object} o
 * @param {string} o.host
 * @param {number} o.port
 * @param {string} o.localId   this hub's id (the `id` the MAC is computed over)
 * @param {object} o.peer      {id, name, secret}
 * @param {number} [o.timeoutMs]
 * @param {function} [o.log]
 * @returns {Promise<Session>}
 */
async function connect({ host, port, localId, peer, timeoutMs = 8000, log } = {}) {
  if (!peer || !peer.secret) throw new Error("fleet: that peer has no stored secret — pair again");
  const channel = await wire.dial({ host, port, timeoutMs, maxMessage: protocol.MAX_MESSAGE });
  const inbox = plainInbox(channel);

  try {
    const challenge = await inbox.next(timeoutMs);
    if (challenge.type !== "challenge" || typeof challenge.nonce !== "string" || challenge.nonce.length < 16) {
      throw peerError(challenge, "fleet: the peer did not offer a challenge");
    }
    // The peer proves nothing yet — it is the `ready` id check below, against
    // a nonce only OUR side chose to answer, that binds this socket to the
    // hub we think we dialled.
    plainSend(channel, {
      type: "auth",
      id: localId,
      mac: protocol.authMac(peer.secret, challenge.nonce, localId),
    });

    const ready = await inbox.next(timeoutMs);
    if (ready.type !== "ready") throw peerError(ready, "fleet: the peer rejected our credentials");
    if (peer.id && ready.id && ready.id !== peer.id) {
      throw new Error(`fleet: ${host}:${port} answers as ${ready.id}, not ${peer.id}`);
    }

    const leftovers = inbox.release();
    const session = new Session({
      channel,
      secret: peer.secret,
      peerId: peer.id,
      peerName: ready.name || peer.name || peer.id,
      host,
      port,
      role: "client",
      log,
    });
    // Anything the peer pipelined behind `ready` (its opening summary, almost
    // always) is fed through the session now that it exists — after the caller
    // has had a chance to attach onPayload, hence the deferral.
    if (leftovers.length) {
      setImmediate(() => {
        for (const text of leftovers) {
          if (!session.alive) break;
          session.receive(text);
        }
      });
    }
    return session;
  } catch (e) {
    try {
      channel.close(frame.CLOSE_NORMAL, "handshake failed");
    } catch (_) {
      /* ignore */
    }
    throw e;
  }
}

/**
 * The initiator half of pairing: one message, one answer, then hang up.
 * Both sides derive secret = sha256(code + initiatorId + responderId).
 *
 * @returns {Promise<{id, name, host, port, secret, lastSeen}>} the peer to store
 */
async function pairWith({ host, port, code, localId, localName = "", localPort = protocol.FLEET_PORT, timeoutMs = 8000 } = {}) {
  if (!protocol.isCode(String(code || ""))) throw new Error("A pairing code is six digits.");
  if (!protocol.isId(localId)) throw new Error("fleet: this hub has no id yet");

  const channel = await wire.dial({ host, port, timeoutMs, maxMessage: protocol.MAX_MESSAGE });
  const inbox = plainInbox(channel);
  try {
    const challenge = await inbox.next(timeoutMs);
    if (challenge.type !== "challenge") throw peerError(challenge, "fleet: that is not an NX Hub fleet port");

    plainSend(channel, { type: "pair", code: String(code), id: localId, name: localName, port: localPort });

    const answer = await inbox.next(timeoutMs);
    if (answer.type !== "paired") throw peerError(answer, "fleet: pairing was refused");
    if (!protocol.isId(answer.id)) throw new Error("fleet: the peer sent no usable id");

    const peerPort = Number(answer.port);
    return {
      id: answer.id,
      name: typeof answer.name === "string" && answer.name.trim() ? answer.name.trim().slice(0, 64) : answer.id,
      host,
      port: Number.isInteger(peerPort) && peerPort > 0 && peerPort <= 65535 ? peerPort : port,
      secret: protocol.deriveSecret(String(code), localId, answer.id),
      lastSeen: Date.now(),
    };
  } finally {
    inbox.release();
    try {
      channel.close(frame.CLOSE_NORMAL, "paired");
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = { connect, pairWith, plainInbox };
