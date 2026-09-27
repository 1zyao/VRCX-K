// A Windows-side TCP endpoint for the cross-VM (Windows <-> WSL) measurements.
//
// WHY THIS EXISTS: `transport-lab/FINDINGS.md` §8 records that "everything here
// is loopback" and that real-network RTT is the one variable the whole set does
// NOT measure — while §6 shows RTT is decisive (folder upload is 320x slower at
// 5 ms RTT). WSL lives on a Hyper-V vSwitch (172.25.x.x), so a Windows<->WSL TCP
// connection crosses a real network path with a real RTT, and it needs no
// runtime inside WSL beyond the `nc`/`dd` it already ships.
//
// Two modes:
//   node cross-vm-server.mjs --mode=echo --port=47400    # round-trip timing
//   node cross-vm-server.mjs --mode=sink --port=47401    # throughput sink
//
// Both print one RESULT line at the end so the caller can parse rather than
// eyeball.

import { createServer } from "node:net"

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, value] = raw.replace(/^--/, "").split("=")
    return [key, value ?? "true"]
  }),
)
const MODE = args.mode ?? "echo"
const PORT = Number(args.port ?? (MODE === "echo" ? 47400 : 47401))
const EXPECTED = Number(args.expected ?? 0)

const server = createServer((socket) => {
  socket.setNoDelay(true)

  if (MODE === "echo") {
    // Echo whole lines back. The peer measures its own round trips, so the
    // SERVER never grades the timing — the same discipline the transport lab
    // adopted after a producer graded its own work.
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (line.length > 0) socket.write(`${line}\n`)
      }
    })
    socket.on("error", () => {})
    return
  }

  // Sink: count bytes until the peer half-closes.
  let bytes = 0
  let first = null
  let last = null
  socket.on("data", (chunk) => {
    if (first === null) first = process.hrtime.bigint()
    last = process.hrtime.bigint()
    bytes += chunk.length
  })
  socket.on("end", () => {
    const seconds = first && last ? Number(last - first) / 1e9 : 0
    console.log(
      `RESULT ${JSON.stringify({
        mode: "sink",
        bytes,
        seconds,
        mibPerS: seconds > 0 ? bytes / 1048576 / seconds : 0,
        expected: EXPECTED || null,
      })}`,
    )
    socket.end()
    server.close()
  })
  socket.on("error", () => {})
})

server.listen(PORT, "0.0.0.0", () => {
  console.log(`RESULT ${JSON.stringify({ mode: MODE, port: PORT, listening: "0.0.0.0" })}`)
})
