// Settle one contested claim with a measurement instead of an argument:
// does a Rust peer that writes BARE arguments (exactly what
// src-tauri/src/kkrpc_peer.rs does today) actually interoperate with real
// kkrpc 2.1.0 — and can that same peer participate in kkrpc STREAMING?
//
// A research report asserted "your peer's a:[...] passthrough is wrong even for
// non-streaming calls, because every argument is wrapped in
// {__kkrpc_next_arg__:"value",v:...}". The local source says kkrpc's decodeArgs
// leaves a NON-envelope arg untouched. Those cannot both decide the outcome, so
// this script runs the real library and reports what happens.
//
// The "Rust" side below is deliberately a hand-written frame codec with no kkrpc
// import on the sending path: it writes the same compact frames
// src-tauri/src/kkrpc_peer.rs writes, so a pass here is evidence about THAT
// code, not about kkrpc calling itself.

import { StreamingRPCChannel } from "kkrpc/streaming"

// --- an in-memory transport pair that JSON-round-trips every frame, which is
// --- what stdio does (kkrpc/stdio is jsonLineCodec over newline-split text).
function pair() {
  let leftListener = () => {}
  let rightListener = () => {}
  const wire = (message) => JSON.parse(JSON.stringify(message))
  const left = {
    capabilities: { objectMode: false, transfer: false, remoteRefs: true },
    send: (message) => {
      queueMicrotask(() => rightListener(wire(message)))
    },
    subscribe: (listener) => {
      leftListener = listener
      return () => {}
    },
  }
  const right = {
    capabilities: { objectMode: false, transfer: false, remoteRefs: true },
    send: (message) => {
      queueMicrotask(() => leftListener(wire(message)))
    },
    subscribe: (listener) => {
      rightListener = listener
      return () => {}
    },
  }
  return { left, right }
}

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`   ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}

async function main() {
  const { left, right } = pair()

  // ---- the brain: real kkrpc, exposing a streaming method and an echo -----
  let sawArgOnBrain = null
  const brain = new StreamingRPCChannel(right, {
    expose: {
      math: {
        // A plain method. If bare args were rejected this would receive the
        // envelope object instead of the number.
        add(a, b) {
          sawArgOnBrain = [a, b]
          return a + b
        },
      },
      logs: {
        // A streaming method: returns an AsyncIterable, which kkrpc turns into
        // a stream-ref envelope in the reply.
        async *tail(count, chunk) {
          for (let i = 0; i < count; i++) {
            yield { seq: i, chunk }
          }
        },
      },
    },
  })

  // ---- the hands: hand-written compact frames, NO kkrpc on the send path --
  const pending = new Map()
  const streams = new Map()
  let nextId = 1
  const genId = (prefix) => `${prefix}-${nextId++}`

  // Mirror of src-tauri/src/kkrpc_peer.rs#unwrap_arg.
  const unwrapArg = (value) =>
    value && value.__kkrpc_next_arg__ === "value" ? value.v : value

  // The hand-written side's own exposed methods, so the brain can call back into
  // it (the two-way bridge is the whole point). Keyed the same way Rust keys
  // `peer.on("shell.notify", ...)`.
  const handlers = new Map()
  const expose = (name, fn) => handlers.set(name, fn)

  left.subscribe((message) => {
    if (message.t === "q") {
      // Inbound request FROM the brain TO the hands. This is the direction that
      // exercises unwrap_arg, exactly as the Rust peer's `dispatch` does.
      const method = (message.p ?? []).join(".")
      const args = (message.a ?? []).map(unwrapArg)
      const handler = handlers.get(method)
      const reply = handler
        ? { t: "r", id: message.id, v: handler(...args) }
        : { t: "r", id: message.id, e: { m: `unknown RPC method: ${method}` } }
      left.send(reply)
      return
    }
    if (message.t === "r") {
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      message.e ? waiter.reject(new Error(message.e.m)) : waiter.resolve(message.v)
      return
    }
    if (message.t === "sr") {
      const stream = streams.get(message.sid)
      if (!stream) return
      if (message.e) {
        stream.reject(new Error(message.e.m))
        streams.delete(message.sid)
        return
      }
      if (message.d) {
        stream.finish()
        streams.delete(message.sid)
        return
      }
      stream.push(message.v)
    }
  })

  const call = (method, args = []) =>
    new Promise((resolve, reject) => {
      const id = genId("r")
      pending.set(id, { resolve, reject })
      // BARE args — exactly what the production Rust peer writes.
      left.send({ t: "q", id, op: "call", p: method.split("."), a: args })
    })

  // A hands-side method, so the brain can call INTO the hands. This is the
  // direction where kkrpc wraps args in `__kkrpc_next_arg__` envelopes, i.e. the
  // direction `unwrap_arg` exists for.
  expose("hands.echo", (value) => ({ got: value, wasNumber: typeof value === "number" }))

  // Consume a stream the way a Rust peer must: send one pull for credit, and
  // treat every non-terminal `sr` as one value.
  const consume = (sid, credit = 32) =>
    new Promise((resolve, reject) => {
      const values = []
      streams.set(sid, {
        push: (value) => values.push(value),
        finish: () => resolve(values),
        reject,
      })
      left.send({ t: "sq", id: genId("sq"), sid, op: "pull", n: credit })
    })

  console.log("Real kkrpc 2.1.0 StreamingRPCChannel behind a JSON transport.\n")

  // ---- 1. bare (unwrapped) arguments, Rust -> JS --------------------------
  console.log("1. Bare arguments Rust -> JS (the contested claim)")
  const sum = await call("math.add", [2, 3])
  record(
    "bare args reach the JS handler unwrapped",
    sum === 5 && sawArgOnBrain?.[0] === 2 && sawArgOnBrain?.[1] === 3,
    `add(2,3) = ${sum}; handler saw ${JSON.stringify(sawArgOnBrain)}`,
  )

  // ---- 2. the INBOUND envelope path (what unwrap_arg exists for) ---------
  // kkrpc wraps args when IT is the caller, so a brain->hands call arrives with
  // `{__kkrpc_next_arg__:"value",v:...}` envelopes. `unwrapArg` must strip them.
  const echoed = await brain.getAPI().hands.echo(42)
  record(
    "brain -> hands call: unwrap_arg strips the envelope",
    echoed?.got === 42 && echoed?.wasNumber === true,
    `hands saw ${JSON.stringify(echoed)}`,
  )

  // ---- 3. streaming with a hand-written peer ------------------------------
  console.log("\n2. Streaming: JS producer -> hand-written Rust-shaped consumer")
  const ref = await call("logs.tail", [5, "chunk-bytes"])
  record(
    "reply value is a stream-ref envelope, not data",
    ref && ref.__kkrpc_next_stream__ === "async-iterable" && typeof ref.id === "string",
    JSON.stringify(ref),
  )
  const values = await consume(ref.id, 32)
  record(
    "all 5 values delivered after one pull(n=32)",
    values.length === 5 && values.every((v, i) => v.seq === i),
    `${values.length} values: ${JSON.stringify(values.map((v) => v.seq))}`,
  )

  // ---- 4. binary through the stream, as base64 ---------------------------
  console.log("\n3. Binary through a stream")
  const payload = new Uint8Array(4096)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff
  const b64 = Buffer.from(payload).toString("base64")
  const binRef = await call("logs.tail", [1, b64])
  const [wrapped] = await consume(binRef.id, 32)
  const decoded = Buffer.from(wrapped.chunk, "base64")
  let exact = decoded.length === payload.length
  if (exact) for (let i = 0; i < payload.length; i++) if (decoded[i] !== payload[i]) { exact = false; break }
  record("4096 bytes survive as base64", exact, `${decoded.length} bytes, exact=${exact}`)

  // ---- 5. what a raw Uint8Array becomes (the destructive case) -----------
  console.log("\n4. Falsification control: what a raw Uint8Array becomes")
  const rawRef = await call("logs.tail", [1, new Uint8Array([1, 2, 255])])
  const [raw] = await consume(rawRef.id, 32)
  const isPlainObject = raw.chunk !== null && typeof raw.chunk === "object" && !ArrayBuffer.isView(raw.chunk)
  record(
    "a raw Uint8Array is silently destroyed (numeric-keyed object)",
    isPlainObject,
    `arrived as ${JSON.stringify(raw.chunk)} — Uint8Array: ${ArrayBuffer.isView(raw.chunk)}`,
  )

  brain.destroy()

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  console.log(`RESULT ${JSON.stringify({ results })}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((error) => {
  console.error("verification failed:", error)
  process.exit(1)
})
