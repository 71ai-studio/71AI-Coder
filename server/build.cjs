const esbuild = require("esbuild")
const path = require("path")
const fs = require("fs")

const watch = process.argv.includes("--watch")

// Read all SQL migrations from the opencode package and inject them via
// esbuild `define` so the bundled binary doesn't need filesystem access to a
// `migration/` dir at runtime.
function loadMigrations() {
  const migrationDir = path.resolve(__dirname, "../packages/opencode/migration")
  if (!fs.existsSync(migrationDir)) return []
  const time = (tag) => {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
    if (!m) return 0
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  }
  return fs
    .readdirSync(migrationDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const file = path.join(migrationDir, e.name, "migration.sql")
      if (!fs.existsSync(file)) return null
      return { sql: fs.readFileSync(file, "utf8"), timestamp: time(e.name), name: e.name }
    })
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp)
}

const migrations = loadMigrations()

// Native or otherwise non-bundleable modules — keep external so Node loads them
// from node_modules at runtime instead of esbuild trying to inline them.
const externals = [
  "@lydell/node-pty",
  "@parcel/watcher",
  "@parcel/watcher-darwin-arm64",
  "@parcel/watcher-darwin-x64",
  "@parcel/watcher-linux-arm64-glibc",
  "@parcel/watcher-linux-arm64-musl",
  "@parcel/watcher-linux-x64-glibc",
  "@parcel/watcher-linux-x64-musl",
  "@parcel/watcher-win32-arm64",
  "@parcel/watcher-win32-x64",
  "tree-sitter",
  "tree-sitter-bash",
  "tree-sitter-powershell",
  "web-tree-sitter",
  "drizzle-kit",
  // Optional dev tools — only used by `opencode generate`, not at runtime
  "prettier",
  "prettier/plugins/babel",
  "prettier/plugins/estree",
  // UMD packages with internal relative requires that esbuild can't follow
  "jsonc-parser",
  // Native module — must be loaded from node_modules so node-gyp prebuilt binary is found
  "better-sqlite3",
  // ioredis and quansync are pure-JS — bundled in so Node doesn't crash at startup
]

// Write a minimal ioredis stub so esbuild can bundle it instead of leaving a broken import.
const ioredisStub = path.join(__dirname, "dist", "_ioredis_stub.js")
fs.mkdirSync(path.dirname(ioredisStub), { recursive: true })
fs.writeFileSync(ioredisStub, "export default {}; export class Redis {} export class Cluster {}\n")

const options = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: "dist/index.js",
  banner: {
    js: [
      "#!/usr/bin/env node",
      // ESM shim so bundled CJS deps that reference __dirname/__filename keep working
      "import { fileURLToPath as __vcoderFileURLToPath } from 'node:url'",
      "import { dirname as __vcoderDirname } from 'node:path'",
      "import { createRequire as __vcoderCreateRequire } from 'node:module'",
      "const __filename = __vcoderFileURLToPath(import.meta.url)",
      "const __dirname = __vcoderDirname(__filename)",
      "const require = __vcoderCreateRequire(import.meta.url)",
    ].join("\n"),
  },
  sourcemap: true,
  logLevel: "info",
  external: externals,
  conditions: ["node", "import"],
  loader: {
    ".node": "file",
    ".sql": "text",
    ".txt": "text",
  },
  // opencode references migrations dir relative to import.meta.dirname; mark as
  // not-side-effect-free so esbuild keeps the runtime path lookup intact.
  resolveExtensions: [".ts", ".tsx", ".mjs", ".js", ".cjs", ".json"],
  alias: {
    "ioredis": ioredisStub,
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production"),
    OPENCODE_MIGRATIONS: JSON.stringify(migrations),
    OPENCODE_LIBC: JSON.stringify("glibc"),
  },
}

/**
 * Strip self-recursive `await init_X();` calls from inside their own `var
 * init_X = __esm({ ... });` blocks.
 *
 * opencode source files use `export * as Foo from "./foo"` (self-namespace
 * re-export). esbuild compiles each into a recursive `await init_X()` call
 * inside init_X's own body, which deadlocks ESM evaluation. The self-call is
 * effectively a no-op (you're inside the init already) so we strip it.
 */
/**
 * Strip self-recursive AND cycle-creating `await init_X();` calls.
 *
 * opencode's `export * as Foo from "./foo"` pattern combined with circular
 * imports between modules makes esbuild emit await-chains that deadlock under
 * Node ESM. We strip every `await init_X();` call inside any other init body
 * (these only enforce ordering — all top-level side-effect work in opencode is
 * trivial mkdir/lazy-init, which is safe to run eagerly without ordering).
 *
 * Self-recursive awaits are also stripped (they're always no-ops).
 */
function stripInitAwaits(file) {
  let text = fs.readFileSync(file, "utf8")
  let strippedSelf = 0
  let strippedCycle = 0

  // First pass: identify all init names + their dep graph to find cycles.
  const lines = text.split("\n")
  const reDef = /^var (init_\w+) = __esm\(\{$/
  const deps = new Map()
  const bodies = new Map()
  let cur = null
  let bodyStart = 0
  for (let i = 0; i < lines.length; i++) {
    const m = reDef.exec(lines[i])
    if (m) {
      cur = m[1]
      bodyStart = i
      deps.set(cur, [])
      continue
    }
    if (cur && lines[i].trim() === "});") {
      bodies.set(cur, [bodyStart, i])
      cur = null
      continue
    }
    if (cur) {
      const aw = /await (init_\w+)\(\);/.exec(lines[i])
      if (aw) deps.get(cur).push(aw[1])
    }
  }

  // Find back-edges that close cycles (DFS).
  const backEdges = new Set()
  const stack = new Set()
  function dfs(n) {
    if (stack.has(n)) return
    stack.add(n)
    for (const d of deps.get(n) || []) {
      if (stack.has(d)) backEdges.add(`${n}->${d}`)
      else dfs(d)
    }
    stack.delete(n)
  }
  for (const n of deps.keys()) dfs(n)

  // Strip self-awaits + cycle back-edges. Loop through each init body, remove
  // matching await lines.
  for (const [name, [s, e]] of bodies) {
    for (let i = s + 1; i < e; i++) {
      const aw = /^(\s*)await (init_\w+)\(\);(.*)$/.exec(lines[i])
      if (!aw) continue
      const target = aw[2]
      if (target === name) {
        lines[i] = aw[1] + aw[3]
        strippedSelf++
      } else if (backEdges.has(`${name}->${target}`)) {
        // Convert `await init_X();` to `init_X();` so init still triggers but
        // doesn't deadlock the cycle.
        lines[i] = aw[1] + `${target}();` + aw[3]
        strippedCycle++
      }
    }
  }

  fs.writeFileSync(file, lines.join("\n"))
  console.log(`[postbuild] stripped ${strippedSelf} self-await + ${strippedCycle} cycle-edge awaits`)
}

async function main() {
  fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true })
  if (watch) {
    const ctx = await esbuild.context({
      ...options,
      plugins: [
        {
          name: "vcoder-postbuild",
          setup(build) {
            build.onEnd(() => stripInitAwaits(options.outfile))
          },
        },
      ],
    })
    await ctx.watch()
    console.log("[build] watching for changes...")
  } else {
    await esbuild.build(options)
    stripInitAwaits(options.outfile)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
