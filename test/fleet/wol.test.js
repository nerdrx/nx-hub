"use strict";
// v0.7 [fleet-fabric]: reading a peer's MAC out of the ARP cache, and the
// magic packet that wakes it.
//
// The parsers are pure functions over fixture text, so the Windows format is
// tested on Linux and vice versa — the one thing that would otherwise only be
// exercised on the machine we cannot run tests on.
//
// The packets go to 127.0.0.1 on two EPHEMERAL ports, never to the broadcast
// address and never to 9/7 (which are privileged anyway). The broadcast flag
// itself is checked against an injected dgram double, so SO_BROADCAST is
// proven to be requested without a single datagram leaving the machine.

const test = require("node:test");
const assert = require("node:assert");
const dgram = require("node:dgram");

const arp = require("../../src/main/fleet/arp");
const wol = require("../../src/main/fleet/wol");

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

// Exactly the column layout the kernel writes, trailing spaces included.
const PROC_NET_ARP = [
  "IP address       HW type     Flags       HW address            Mask     Device",
  "192.168.1.1      0x1         0x2         3c:84:6a:11:22:33     *        enp5s0",
  "192.168.1.20     0x1         0x2         AA:BB:CC:DD:EE:FF     *        enp5s0",
  "192.168.1.31     0x1         0x0         00:00:00:00:00:00     *        enp5s0",
  "10.0.0.5         0x1         0x6         02:42:ac:11:00:02     *        docker0",
  "",
].join("\n");

const ARP_A = [
  "",
  "Interface: 192.168.1.10 --- 0xb",
  "  Internet Address      Physical Address      Type",
  "  192.168.1.1           3c-84-6a-11-22-33     dynamic",
  "  192.168.1.20          aa-bb-cc-dd-ee-ff     dynamic",
  "  192.168.1.31          00-00-00-00-00-00     invalid",
  "  192.168.1.255         ff-ff-ff-ff-ff-ff     static",
  "",
].join("\r\n");

// A localised Windows still lists the same shapes under different headings.
const ARP_A_DE = [
  "Schnittstelle: 192.168.1.10 --- 0xb",
  "  Internetadresse       Physische Adresse     Typ",
  "  192.168.1.20          AA-BB-CC-DD-EE-FF     dynamisch",
].join("\r\n");

/* ------------------------------------------------------------------ */
/* normalizeMac                                                        */
/* ------------------------------------------------------------------ */

test("normalizeMac accepts every spelling and lands on lowercase colons", () => {
  const want = "aa:bb:cc:dd:ee:ff";
  assert.strictEqual(arp.normalizeMac("AA:BB:CC:DD:EE:FF"), want);
  assert.strictEqual(arp.normalizeMac("aa-bb-cc-dd-ee-ff"), want);
  assert.strictEqual(arp.normalizeMac("AABB.CCDD.EEFF"), want);
  assert.strictEqual(arp.normalizeMac("aabbccddeeff"), want);
  assert.strictEqual(arp.normalizeMac("  aa:bb:cc:dd:ee:ff  "), want);
});

test("normalizeMac refuses what could never wake a machine", () => {
  for (const bad of [
    null,
    undefined,
    "",
    "not a mac",
    "aa:bb:cc:dd:ee",          // five groups
    "aa:bb:cc:dd:ee:ff:00",    // seven
    "gg:bb:cc:dd:ee:ff",       // not hex
    "00:00:00:00:00:00",       // the null address an INCOMPLETE entry shows
    "ff:ff:ff:ff:ff:ff",       // broadcast
  ]) {
    assert.strictEqual(arp.normalizeMac(bad), null, `${bad} must not parse`);
  }
});

test("isMac only likes the canonical form", () => {
  assert.strictEqual(arp.isMac("aa:bb:cc:dd:ee:ff"), true);
  assert.strictEqual(arp.isMac("AA:BB:CC:DD:EE:FF"), false);
  assert.strictEqual(arp.isMac("aabbccddeeff"), false);
});

