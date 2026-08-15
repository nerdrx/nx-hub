"use strict";
// RFC 6455 codec — the transport under the connector bus.

const test = require("node:test");
const assert = require("node:assert");

const frame = require("../../src/main/connector/frame");

/** Collect what a Parser makes of `bytes`. */
function parse(bytes, opts = {}) {
  const messages = [];
  const controls = [];
  const errors = [];
  const parser = new frame.Parser(
    Object.assign(
      {
        onMessage: (opcode, payload) => messages.push({ opcode, payload }),
        onControl: (opcode, payload) => controls.push({ opcode, payload }),
        onError: (code, message) => errors.push({ code, message }),
      },
      opts
    )
  );
  parser.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  return { messages, controls, errors, parser };
}

test("acceptKey matches the RFC 6455 §1.3 vector", () => {
  assert.strictEqual(frame.acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("makeKey is 16 random bytes of base64", () => {
  const a = frame.makeKey();
  assert.strictEqual(Buffer.from(a, "base64").length, 16);
  assert.notStrictEqual(a, frame.makeKey());
});

test("a masked client text frame round-trips", () => {
  const { messages, errors } = parse(frame.text("hello bus", true));
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].opcode, frame.OP_TEXT);
  assert.strictEqual(messages[0].payload.toString("utf8"), "hello bus");
});

test("masking actually obscures the payload on the wire", () => {
  const wire = frame.text("secretpayload", true);
  assert.ok((wire[1] & 0x80) !== 0, "mask bit must be set");
  assert.strictEqual(wire.includes(Buffer.from("secretpayload")), false);
});

test("an unmasked client frame is a protocol error", () => {
  const { messages, errors } = parse(frame.text("nope", false));
  assert.strictEqual(messages.length, 0);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].code, frame.CLOSE_PROTOCOL_ERROR);
  assert.match(errors[0].message, /masked/);
});

test("a masked server frame is a protocol error on the client side", () => {
  const { errors } = parse(frame.text("nope", true), { requireMask: false });
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /must not be masked/);
});

test("the 16-bit and 64-bit length paths both round-trip", () => {
  for (const size of [125, 126, 200, 65535, 65536, 70000]) {
    const body = "x".repeat(size);
    const { messages, errors } = parse(frame.text(body, true), { maxMessage: 128 * 1024 });
    assert.deepStrictEqual(errors, [], `size ${size} errored`);
    assert.strictEqual(messages[0].payload.length, size);
  }
});

test("a message over the cap is refused (and the parser latches shut)", () => {
  const big = frame.text("x".repeat(17 * 1024), true);
  const { messages, errors, parser } = parse(big);
  assert.strictEqual(messages.length, 0);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].code, frame.CLOSE_TOO_LARGE);
  // Latched: further input is ignored rather than generating more work.
  parser.push(frame.text("after", true));
  assert.strictEqual(messages.length, 0);
  assert.strictEqual(errors.length, 1);
});

test("an over-cap length is refused before the body arrives", () => {
  // 64-bit length header claiming 1 MB, with no payload behind it at all.
  const header = Buffer.alloc(14);
  header[0] = 0x81;
  header[1] = 0x80 | 127;
  header.writeUInt32BE(0, 2);
  header.writeUInt32BE(1024 * 1024, 6);
  const { errors } = parse(header);
  assert.strictEqual(errors.length, 1, "must reject on the header alone");
  assert.strictEqual(errors[0].code, frame.CLOSE_TOO_LARGE);
});

test("a 2^32-scale length is refused outright", () => {
  const header = Buffer.alloc(14);
  header[0] = 0x81;
  header[1] = 0x80 | 127;
  header.writeUInt32BE(1, 2); // high word non-zero
  header.writeUInt32BE(0, 6);
  const { errors } = parse(header);
  assert.strictEqual(errors[0].code, frame.CLOSE_TOO_LARGE);
});

test("fragmented text is reassembled", () => {
  // "nx" + "-hub" sent as start(fin=0) + continuation(fin=1), both masked.
  const start = frame.encode(frame.OP_TEXT, Buffer.from("nx"), true);
  start[0] &= 0x7f; // clear FIN
  const cont = frame.encode(frame.OP_CONTINUATION, Buffer.from("-hub"), true);
  const { messages, errors } = parse(Buffer.concat([start, cont]));
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].payload.toString("utf8"), "nx-hub");
  assert.strictEqual(messages[0].opcode, frame.OP_TEXT);
});

