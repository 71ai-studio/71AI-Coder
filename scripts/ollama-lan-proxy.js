#!/usr/bin/env node
// Forward requests from a LAN-accessible address to local Ollama (127.0.0.1:11434).
//
// Usage:
//   node scripts/ollama-lan-proxy.js                       # binds 0.0.0.0:11500
//   node scripts/ollama-lan-proxy.js --port 8080           # custom port
//   node scripts/ollama-lan-proxy.js --bind 192.168.1.50   # bind to a specific iface
//   node scripts/ollama-lan-proxy.js --target http://127.0.0.1:11434  # custom upstream
//
// Why: Ollama by default only listens on 127.0.0.1 and ignores OLLAMA_HOST in
// some setups. Run this script on the box where Ollama lives to expose it on
// your LAN without restarting Ollama or touching system services.

import http from "node:http"
import os from "node:os"

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const PORT = parseInt(arg("--port", "11500"), 10)
const BIND = arg("--bind", "0.0.0.0")
const TARGET = arg("--target", "http://localhost:11434").replace(/\/+$/, "")
const target = new URL(TARGET)
const upstreamPort = target.port || (target.protocol === "https:" ? 443 : 80)

const server = http.createServer((req, res) => {
  // CORS — allow vcoder webviews and other LAN clients to call the proxy directly.
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,PATCH,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization")
  if (req.method === "OPTIONS") {
    res.writeHead(204).end()
    return
  }

  const upstream = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${target.hostname}:${upstreamPort}` },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers)
      upRes.pipe(res)
    },
  )

  upstream.on("error", (err) => {
    console.error(`[proxy] upstream error: ${err.code || ""} ${err.message}`)
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "ollama unreachable", code: err.code, detail: err.message }))
  })

  req.pipe(upstream)
})

function lanAddresses() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address)
    }
  }
  return out
}

server.listen(PORT, BIND, () => {
  console.log(`[proxy] forwarding ${BIND}:${PORT} -> ${TARGET}`)
  if (BIND === "0.0.0.0") {
    const ips = lanAddresses()
    if (ips.length) {
      console.log(`[proxy] reachable from LAN at:`)
      for (const ip of ips) console.log(`  http://${ip}:${PORT}/v1   (OpenAI-compat for vcoder)`)
    }
  }
  console.log(`[proxy] press Ctrl+C to stop`)
})
