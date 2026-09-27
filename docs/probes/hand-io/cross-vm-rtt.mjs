// Measure TCP round-trip time from WSL to the Windows side, so the number that
// `06-folder-upload.mjs --rttMs=` consumes is a MEASUREMENT rather than a guess.
//
// Run from WSL via node interop (that distro has no node of its own, but can
// exec the Windows node.exe). It runs on the WINDOWS side of the hop — i.e. it
// dials out to the Windows host — which is what a "far end" means here.
//
// Usage:
//   node cross-vm-rtt.mjs --host=172.25.32.1 --port=47400 --count=50

import { connect } from "node:net"

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, value] = raw.replace(/^--/, "").split("=")
    return [key, value ?? "true"]
  }),
)
const HOST = args.host ?? "172.25.32.1"
const PORT = Number(args.port ?? 47400)
const COUNT = Number(args.count ?? 50)

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[index]
}

const socket = connect({ host: HOST, port: PORT, noDelay: true })

const samples = []
let pending = null
let buffer = ""
let sent = 0

socket.setEncoding("utf8")

socket.on("connect", () => {
  send()
})

socket.on("data", (chunk) => {
  buffer += chunk
  const lines = buffer.split("\n")
  buffer = lines.pop() ?? ""
  for (const line of lines) {
    if (line.length === 0) continue
    if (pending !== null) {
      samples.push(Number(process.hrtime.bigint() - pending) / 1e6)
      pending = null
    }
    send()
  }
})

socket.on("error", (error) => {
  console.log(`RESULT ${JSON.stringify({ error: error.message, host: HOST, port: PORT })}`)
  process.exit(1)
})

function send() {
  if (sent >= COUNT) {
    finish()
    return
  }
  sent++
  pending = process.hrtime.bigint()
  socket.write(`ping-${sent}\n`)
}

function finish() {
  socket.end()
  if (samples.length === 0) {
    console.log(`RESULT ${JSON.stringify({ error: "no samples", host: HOST, port: PORT })}`)
    process.exit(1)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  console.log(
    `RESULT ${JSON.stringify({
      host: HOST,
      port: PORT,
      count: samples.length,
      meanMs: Number(mean.toFixed(3)),
      minMs: Number(sorted[0].toFixed(3)),
      p50Ms: Number(percentile(sorted, 50).toFixed(3)),
      p95Ms: Number(percentile(sorted, 95).toFixed(3)),
      maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
    })}`,
  )
  process.exit(0)
}

// A bounded guard: an unreachable host must fail loudly, not hang.
setTimeout(() => {
  console.log(
    `RESULT ${JSON.stringify({ error: "timed out with no reply", host: HOST, port: PORT, got: samples.length })}`,
  )
  process.exit(1)
}, 15000)
