/**
 * Shared wire helpers for the E2E lab.
 *
 * ONE DEFINITION OF EVERY RULE, so a server and a client written by different
 * calls cannot disagree about what "correct" means. Two of the bugs this
 * investigation already paid for were disagreements of exactly that kind:
 *
 *   1. `!==` binds tighter than `&`, so `f[8] !== (seq * 31 + 8) & 0xff` parses
 *      as `(f[8] !== (seq * 31 + 8)) & 0xff` — a boolean — and reported almost
 *      every frame as corrupt. Masks are parenthesised everywhere below.
 *   2. A bare `"__done__"` sentinel cannot work on a byte stream: the length
 *      framer absorbs it and waits forever. Every TCP message here is
 *      length-framed and TYPE-TAGGED, the terminator included.
 */

export const SEQ_BYTES = 8

/** Message kinds inside a length-framed stream or a datagram. */
export const MSG = {
  /** UTF-8 JSON control payload (test description, verification reply). */
  CONTROL: 1,
  /** A payload frame: 8-byte sequence number then opaque bytes. */
  FRAME: 2,
}

/**
 * One frame: an 8-byte big-endian sequence number then `size` payload bytes.
 *
 * The sequence number rides IN the frame rather than in a side channel, so a
 * receiver can classify duplicates, gaps and reordering even when the number of
 * delivered messages is itself wrong. Positional checks cannot do that — which
 * is precisely how a duplicate looked identical to a drop for several rounds.
 */
export function makeFrame(seq, size) {
  const buf = new Uint8Array(SEQ_BYTES + size)
  new DataView(buf.buffer).setBigUint64(0, BigInt(seq))
  for (let j = 0; j < size; j++) buf[SEQ_BYTES + j] = (seq * 31 + j + SEQ_BYTES) & 0xff
  return buf
}

export function readSeq(frame) {
  return Number(new DataView(frame.buffer, frame.byteOffset, SEQ_BYTES).getBigUint64(0))
}

/**
 * Compare one received frame against the frame that sequence number implies.
 * Returns null when identical, else a human-readable first difference.
 *
 * Regenerating the expectation is O(size) per frame, but it makes the check
 * exact rather than probabilistic (a hash could collide) and removes every
 * opportunity for the two sides to compute "expected" differently.
 */
export function verifyFrame(frame, seq, size) {
  const want = SEQ_BYTES + size
  if (frame.length !== want) return `length ${frame.length} != ${want}`
  const expected = makeFrame(seq, size)
  for (let i = 0; i < frame.length; i++) {
    if (frame[i] !== expected[i]) return `byte ${i}: ${frame[i]} != ${expected[i]}`
  }
  return null
}

/** Accumulates every integrity fact about one transfer. */
export class Verifier {
  constructor(size, count) {
    this.size = size
    this.count = count
    this.counts = new Map()
    this.events = 0
    this.corrupt = 0
    this.reordered = 0
    this.bytes = 0
    this.highest = -1
    this.firstIssue = null
  }

  add(frame) {
    this.events++
    this.bytes += frame.length
    const seq = readSeq(frame)
    if (seq < this.highest) this.reordered++
    if (seq > this.highest) this.highest = seq
    const diff = verifyFrame(frame, seq, this.size)
    if (diff !== null) {
      this.corrupt++
      if (this.firstIssue === null) this.firstIssue = `seq ${seq}: ${diff}`
    }
    this.counts.set(seq, (this.counts.get(seq) ?? 0) + 1)
  }

  result() {
    let duplicates = 0
    for (const n of this.counts.values()) if (n > 1) duplicates += n - 1
    let missing = 0
    for (let i = 0; i < this.count; i++) if (!this.counts.has(i)) missing++
    return {
      events: this.events,
      unique: this.counts.size,
      duplicates,
      missing,
      reordered: this.reordered,
      corrupt: this.corrupt,
      bytes: this.bytes,
      firstIssue: this.firstIssue,
      exact:
        this.counts.size === this.count &&
        duplicates === 0 &&
        missing === 0 &&
        this.reordered === 0 &&
        this.corrupt === 0,
    }
  }
}

// ── TCP: [4-byte length][1-byte type][payload], the terminator included ────

export function packTcp(type, payload) {
  const out = new Uint8Array(4 + 1 + payload.length)
  new DataView(out.buffer).setUint32(0, 1 + payload.length)
  out[4] = type
  out.set(payload, 5)
  return Buffer.from(out)
}

/** Reassembles type-tagged messages from an arbitrary TCP byte sequence. */
export class TcpFramer {
  constructor() {
    this.buf = Buffer.alloc(0)
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)])
    const messages = []
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0)
      if (len < 1) throw new Error(`invalid TCP frame length ${len}`)
      if (this.buf.length < 4 + len) break
      messages.push({ type: this.buf[4], payload: new Uint8Array(this.buf.subarray(5, 4 + len)) })
      this.buf = this.buf.subarray(4 + len)
    }
    return messages
  }
}

// ── UDP: [1-byte type][payload] per datagram ──────────────────────────────

export function packUdp(type, payload) {
  const out = new Uint8Array(1 + payload.length)
  out[0] = type
  out.set(payload, 1)
  return Buffer.from(out)
}

export function unpackUdp(datagram) {
  const buf = Buffer.from(datagram)
  return { type: buf[0], payload: new Uint8Array(buf.subarray(1)) }
}

// ── text encodings, so the SAME payload can be sent three different ways ───

export function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64")
}

export function fromBase64(text) {
  return new Uint8Array(Buffer.from(text, "base64"))
}

/**
 * Reproduce kkrpc's BUILT-IN ws transport exactly: it calls
 * `JSON.stringify(message)`, and a `Uint8Array` has no JSON form, so it becomes
 * a numeric-keyed object. Including this encoding lets the report show the
 * built-in behaviour next to the alternatives instead of merely asserting it.
 */
export function toUint8Json(bytes) {
  return JSON.stringify(bytes)
}

export function fromUint8Json(text) {
  const parsed = JSON.parse(text)
  const values = Object.values(parsed)
  return new Uint8Array(values)
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