/* ------------------------------------------------------------------ */
/* /proc/net/arp                                                       */
/* ------------------------------------------------------------------ */

test("/proc/net/arp yields the MAC for the IP we asked about", () => {
  assert.strictEqual(arp.parseProcNetArp(PROC_NET_ARP, "192.168.1.20"), "aa:bb:cc:dd:ee:ff");
  assert.strictEqual(arp.parseProcNetArp(PROC_NET_ARP, "192.168.1.1"), "3c:84:6a:11:22:33");
  assert.strictEqual(arp.parseProcNetArp(PROC_NET_ARP, "10.0.0.5"), "02:42:ac:11:00:02");
});

test("an INCOMPLETE entry (flags 0x0) is a 'not yet', not a MAC", () => {
  assert.strictEqual(arp.parseProcNetArp(PROC_NET_ARP, "192.168.1.31"), null);
  const rows = arp.parseProcNetArp(PROC_NET_ARP);
  const row = rows.find((r) => r.ip === "192.168.1.31");
  assert.strictEqual(row.mac, null);
  assert.strictEqual(row.incomplete, true, "so lookup() knows it is worth asking again");
});

test("the header line and an IP nobody has cached both come back empty", () => {
  assert.strictEqual(arp.parseProcNetArp(PROC_NET_ARP, "IP"), null);
  assert.strictEqual(arp.parseProcNetArp(PROC_NET_ARP, "192.168.99.99"), null);
  assert.strictEqual(arp.parseProcNetArp("", "192.168.1.20"), null);
  assert.strictEqual(arp.parseProcNetArp(null, "192.168.1.20"), null);
});

test("every entry is listed, with its device, when no IP is named", () => {
  const rows = arp.parseProcNetArp(PROC_NET_ARP);
  assert.strictEqual(rows.length, 4, "the header is not an entry");
  assert.deepStrictEqual(
    rows.map((r) => r.ip),
    ["192.168.1.1", "192.168.1.20", "192.168.1.31", "10.0.0.5"]
  );
  assert.strictEqual(rows[3].device, "docker0");
});

/* ------------------------------------------------------------------ */
/* arp -a (win32)                                                      */
/* ------------------------------------------------------------------ */

test("`arp -a` output parses on shape, dashes and all", () => {
  assert.strictEqual(arp.parseArpA(ARP_A, "192.168.1.20"), "aa:bb:cc:dd:ee:ff");
  assert.strictEqual(arp.parseArpA(ARP_A, "192.168.1.1"), "3c:84:6a:11:22:33");
});

test("`arp -a` invalid and broadcast rows are not addresses", () => {
  assert.strictEqual(arp.parseArpA(ARP_A, "192.168.1.31"), null, "the all-zero 'invalid' row");
  assert.strictEqual(arp.parseArpA(ARP_A, "192.168.1.255"), null, "the broadcast row");
});

test("the 'Interface:' heading is not mistaken for an entry", () => {
  const rows = arp.parseArpA(ARP_A);
  assert.ok(!rows.some((r) => r.ip === "192.168.1.10"), "the heading carries an IP but no MAC");
});

test("a localised Windows parses the same, because only the shape is read", () => {
  assert.strictEqual(arp.parseArpA(ARP_A_DE, "192.168.1.20"), "aa:bb:cc:dd:ee:ff");
});

/* ------------------------------------------------------------------ */
/* lookup: platform routing and the retry                              */
/* ------------------------------------------------------------------ */

test("lookup reads /proc/net/arp on linux and `arp -a` on win32", async () => {
  const readFiles = [];
  const linux = await arp.lookup("192.168.1.20", {
    platform: "linux",
    readFile: (file) => {
      readFiles.push(file);
      return Promise.resolve(PROC_NET_ARP);
    },
  });
  assert.strictEqual(linux, "aa:bb:cc:dd:ee:ff");
  assert.deepStrictEqual(readFiles, ["/proc/net/arp"]);

  const commands = [];
  const win = await arp.lookup("192.168.1.20", {
    platform: "win32",
    exec: (cmd, args) => {
      commands.push([cmd, ...args].join(" "));
      return Promise.resolve(ARP_A);
    },
  });
  assert.strictEqual(win, "aa:bb:cc:dd:ee:ff");
  assert.deepStrictEqual(commands, ["arp -a"], "no shell, no flags we did not choose");
});

