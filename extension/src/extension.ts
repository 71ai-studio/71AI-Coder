import * as vscode from "vscode"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { spawn, type ChildProcess } from "node:child_process"

const TERMINAL_NAME = "vcoder"
const SESSION_DIR_NAME = ".vcoder-session"
const HEALTH_PATH = "/global"
const HEALTH_TIMEOUT_MS = 1500
const SPAWN_READY_TIMEOUT_MS = 30_000
const SPAWN_POLL_INTERVAL_MS = 250
const DEFAULT_PORT = 4096

// Single shared server — one process for all workspaces.
let sharedServer: { port: number; proc?: ChildProcess } | undefined

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("vcoder")
  context.subscriptions.push(log)

  const installPromise = ensureServerInstalled(context, log).catch((err) => {
    log.appendLine(`[vcoder] server install failed: ${describe(err)}`)
    throw err
  })

  const ensureRunning = async (): Promise<{ port: number }> => {
    await installPromise
    if (sharedServer && (await healthCheck(sharedServer.port))) return sharedServer
    sharedServer = await startServer(log)
    await waitForReady(sharedServer.port, log)
    return sharedServer
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("vcoder.openNewTerminal", async () => {
      const srv = await ensureRunning()
      const ws = currentWorkspace()
      if (ws) await ensureSessionDir(ws, log)
      await openTerminal(context, srv.port, ws, { reuse: false })
    }),
    vscode.commands.registerCommand("vcoder.openTerminal", async () => {
      const srv = await ensureRunning()
      const ws = currentWorkspace()
      if (ws) await ensureSessionDir(ws, log)
      await openTerminal(context, srv.port, ws, { reuse: true })
    }),
    vscode.commands.registerCommand("vcoder.addFilepathToTerminal", async () => {
      const fileRef = getActiveFile()
      if (!fileRef) return
      const terminal = vscode.window.activeTerminal
      if (!terminal || terminal.name !== TERMINAL_NAME) return
      const srv = await ensureRunning()
      await appendPrompt(srv.port, fileRef)
      terminal.show()
    }),
    vscode.commands.registerCommand("vcoder.restartServer", async () => {
      log.appendLine("[vcoder] manual restart requested")
      await stopServer(log)
      const srv = await ensureRunning()
      vscode.window.showInformationMessage(`vcoder server restarted on port ${srv.port}`)
    }),
  )

  context.subscriptions.push({
    dispose: () => void stopServer(log),
  })
}

export async function deactivate() {
  await stopServer()
}

/**
 * Copy the server bundle that ships with the .vsix into ~/.vcoder/server/.
 * Skipped when the version stamp matches — avoids re-copying on every activation.
 */
async function ensureServerInstalled(context: vscode.ExtensionContext, log: vscode.OutputChannel): Promise<void> {
  const sourceDir = path.join(context.extensionPath, "server")
  if (!fs.existsSync(path.join(sourceDir, "dist", "index.js"))) {
    throw new Error(`bundled server missing at ${sourceDir}/dist/index.js`)
  }

  const targetDir = vcoderHomeServerDir()
  const stampPath = path.join(targetDir, ".version")
  const expectedStamp = `${context.extension.packageJSON.version ?? "dev"}|${context.extension.packageJSON.name ?? "vcoder"}`

  if (fs.existsSync(stampPath)) {
    try {
      const actual = await fsp.readFile(stampPath, "utf8")
      if (actual === expectedStamp) {
        log.appendLine(`[vcoder] server already installed at ${targetDir} (version ${expectedStamp})`)
        return
      }
    } catch {}
  }

  log.appendLine(`[vcoder] installing server to ${targetDir} (version ${expectedStamp})`)
  await fsp.rm(targetDir, { recursive: true, force: true })
  await fsp.mkdir(targetDir, { recursive: true })
  await copyDir(sourceDir, targetDir)
  await fsp.writeFile(stampPath, expectedStamp, "utf8")
  log.appendLine("[vcoder] server install complete")
}

