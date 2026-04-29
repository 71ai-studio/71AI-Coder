/**
 * Stage the bundled vcoder server into ./server/ so it can be packaged inside
 * the .vsix.
 *
 * Layout produced:
 *   server/
 *     dist/index.js                        (bundled by ../server/build.cjs)
 *     dist/index.js.map
 *     package.json                         (minimal — declares native deps)
 *     node_modules/<native deps>/...       (copied flat from workspace root)
 */
const fs = require("node:fs")
const fsp = require("node:fs/promises")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const extensionDir = __dirname
const serverSrc = path.resolve(extensionDir, "..", "server")
const workspaceRoot = path.resolve(extensionDir, "..")
const targetDir = path.join(extensionDir, "server")

// Native (.node) and UMD-with-internal-requires modules that build.cjs
// externalizes. Each must exist in the staged node_modules at runtime.
// Platform-specific binaries are added based on `process.platform/arch`.
const nativeRoots = [
  "better-sqlite3",
  "@parcel/watcher",
  "@lydell/node-pty",
  "tree-sitter",
  "tree-sitter-bash",
  "tree-sitter-powershell",
  "web-tree-sitter",
  "jsonc-parser",
  "drizzle-kit",
  "prettier",
]

function platformPkgs() {
  const p = process.platform
  const a = process.arch
  // Best-effort — only ship the binaries for the host platform. CI can shard
  // builds per platform and produce per-OS .vsix files for distribution.
  const out = [`@parcel/watcher-${p}-${a}`, `@lydell/node-pty-${p}-${a}`]
  if (p === "linux") {
    // libc variants — include glibc; musl users can rebuild
    out.push(`@parcel/watcher-${p}-${a}-glibc`)
  }
  return out
}

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true })
}

async function copyDir(src, dest) {
  if (!fs.existsSync(src)) return false
  await fsp.mkdir(dest, { recursive: true })
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) await copyDir(s, d)
    else if (entry.isSymbolicLink()) {
      const link = await fsp.readlink(s)
      await fsp.symlink(link, d).catch(() => {})
    } else {
      await fsp.copyFile(s, d).catch((e) => {
        // .node binaries may be locked by VS Code — skip, the old copy is still valid
        if (e.code !== "EBUSY" && e.code !== "EPERM") throw e
        console.warn(`[build-server] warning: skipped locked file ${d}`)
      })
    }
  }
  return true
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"))
}

function* walkRequiredDeps(name, seen) {
  if (seen.has(name)) return
  seen.add(name)
  const pkgPath = path.join(workspaceRoot, "node_modules", name, "package.json")
  if (!fs.existsSync(pkgPath)) return
  yield name
  const pkg = readJson(pkgPath)
  for (const depName of Object.keys(pkg.dependencies ?? {})) {
    yield* walkRequiredDeps(depName, seen)
  }
}

async function buildServerBundle() {
  console.log("[build-server] running ../server/build.cjs")
  const result = spawnSync(process.execPath, [path.join(serverSrc, "build.cjs")], {
    cwd: serverSrc,
    stdio: "inherit",
  })
  if (result.status !== 0) throw new Error(`server build failed (exit ${result.status})`)
}

async function rmrfSafe(p) {
  try {
    await fsp.rm(p, { recursive: true, force: true })
  } catch (e) {
    if (e.code !== "EPERM" && e.code !== "EBUSY") throw e
    // .node file locked by VS Code — delete all non-.node files, leave locked ones
    console.warn(`[build-server] warning: could not fully remove ${p} (${e.code}), doing partial clean`)
    try {
      for (const entry of await fsp.readdir(p, { withFileTypes: true, recursive: true })) {
        const full = path.join(entry.parentPath ?? entry.path ?? p, entry.name)
        if (entry.isFile() && !full.endsWith(".node")) {
          await fsp.unlink(full).catch(() => {})
        } else if (entry.isDirectory()) {
          await fsp.rmdir(full).catch(() => {})
        }
      }
    } catch {}
  }
}

async function stageServer() {
  console.log(`[build-server] staging into ${targetDir}`)
  await rmrfSafe(targetDir)
  await fsp.mkdir(path.join(targetDir, "dist"), { recursive: true })

  // 1. Copy bundle.
  for (const f of ["index.js", "index.js.map"]) {
    const src = path.join(serverSrc, "dist", f)
    if (fs.existsSync(src)) await fsp.copyFile(src, path.join(targetDir, "dist", f))
  }

  // 2. Minimal package.json declaring runtime deps.
  const pkg = {
    name: "vcoder-server-bundle",
    version: "0.1.0",
    private: true,
    type: "module",
    main: "dist/index.js",
    bin: { vcoder: "dist/index.js" },
    description: "Bundled vcoder server (shipped inside the VS Code .vsix)",
  }
  await fsp.writeFile(path.join(targetDir, "package.json"), JSON.stringify(pkg, null, 2))

  // 3. Copy native deps + their transitive deps from workspace node_modules.
  const wanted = new Set()
  for (const root of [...nativeRoots, ...platformPkgs()]) {
    for (const dep of walkRequiredDeps(root, new Set())) wanted.add(dep)
  }

  let copied = 0
  let skipped = 0
  for (const name of wanted) {
    const src = path.join(workspaceRoot, "node_modules", name)
    const dest = path.join(targetDir, "node_modules", name)
    if (await copyDir(src, dest)) copied++
    else skipped++
  }
  console.log(`[build-server] copied ${copied} native/runtime modules (skipped ${skipped} not present)`)
}

async function main() {
  await buildServerBundle()
  await stageServer()
  console.log(`[build-server] done — ${targetDir} ready for vsce package`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