test("an INCOMPLETE entry is retried, and the answer that arrives is kept", async () => {
  let reads = 0;
  const naps = [];
  const mac = await arp.lookup("192.168.1.31", {
    platform: "linux",
    // The kernel finishes resolving between the first read and the second —
    // exactly the race the retry exists for.
    readFile: () => {
      reads += 1;
      return Promise.resolve(reads === 1 ? PROC_NET_ARP : PROC_NET_ARP.replace("0x0         00:00:00:00:00:00", "0x2         aa:bb:cc:00:11:22"));
    },
    sleep: (ms) => {
      naps.push(ms);
      return Promise.resolve();
    },
  });
  assert.strictEqual(mac, "aa:bb:cc:00:11:22");
  assert.strictEqual(reads, 2);
  assert.deepStrictEqual(naps, [2000], "SPEC: 2s between tries");
});

test("a MAC that never turns up costs exactly three reads and two naps", async () => {
  let reads = 0;
  const naps = [];
  const mac = await arp.lookup("192.168.1.31", {
    platform: "linux",
    readFile: () => {
      reads += 1;
      return Promise.resolve(PROC_NET_ARP);
    },
    sleep: (ms) => {
      naps.push(ms);
      return Promise.resolve();
    },
  });
  assert.strictEqual(mac, null);
  assert.strictEqual(reads, 3, "the first try plus SPEC's two retries");
  assert.deepStrictEqual(naps, [2000, 2000]);
});

test("an unreadable cache is a null, never a throw", async () => {
  const mac = await arp.lookup("192.168.1.20", {
    platform: "linux",
    retries: 0,
    readFile: () => Promise.reject(new Error("EACCES")),
  });
  assert.strictEqual(mac, null);
});

test("loopback is never looked up — a session with ourselves has no ARP entry", async () => {
  let reads = 0;
  for (const ip of ["127.0.0.1", "127.0.1.1", "::1", "", null]) {
    // eslint-disable-next-line no-await-in-loop
    const mac = await arp.lookup(ip, {
      platform: "linux",
      readFile: () => {
        reads += 1;
        return Promise.resolve(PROC_NET_ARP);
      },
    });
    assert.strictEqual(mac, null, `${ip} must not be resolved`);
  }
  assert.strictEqual(reads, 0, "and it does not even open the file");
});

/* ------------------------------------------------------------------ */
/* the magic packet                                                    */
/* ------------------------------------------------------------------ */