function vcoderHomeDir(): string {
  return path.join(os.homedir(), ".vcoder")
}

function vcoderHomeServerDir(): string {
  return path.join(vcoderHomeDir(), "server")
}

function currentWorkspace(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true })
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) await copyDir(s, d)
    else if (entry.isSymbolicLink()) await fsp.symlink(await fsp.readlink(s), d)
    else await fsp.copyFile(s, d)
  }
}

// Per-workspace: create .vcoder-session/ with XDG subdirs and add to .gitignore.
async function ensureSessionDir(workspaceDir: string, log: vscode.OutputChannel): Promise<string> {
  const sessionDir = path.join(workspaceDir, SESSION_DIR_NAME)
  await fsp.mkdir(sessionDir, { recursive: true })
  for (const sub of ["share", "cache", "config", "state"]) {
    await fsp.mkdir(path.join(sessionDir, sub), { recursive: true })
  }
  await ensureGitignored(workspaceDir, log)
  return sessionDir
}

async function ensureGitignored(workspaceDir: string, log: vscode.OutputChannel): Promise<void> {
  const gitignorePath = path.join(workspaceDir, ".gitignore")
  const lineToAdd = `${SESSION_DIR_NAME}/`

  let content = ""
  try {
    content = await fsp.readFile(gitignorePath, "utf8")
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      log.appendLine(`[vcoder] could not read .gitignore: ${describe(err)}`)
      return
    }
    if (!fs.existsSync(path.join(workspaceDir, ".git"))) return
  }

  const lines = content.split(/\r?\n/).map((s) => s.trim())
  if (lines.includes(lineToAdd) || lines.includes(SESSION_DIR_NAME)) return

  const next =
    content.length === 0
      ? `${lineToAdd}\n`
      : content.endsWith("\n")
        ? `${content}${lineToAdd}\n`
        : `${content}\n${lineToAdd}\n`
  await fsp.writeFile(gitignorePath, next, "utf8")
  log.appendLine(`[vcoder] added "${lineToAdd}" to ${gitignorePath}`)
}

async function readSavedPort(): Promise<number | undefined> {
  try {
    const raw = await fsp.readFile(path.join(vcoderHomeDir(), "server.port"), "utf8")
    const n = parseInt(raw.trim(), 10)
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined
  } catch {
    return undefined
  }
}

async function writeSavedPort(port: number): Promise<void> {
  await fsp.mkdir(vcoderHomeDir(), { recursive: true })
  await fsp.writeFile(path.join(vcoderHomeDir(), "server.port"), String(port), "utf8")
}

async function pickFreePort(): Promise<number> {
  const net = await import("node:net")
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      if (addr && typeof addr === "object") {
        const p = addr.port
        srv.close(() => resolve(p))
      } else {
        srv.close(() => reject(new Error("could not resolve listen address")))
      }
    })
  })
}

async function healthCheck(port: number): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS)
    const res = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, { signal: ctrl.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

async function waitForReady(port: number, log: vscode.OutputChannel): Promise<void> {
  const deadline = Date.now() + SPAWN_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await healthCheck(port)) {
      log.appendLine(`[vcoder] server ready on port ${port}`)
      return
    }
    await sleep(SPAWN_POLL_INTERVAL_MS)
  }
  throw new Error(`server did not become ready on port ${port} within ${SPAWN_READY_TIMEOUT_MS}ms`)
}

