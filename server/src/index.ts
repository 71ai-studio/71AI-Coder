/**
 * vcoder CLI entry — boots a headless opencode server.
 *
 * Skips opencode's yargs CLI entry (which has its own top-level `await
 * cli.parse()` that never resolves for long-running commands and would
 * deadlock ESM module evaluation when imported). We call Log.init +
 * bootstrap + Server.listen directly instead.
 */
import * as Log from "@opencode-ai/core/util/log"
import { Server } from "opencode/server/server"
import { bootstrap } from "opencode/cli/bootstrap"
import { resolveNetworkOptionsNoConfig } from "opencode/cli/network"

function parseArgs(argv: string[]) {
  let port = 0
  let hostname = "127.0.0.1"
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--port" && argv[i + 1]) port = parseInt(argv[++i], 10)
    else if (a.startsWith("--port=")) port = parseInt(a.slice(7), 10)
    else if (a === "--hostname" && argv[i + 1]) hostname = argv[++i]
    else if (a.startsWith("--hostname=")) hostname = a.slice(11)
  }
  if (!port && process.env.VCODER_PORT) port = parseInt(process.env.VCODER_PORT, 10)
  if (process.env.VCODER_HOSTNAME) hostname = process.env.VCODER_HOSTNAME
  return { port: Number.isFinite(port) ? port : 0, hostname }
}

const { port, hostname } = parseArgs(process.argv.slice(2))

await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: false,
  level: "INFO",
})

const opts = resolveNetworkOptionsNoConfig({
  port,
  hostname,
  mdns: false,
  "mdns-domain": "opencode.local",
  cors: [],
})

await bootstrap(process.cwd(), async () => {
  const server = await Server.listen(opts)
  process.stdout.write(`vcoder listening on http://${server.hostname}:${server.port}\n`)

  const shutdown = async () => {
    await server.stop().catch(() => {})
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  await new Promise(() => {})
})