test("fragments are capped across the whole message, not per frame", () => {
  const start = frame.encode(frame.OP_TEXT, Buffer.from("x".repeat(10 * 1024)), true);
  start[0] &= 0x7f;
  const cont = frame.encode(frame.OP_CONTINUATION, Buffer.from("x".repeat(10 * 1024)), true);
  const { messages, errors } = parse(Buffer.concat([start, cont]));
  assert.strictEqual(messages.length, 0);
  assert.strictEqual(errors[0].code, frame.CLOSE_TOO_LARGE);
});

test("a continuation without a start is a protocol error", () => {
  const { errors } = parse(frame.encode(frame.OP_CONTINUATION, Buffer.from("orphan"), true));
  assert.strictEqual(errors[0].code, frame.CLOSE_PROTOCOL_ERROR);
  assert.match(errors[0].message, /continuation without start/);
});

test("a new message interleaved into a fragment sequence is rejected", () => {
  const start = frame.encode(frame.OP_TEXT, Buffer.from("a"), true);
  start[0] &= 0x7f;
  const { errors } = parse(Buffer.concat([start, frame.text("b", true)]));
  assert.match(errors[0].message, /interleaved/);
});

test("reserved bits are rejected", () => {
  const wire = frame.text("hi", true);
  wire[0] |= 0x40; // RSV1
  const { errors } = parse(wire);
  assert.match(errors[0].message, /reserved/);
});

test("control frames must be short and unfragmented", () => {
  const long = frame.encode(frame.OP_PING, Buffer.alloc(126), true);
  assert.match(parse(long).errors[0].message, /invalid control frame/);

  const split = frame.encode(frame.OP_PING, Buffer.from("x"), true);
  split[0] &= 0x7f; // FIN cleared on a control frame
  assert.match(parse(split).errors[0].message, /invalid control frame/);
});

test("an unknown opcode is rejected", () => {
  const { errors } = parse(frame.encode(0x3, Buffer.from("?"), true));
  assert.match(errors[0].message, /unknown opcode/);
});

test("close frames carry a code and a reason", () => {
  const { controls } = parse(frame.close(frame.CLOSE_TOO_LARGE, "too big", true));
  assert.strictEqual(controls.length, 1);
  assert.strictEqual(controls[0].opcode, frame.OP_CLOSE);
  assert.strictEqual(controls[0].payload.readUInt16BE(0), 1009);
  assert.strictEqual(controls[0].payload.subarray(2).toString("utf8"), "too big");
});

test("a close reason is clipped to the 125-byte control budget", () => {
  const wire = frame.close(frame.CLOSE_NORMAL, "r".repeat(400), true);
  const { controls, errors } = parse(wire);
  assert.deepStrictEqual(errors, []);
  assert.ok(controls[0].payload.length <= 125);
});

test("ping and pong survive the round trip", () => {
  const { controls } = parse(Buffer.concat([frame.encode(frame.OP_PING, Buffer.from("p"), true), frame.pong(Buffer.from("q"), true)]));
  assert.deepStrictEqual(
    controls.map((c) => [c.opcode, c.payload.toString()]),
    [
      [frame.OP_PING, "p"],
      [frame.OP_PONG, "q"],
    ]
  );
});

test("several frames in one chunk are all drained", () => {
  const chunk = Buffer.concat([frame.text("one", true), frame.text("two", true), frame.text("three", true)]);
  const { messages } = parse(chunk);
  assert.deepStrictEqual(
    messages.map((m) => m.payload.toString()),
    ["one", "two", "three"]
  );
});

test("a frame split across chunks is buffered until complete", () => {
  const wire = frame.text("split me down the middle", true);
  const messages = [];
  const parser = new frame.Parser({ onMessage: (_op, p) => messages.push(p.toString()) });
  for (let i = 0; i < wire.length; i += 1) parser.push(wire.subarray(i, i + 1));
  assert.deepStrictEqual(messages, ["split me down the middle"]);
});

test("binary frames parse (the bus rejects them a layer up)", () => {
  const { messages, errors } = parse(frame.encode(frame.OP_BINARY, Buffer.from([1, 2, 3]), true));
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(messages[0].opcode, frame.OP_BINARY);
});

test("utf-8 payloads keep their bytes", () => {
  const s = "ünïcøde ✓ 72 bpm";
  const { messages } = parse(frame.text(s, true));
  assert.strictEqual(messages[0].payload.toString("utf8"), s);
});