async function startServer(log: vscode.OutputChannel): Promise<{ port: number; proc: ChildProcess }> {
  // If a server is already up on the saved port, adopt it without spawning.
  const saved = await readSavedPort()
  if (saved !== undefined && (await healthCheck(saved))) {
    log.appendLine(`[vcoder] adopting existing server on port ${saved}`)
    sharedServer = { port: saved }
    return sharedServer as { port: number; proc: ChildProcess }
  }

  // Prefer saved port if free; otherwise pick an ephemeral one.
  const port =
    saved !== undefined && !(await isPortInUse(saved)) ? saved : DEFAULT_PORT && !(await isPortInUse(DEFAULT_PORT))
      ? DEFAULT_PORT
      : await pickFreePort()

  const serverEntry = path.join(vcoderHomeServerDir(), "dist", "index.js")
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`server entry not found at ${serverEntry}; install may have failed`)
  }

  log.appendLine(`[vcoder] spawning shared server: node ${serverEntry} --port ${port}`)

  const child = spawn(process.execPath, [serverEntry, "--port", String(port)], {
    cwd: vcoderHomeDir(),
    env: { ...process.env, VCODER_CALLER: "vscode" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: false,
  })

  child.stdout?.on("data", (chunk: Buffer) => log.append(`[server:${port}] ${chunk.toString("utf8")}`))
  child.stderr?.on("data", (chunk: Buffer) => log.append(`[server:${port}!] ${chunk.toString("utf8")}`))
  child.on("exit", (code, signal) => {
    log.appendLine(`[vcoder] server (port ${port}) exited code=${code} signal=${signal}`)
    if (sharedServer?.proc === child) sharedServer = undefined
  })
  child.on("error", (err) => {
    log.appendLine(`[vcoder] server spawn error: ${describe(err)}`)
  })

  sharedServer = { port, proc: child }
  await writeSavedPort(port)
  return sharedServer as { port: number; proc: ChildProcess }
}

async function isPortInUse(port: number): Promise<boolean> {
  const net = await import("node:net")
  return await new Promise<boolean>((resolve) => {
    const srv = net.createServer()
    srv.once("error", () => resolve(true))
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(false))
    })
  })
}

async function stopServer(log?: vscode.OutputChannel): Promise<void> {
  const srv = sharedServer
  if (!srv) return
  sharedServer = undefined
  const child = srv.proc
  if (!child || child.exitCode !== null) return
  log?.appendLine(`[vcoder] stopping server (pid ${child.pid}, port ${srv.port})`)
  child.kill()
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve()
    child.once("exit", () => resolve())
    setTimeout(() => resolve(), 3000)
  })
}

async function openTerminal(
  context: vscode.ExtensionContext,
  port: number,
  workspaceDir: string | undefined,
  opts: { reuse: boolean },
): Promise<void> {
  if (opts.reuse) {
    const existing = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)
    if (existing) {
      existing.show()
      const fileRef = getActiveFile()
      if (fileRef) await appendPrompt(port, fileRef)
      return
    }
  }

  const sessionDir = workspaceDir ? path.join(workspaceDir, SESSION_DIR_NAME) : undefined

  const terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    iconPath: {
      light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
      dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
    },
    location: { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    env: {
      _EXTENSION_VCODER_PORT: String(port),
      VCODER_CALLER: "vscode",
      ...(workspaceDir
        ? {
            XDG_DATA_HOME: path.join(sessionDir!, "share"),
            XDG_CACHE_HOME: path.join(sessionDir!, "cache"),
            XDG_CONFIG_HOME: path.join(sessionDir!, "config"),
            XDG_STATE_HOME: path.join(sessionDir!, "state"),
          }
        : {}),
    },
  })
  terminal.show()
  terminal.sendText(
    `echo "vcoder server: http://127.0.0.1:${port}${sessionDir ? ` (session: ${sessionDir})` : ""}"`,
  )

  const fileRef = getActiveFile()
  if (fileRef) await appendPrompt(port, `In ${fileRef}`)
}

async function appendPrompt(port: number, text: string): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/tui/append-prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    })
  } catch {
    // Server might be temporarily unavailable; the terminal still opens.
  }
}

function getActiveFile(): string | undefined {
  const editor = vscode.window.activeTextEditor
  if (!editor) return
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri)
  if (!folder) return
  const rel = vscode.workspace.asRelativePath(editor.document.uri)
  let ref = `@${rel}`
  const sel = editor.selection
  if (!sel.isEmpty) {
    const start = sel.start.line + 1
    const end = sel.end.line + 1
    ref += start === end ? `#L${start}` : `#L${start}-${end}`
  }
  return ref
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message
  return String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