test("a magic packet is 6 x 0xff then the MAC, sixteen times", () => {
  const packet = wol.magicPacket("aa:bb:cc:dd:ee:ff");
  assert.strictEqual(packet.length, 102);
  assert.deepStrictEqual([...packet.subarray(0, 6)], [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const hw = Buffer.from("aabbccddeeff", "hex");
  for (let i = 0; i < 16; i += 1) {
    assert.deepStrictEqual(
      packet.subarray(6 + i * 6, 12 + i * 6),
      hw,
      `repetition ${i + 1} of the hardware address`
    );
  }
  // 6 + 16*6 = 102, and nothing else is in there.
  assert.strictEqual(6 + 16 * 6, packet.length);
});

test("magicPacket refuses a MAC it cannot build from", () => {
  assert.throws(() => wol.magicPacket("nope"), /not a usable MAC/);
  assert.throws(() => wol.magicPacket("00:00:00:00:00:00"), /not a usable MAC/);
});

/** Bind a udp4 socket on 127.0.0.1 and collect what lands on it. */
function listener() {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const packets = [];
  socket.on("message", (msg) => packets.push(Buffer.from(msg)));
  return new Promise((resolve) => {
    socket.bind(0, "127.0.0.1", () =>
      resolve({ port: socket.address().port, packets, close: () => socket.close() })
    );
  });
}

test("wake sends three copies of the packet to every port", async () => {
  const a = await listener();
  const b = await listener();
  try {
    const sent = await wol.wake("aa:bb:cc:dd:ee:ff", { address: "127.0.0.1", ports: [a.port, b.port] });
    assert.strictEqual(sent, true);

    // UDP on loopback is reliable but not synchronous — give the datagrams a
    // tick to be delivered before counting them.
    await new Promise((r) => setTimeout(r, 120));

    assert.strictEqual(a.packets.length, wol.REPEATS, "three copies on the first port");
    assert.strictEqual(b.packets.length, wol.REPEATS, "three copies on the second port");
    const expected = wol.magicPacket("aa:bb:cc:dd:ee:ff");
    for (const packet of [...a.packets, ...b.packets]) {
      assert.strictEqual(packet.length, 102);
      assert.deepStrictEqual(packet, expected, "byte for byte, every copy");
    }
  } finally {
    a.close();
    b.close();
  }
});

test("the real call asks for SO_BROADCAST and aims at 255.255.255.255:9 and :7", async () => {
  const sends = [];
  let broadcast = null;
  const fakeDgram = {
    createSocket() {
      const handlers = {};
      return {
        on(event, fn) {
          handlers[event] = fn;
        },
        bind(cb) {
          setImmediate(cb);
        },
        setBroadcast(value) {
          broadcast = value;
        },
        send(buf, offset, length, port, address, cb) {
          sends.push({ port, address, length, packet: Buffer.from(buf) });
          cb(null);
        },
        close() {},
      };
    },
  };

  const sent = await wol.wake("aa:bb:cc:dd:ee:ff", { dgram: fakeDgram });
  assert.strictEqual(sent, true);
  assert.strictEqual(broadcast, true, "SO_BROADCAST, or the packet never leaves the host");
  assert.strictEqual(sends.length, 6, "three copies to each of the two ports");
  assert.deepStrictEqual(
    sends.map((s) => `${s.address}:${s.port}`).sort(),
    ["255.255.255.255:7", "255.255.255.255:7", "255.255.255.255:7", "255.255.255.255:9", "255.255.255.255:9", "255.255.255.255:9"]
  );
  assert.ok(sends.every((s) => s.length === 102));
});

test("a socket that cannot broadcast reports false rather than pretending", async () => {
  const fakeDgram = {
    createSocket() {
      const handlers = {};
      return {
        on(event, fn) {
          handlers[event] = fn;
        },
        bind(cb) {
          setImmediate(cb);
        },
        setBroadcast() {
          throw new Error("EACCES");
        },
        send() {
          assert.fail("nothing may be sent once SO_BROADCAST was refused");
        },
        close() {},
      };
    },
  };
  assert.strictEqual(await wol.wake("aa:bb:cc:dd:ee:ff", { dgram: fakeDgram }), false);
});

test("a send error makes wake false, and a bad MAC never opens a socket", async () => {
  const failing = {
    createSocket() {
      return {
        on() {},
        bind(cb) {
          setImmediate(cb);
        },
        setBroadcast() {},
        send(buf, offset, length, port, address, cb) {
          cb(new Error("ENETUNREACH"));
        },
        close() {},
      };
    },
  };
  assert.strictEqual(await wol.wake("aa:bb:cc:dd:ee:ff", { dgram: failing }), false);

  let opened = 0;
  const counting = {
    createSocket() {
      opened += 1;
      return { on() {}, bind() {}, setBroadcast() {}, send() {}, close() {} };
    },
  };
  assert.strictEqual(await wol.wake("not-a-mac", { dgram: counting }), false);
  assert.strictEqual(opened, 0);
});
