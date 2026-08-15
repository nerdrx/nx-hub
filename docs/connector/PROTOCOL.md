# NX Connector — wire protocol

**v0.5 · frozen 2026-08-16**

NX Hub hosts a local rendezvous bus. NX apps announce that they are running,
stream a small live status, and can be asked to shut down politely. The hub
renders that status on app cards and in the tray, and drives multi-app
**stacks** with it.

If you are writing a JavaScript app, do not implement any of this: copy
[`nx-connector.js`](./nx-connector.js) into your repo and call `connect()`.
This document is for everyone else — C++, Rust, Python, C#.

---

## 1. Transport

A plain **RFC 6455 WebSocket** server, no subprotocol, no extensions:

| | |
| --- | --- |
| URL | `ws://127.0.0.1:9021` |
| Binding | loopback only — the bus never listens on a routable interface |
| Frames | **text only**; a binary frame is an error (see §6) |
| Masking | client → hub frames **must** be masked, per RFC 6455 §5.1 |
| Max frame | **16 KB** (16384 bytes of payload) |
| Payload | one JSON object per frame — never several, never a fragment of one |

Any WebSocket library will satisfy this. The handshake is ordinary:

```http
GET / HTTP/1.1
Host: 127.0.0.1:9021
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: <16 random bytes, base64>
Sec-WebSocket-Version: 13
```

The hub replies `101 Switching Protocols` with the usual
`Sec-WebSocket-Accept: base64(sha1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))`.
**Verify it** — it is what distinguishes the hub from some unrelated program
that happens to hold port 9021.

A non-upgrade request to the port gets `426 Upgrade Required`, which is a
convenient way to check by hand whether the bus is up:

```console
$ curl -i http://127.0.0.1:9021
HTTP/1.1 426 Upgrade Required
nx-connector: websocket upgrade required
```

Fragmented messages and WebSocket-level `ping`/`pong` control frames are
accepted (a `ping` is answered with a `pong`), but nothing requires you to send
them. The 16 KB cap applies to a whole reassembled message.

## 2. Authentication

The hub writes a shared secret to `connector.token` in its data directory when
it first starts:

| Platform | Path |
| --- | --- |
| Linux / macOS | `~/.local/share/nx-hub/connector.token` |
| Any | `$NX_HUB_DATA_DIR/connector.token` when that variable is set |

The file is 32 lowercase hex characters, mode `0600`, with a trailing newline —
**trim it**. Present it verbatim in `hello`. The hub compares it in constant
time and closes the socket on a mismatch.

Read the token **on every connection attempt**, not once at startup. Your app
may legitimately start before NX Hub has ever run, in which case the file does
not exist yet; treat that exactly like "no hub is running" and retry later.

## 3. Messages

One JSON object per text frame. Unknown keys are ignored, so the schema can
grow without breaking you.

### Client → hub

| Message | When | Notes |
| --- | --- | --- |
| `{"type":"hello", "app", "version", "pid", "token", "caps":["status"]}` | first message after the handshake | `app` is your app id; the hub lowercases it. `version`, `pid` and `caps` are optional but recommended. |
| `{"type":"status", "fields":{…}}` | whenever your state changes | ≤ 2 KB, ≤ 4/s, merged (see §4). |
| `{"type":"pong"}` | after each `{"type":"ping"}` | keepalive — see §5. |
| `{"type":"bye"}` | you are exiting | optional courtesy; closing the socket says the same thing. |

`hello` must come first. A `status` before it closes the connection.

### Hub → client

| Message | Meaning |
| --- | --- |
| `{"type":"welcome", "hub":"0.5.0"}` | you are on the bus; the value is the hub's version |
| `{"type":"ping"}` | liveness probe — answer with `{"type":"pong"}` |
| `{"type":"shutdown-request"}` | please exit (see §7) |
| `{"type":"error", "message":"…"}` | something you sent was rejected |

A minimal session:

```jsonc
→ {"type":"hello","app":"pulsenx","version":"1.2.1","pid":4242,"token":"a1b2…","caps":["status"]}
← {"type":"welcome","hub":"0.5.0"}
→ {"type":"status","fields":{"hr":72,"connected":true}}
→ {"type":"status","fields":{"hr":75}}
← {"type":"ping"}
→ {"type":"pong"}
→ {"type":"bye"}
```

