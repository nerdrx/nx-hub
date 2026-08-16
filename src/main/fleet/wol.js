"use strict";
// NX Hub — fleet: Wake-on-LAN (SPEC v0.7 "WOL + peer MAC").
//
// A magic packet is 102 bytes and has no protocol to speak of: six 0xff bytes,
// then the target's six-byte MAC repeated sixteen times. The NIC's wake logic
// scans every inbound frame for that pattern, which is why the UDP port is
// nearly irrelevant — 9 (discard) and 7 (echo) are the two everyone uses, and
// we send to both because some firmware only arms one.
//
// Three copies, because this is fire-and-forget by nature: a single datagram
// that meets a busy switch is simply gone, and there is no acknowledgement to
// wait for. Nothing here can tell you the machine actually woke up; that is
// what the `peer-online` gate in a stack is for.
//
// `wake()` therefore returns "did the packets leave this host", not "is the
// peer awake". Broadcast is a privilege the socket has to ask for
// (SO_BROADCAST), and a socket that cannot get it is the one real failure
// mode worth reporting.

const dgramModule = require("dgram");

const arp = require("./arp");

/** The two ports every WOL implementation agrees on. */
const WOL_PORTS = [9, 7];
/** Limited broadcast — never routed, which is exactly what we want. */
const BROADCAST_ADDRESS = "255.255.255.255";
/** SPEC: three copies of the packet per port. */
const REPEATS = 3;
const PACKET_BYTES = 102;

/**
 * Build the 102-byte magic packet for one MAC.
 * @throws {Error} when the mac is not six hex pairs
 */
function magicPacket(mac) {
  const clean = arp.normalizeMac(mac);
  if (!clean) throw new Error(`not a usable MAC address: ${mac}`);
  const hw = Buffer.from(clean.replace(/:/g, ""), "hex");
  const packet = Buffer.alloc(PACKET_BYTES, 0xff); // the 6-byte preamble, free
  for (let i = 0; i < 16; i += 1) hw.copy(packet, 6 + i * 6);
  return packet;
}

function noop() {}

/**
 * Send the magic packets for `mac`.
 *
 * @param {string} mac
 * @param {object} [o]
 * @param {string}   [o.address]  where to send — the limited broadcast by
 *                                default; tests inject 127.0.0.1 so nothing
 *                                ever leaves the machine
 * @param {number[]} [o.ports]    defaults to [9, 7]
 * @param {number}   [o.repeats]  defaults to 3
 * @param {object}   [o.dgram]    the dgram module (injectable)
 * @param {function} [o.log]
 * @returns {Promise<boolean>} true when every packet was handed to the socket
 */
function wake(mac, o = {}) {
  const log = typeof o.log === "function" ? o.log : noop;
  let packet;
  try {
    packet = magicPacket(mac);
  } catch (e) {
    log(`wol: ${e.message}`);
    return Promise.resolve(false);
  }

  const address = o.address || BROADCAST_ADDRESS;
  const ports = (Array.isArray(o.ports) && o.ports.length ? o.ports : WOL_PORTS).map(Number).filter(
    (p) => Number.isInteger(p) && p > 0 && p <= 65535
  );
  const repeats = Number.isInteger(o.repeats) && o.repeats > 0 ? o.repeats : REPEATS;
  if (!ports.length) return Promise.resolve(false);
  const dgram = o.dgram || dgramModule;
  const broadcast = address === BROADCAST_ADDRESS || /\.255$/.test(address);

  return new Promise((resolve) => {
    let socket;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch (_) {
        /* already closed */
      }
      resolve(value);
    };

    try {
      socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    } catch (e) {
      log(`wol: could not open a socket — ${e.message}`);
      return resolve(false);
    }

    // An error at ANY point (no broadcast permission, no route, a closed
    // socket) means the packets did not go out — say so rather than lying.
    socket.on("error", (e) => {
      log(`wol: ${e.message}`);
      finish(false);
    });

    socket.bind(() => {
      try {
        if (broadcast) socket.setBroadcast(true);
      } catch (e) {
        log(`wol: SO_BROADCAST refused — ${e.message}`);
        finish(false);
        return;
      }
      let outstanding = ports.length * repeats;
      let failed = false;
      const done = (err) => {
        if (err) {
          failed = true;
          log(`wol: send failed — ${err.message}`);
        }
        outstanding -= 1;
        if (outstanding <= 0) finish(!failed);
      };
      for (const port of ports) {
        for (let i = 0; i < repeats; i += 1) {
          try {
            socket.send(packet, 0, packet.length, port, address, done);
          } catch (e) {
            done(e);
          }
        }
      }
    });
    return undefined;
  });
}

module.exports = { magicPacket, wake, WOL_PORTS, BROADCAST_ADDRESS, REPEATS, PACKET_BYTES };