## 4. Status

`fields` is a flat JSON object of small scalars — numbers, strings, booleans.
Three rules:

1. **It merges.** Each `status` is applied on top of the previous one, per key.
   In the session above the hub ends up holding `{"hr":75,"connected":true}`:
   `connected` survives without being restated. There is no way to delete a key
   short of reconnecting; send `null` if you need to signal "unknown".
2. **≤ 2 KB.** The serialised `fields` object must not exceed 2048 bytes, and
   neither may the merged result. This is status, not telemetry — if you are
   near the limit you are sending the wrong thing. Over the cap earns an
   `error` and a disconnect.
3. **≤ 4 per second.** Excess messages are **dropped silently**: no error, no
   disconnect, they simply never happen. Send state changes, not a sample
   stream, and pre-throttle on your side so you never lose the latest value.

Field names are yours. The hub's app overlay maps known keys to labels and
units (`hr` → "Heart rate", `bpm`); anything unrecognised renders generically as
`key: value`. Keep keys short, stable, lowercase.

## 5. Liveness

Presence on the bus **is** an open socket. There is no separate registration to
expire, and no heartbeat you must send unprompted.

Every **30 s** the hub sends `{"type":"ping"}` to each client. Reply with
`{"type":"pong"}`. Any frame from you — a `status`, a `pong`, a WebSocket-level
control frame — counts as a sign of life.

A client that sends **nothing at all for 90 s** is reaped: the hub drops its
presence slot and closes the socket. An idle app that never sends status is
therefore entirely dependent on answering pings, so answer them.

A socket that never sends `hello` is dropped after 10 s.

## 6. Errors

Everything below earns `{"type":"error","message":"…"}` **immediately followed
by a WebSocket close frame**. Read the error before you act on the close — it
says what you did wrong.

| Condition | Close code |
| --- | --- |
| Bad or missing token, missing app id, `status` before `hello` | 1008 |
| Malformed JSON, non-object message, `fields` not an object, unmasked frame | 1002 |
| Frame over 16 KB, status over 2 KB, merged status over 2 KB or 64 keys | 1009 |
| Binary frame | 1003 |

Two things are deliberately *not* fatal:

- **Exceeding the status rate** — dropped silently, connection kept (§4).
- **An unknown `type`** — you get an `error` describing it, but the connection
  and your presence slot survive. This is what lets a newer app talk to an
  older hub.

## 7. Shutdown requests

When the user stops a stack, the hub sends `{"type":"shutdown-request"}` to each
member app, in reverse launch order. It means *please exit now, cleanly*: save,
release devices, quit.

It is a request, not a kill. If you are still running when the hub's patience
runs out, it falls back to `SIGTERM` on the process it launched — never
`SIGKILL`. Ignoring the request just means a less graceful exit for your user.

## 8. Identity and reconnection

App ids are **lowercased** and one id owns exactly one presence slot. If a
second connection says `hello` with an id that is already present, **the newest
hello wins**: the older socket is closed with a `superseded` reason and the new
one takes the slot, with no gap in presence. This is what makes restarting your
app safe, and it means a stale socket can never lock you out.

Reconnection etiquette, for a client that intends to be well behaved:

- Retry with **exponential backoff, 1 s doubling to 30 s**, forever. Reset to
  1 s after a connection that reached `welcome`.
- **Be silent about it.** No hub running is the normal case on a machine where
  NX Hub is not installed. Do not log, do not warn the user, do not fail your
  own startup.
- Re-read the token on every attempt (§2).
- Do not queue status while disconnected. Status is a live gauge; a backlog of
  stale readings helps nobody. Drop it and send the current value once you are
  back.
- Re-send your full status after reconnecting: the hub starts your slot empty
  again, and merge semantics (§4) mean it has nothing to merge onto.

## 9. Reference

`nx-connector.js` in this directory is the reference implementation — about 250
commented lines of dependency-free CommonJS covering everything above. The hub
side lives in `src/main/connector/` in the nx-hub repo, and the test suite in
`test/connector/` drives the two against each other over real sockets.

Two options on the hub's `init()` — `pingMs` and `reapMs` — exist **only** so
the tests can shrink the 30 s/90 s timers. They are not configuration; nothing
outside `test/connector/` should pass them.
