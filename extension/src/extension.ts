import * as vscode from "vscode"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { spawn, type ChildProcess } from "node:child_process"

const TERMINAL_NAME = "vcoder"
const SESSION_DIR_NAME = ".vcoder-session"
const HEALTH_PATH = "/global/health"
const HEALTH_TIMEOUT_MS = 1500
const SPAWN_READY_TIMEOUT_MS = 90_000
const SPAWN_POLL_INTERVAL_MS = 250
const DEFAULT_PORT = 4096

// Single shared server — one process for all workspaces.
let sharedServer: { port: number; proc?: ChildProcess } | undefined
let statusBar: vscode.StatusBarItem | undefined
let chatPanel: vscode.WebviewPanel | undefined
let currentTheme: "dark" | "light" = "dark"

function workspaceRel(absPath: string): string {
  const folders = vscode.workspace.workspaceFolders ?? []
  for (const f of folders) {
    const root = f.uri.fsPath
    if (absPath === root || absPath.startsWith(root + path.sep)) {
      return path.relative(root, absPath).split(path.sep).join("/")
    }
  }
  return absPath.split(path.sep).join("/")
}

function postActiveFile(): void {
  if (!chatPanel) return
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    chatPanel.webview.postMessage({ type: "activeFile", path: undefined })
    return
  }
  if (editor.document.uri.scheme !== "file") return
  chatPanel.webview.postMessage({
    type: "activeFile",
    path: workspaceRel(editor.document.uri.fsPath),
  })
}

function getThemeKind(): "dark" | "light" {
  const kind = vscode.window.activeColorTheme.kind
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
    ? "light"
    : "dark"
}

async function sendThemeToServer(port: number, theme: "dark" | "light"): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/tui/set-theme`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme }),
    })
  } catch {
    // Server might be temporarily unavailable.
  }
}

type ConnState = "disconnected" | "connecting" | "connected"

function updateStatusBar(state: ConnState, port?: number) {
  if (!statusBar) return
  if (state === "disconnected") {
    statusBar.text = "$(plug) Connect vcoder"
    statusBar.tooltip = "Click to connect to vcoder server"
    statusBar.command = "vcoder.connect"
    statusBar.backgroundColor = undefined
  } else if (state === "connecting") {
    statusBar.text = "$(loading~spin) vcoder connecting..."
    statusBar.tooltip = "Connecting to vcoder server..."
    statusBar.command = undefined
    statusBar.backgroundColor = undefined
  } else {
    statusBar.text = `$(check) vcoder :${port}`
    statusBar.tooltip = `Connected to vcoder server on port ${port}\nClick to restart`
    statusBar.command = "vcoder.restartServer"
    statusBar.backgroundColor = undefined
  }
  statusBar.show()
}

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("vcoder")
  context.subscriptions.push(log)

  currentTheme = getThemeKind()

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  context.subscriptions.push(statusBar)
  updateStatusBar("disconnected")

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => postActiveFile()),
    vscode.window.onDidChangeActiveColorTheme((theme) => {
      const newTheme =
        theme.kind === vscode.ColorThemeKind.Light || theme.kind === vscode.ColorThemeKind.HighContrastLight
          ? "light"
          : "dark"
      currentTheme = newTheme
      if (chatPanel) {
        chatPanel.webview.postMessage({ type: "themeChange", theme: newTheme })
      }
      if (sharedServer) {
        void sendThemeToServer(sharedServer.port, newTheme)
      }
    }),
  )

  const installPromise = ensureServerInstalled(context, log).catch((err) => {
    log.appendLine(`[vcoder] server install failed: ${describe(err)}`)
    throw err
  })

  // On activation: silently detect an already-running server (external or previous session).
  installPromise
    .then(async () => {
      const saved = await readSavedPort()
      if (saved !== undefined && (await healthCheck(saved))) {
        sharedServer = { port: saved }
        updateStatusBar("connected", saved)
        log.appendLine(`[vcoder] found existing server on port ${saved}`)
      }
    })
    .catch(() => {})

  const connectToServer = async (): Promise<{ port: number }> => {
    await installPromise
    if (sharedServer && (await healthCheck(sharedServer.port))) {
      updateStatusBar("connected", sharedServer.port)
      return sharedServer
    }
    updateStatusBar("connecting")
    try {
      sharedServer = await startServer(log)
      await waitForReady(sharedServer.port, log, sharedServer.proc)
      updateStatusBar("connected", sharedServer.port)
      vscode.window.showInformationMessage(`vcoder: connected to server on port ${sharedServer.port}`)
    } catch (err) {
      updateStatusBar("disconnected")
      throw err
    }
    return sharedServer
  }

  const ensureRunning = async (): Promise<{ port: number }> => {
    if (sharedServer && (await healthCheck(sharedServer.port))) {
      updateStatusBar("connected", sharedServer.port)
      return sharedServer
    }
    return connectToServer()
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("vcoder.connect", async () => {
      if (sharedServer && (await healthCheck(sharedServer.port))) {
        vscode.window.showInformationMessage(`vcoder: already connected to server on port ${sharedServer.port}`)
        updateStatusBar("connected", sharedServer.port)
        return
      }
      try {
        await connectToServer()
      } catch (err) {
        vscode.window.showErrorMessage(`vcoder: failed to connect — ${describe(err)}`)
      }
    }),
    vscode.commands.registerCommand("vcoder.openNewTerminal", async () => {
      try {
        const srv = await ensureRunning()
        await sendThemeToServer(srv.port, currentTheme)
        openChatPanel(context, srv.port)
      } catch (err) {
        vscode.window.showErrorMessage(`vcoder: ${describe(err)}`)
      }
    }),
    vscode.commands.registerCommand("vcoder.openTerminal", async () => {
      try {
        const srv = await ensureRunning()
        await sendThemeToServer(srv.port, currentTheme)
        openChatPanel(context, srv.port)
      } catch (err) {
        vscode.window.showErrorMessage(`vcoder: ${describe(err)}`)
      }
    }),
    vscode.commands.registerCommand("vcoder.addFilepathToTerminal", async () => {
      const fileRef = getActiveFile()
      if (!fileRef) return
      const srv = await ensureRunning()
      const term = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)
      if (term && vscode.window.activeTerminal === term) {
        await appendPrompt(srv.port, fileRef)
        term.show()
        return
      }
      if (chatPanel) {
        chatPanel.webview.postMessage({ type: "addContextFile", path: fileRef.replace(/^@/, "") })
        chatPanel.reveal()
        return
      }
      await appendPrompt(srv.port, fileRef)
    }),
    vscode.commands.registerCommand("vcoder.openTUI", async () => {
      try {
        const srv = await ensureRunning()
        const ws = currentWorkspace()
        if (ws) await ensureSessionDir(ws, log)
        await openTerminalTUI(context, srv.port, ws, { reuse: true })
      } catch (err) {
        vscode.window.showErrorMessage(`vcoder: ${describe(err)}`)
      }
    }),
    vscode.commands.registerCommand("vcoder.restartServer", async () => {
      log.appendLine("[vcoder] manual restart requested")
      updateStatusBar("connecting")
      await stopServer(log)
      try {
        const srv = await connectToServer()
        vscode.window.showInformationMessage(`vcoder server restarted on port ${srv.port}`)
      } catch (err) {
        updateStatusBar("disconnected")
        vscode.window.showErrorMessage(`vcoder: failed to restart — ${describe(err)}`)
      }
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
  const targetEntry = path.join(targetDir, "dist", "index.js")
  const expectedStamp = `${context.extension.packageJSON.version ?? "dev"}|${context.extension.packageJSON.name ?? "vcoder"}`

  if (fs.existsSync(stampPath) && fs.existsSync(targetEntry)) {
    try {
      const actual = await fsp.readFile(stampPath, "utf8")
      if (actual === expectedStamp) {
        log.appendLine(`[vcoder] server already installed at ${targetDir} (version ${expectedStamp})`)
        return
      }
    } catch {}
  }

  log.appendLine(`[vcoder] installing server to ${targetDir} (version ${expectedStamp})`)
  // Best-effort wipe — leave locked .node files alone, copyDir will overwrite the rest
  try {
    await fsp.rm(targetDir, { recursive: true, force: true })
  } catch (err: any) {
    if (err?.code !== "EPERM" && err?.code !== "EBUSY") throw err
    log.appendLine(`[vcoder] could not fully remove old server (${err.code}); will overwrite in place`)
  }
  await fsp.mkdir(targetDir, { recursive: true })
  await copyDir(sourceDir, targetDir, log)
  if (!fs.existsSync(targetEntry)) {
    throw new Error(`server bundle copy did not produce ${targetEntry}`)
  }
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

async function copyDir(src: string, dest: string, log?: vscode.OutputChannel): Promise<void> {
  await fsp.mkdir(dest, { recursive: true })
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(s, d, log)
    } else if (entry.isSymbolicLink()) {
      try {
        await fsp.symlink(await fsp.readlink(s), d)
      } catch (err: any) {
        if (err?.code !== "EEXIST" && err?.code !== "EPERM") throw err
      }
    } else {
      try {
        await fsp.copyFile(s, d)
      } catch (err: any) {
        // Native .node files may be locked while VS Code holds a previous copy mapped — leave the existing one in place.
        if (err?.code === "EBUSY" || err?.code === "EPERM") {
          log?.appendLine(`[vcoder] skipping locked file ${d} (${err.code})`)
          continue
        }
        throw err
      }
    }
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

async function waitForReady(port: number, log: vscode.OutputChannel, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + SPAWN_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(
        `server process exited with code ${child.exitCode} before becoming ready — check the "vcoder" output panel for stack traces`,
      )
    }
    if (await healthCheck(port)) {
      log.appendLine(`[vcoder] server ready on port ${port}`)
      return
    }
    await sleep(SPAWN_POLL_INTERVAL_MS)
  }
  throw new Error(
    `server did not become ready on port ${port} within ${SPAWN_READY_TIMEOUT_MS}ms — check the "vcoder" output panel for server logs`,
  )
}

async function findNodeBinary(log: vscode.OutputChannel): Promise<string> {
  const cfg = vscode.workspace.getConfiguration("vcoder")
  const configured = cfg.get<string>("nodePath")?.trim()
  if (configured) {
    if (fs.existsSync(configured)) {
      log.appendLine(`[vcoder] using configured node: ${configured}`)
      return configured
    }
    log.appendLine(`[vcoder] configured nodePath does not exist, falling back: ${configured}`)
  }
  // Search PATH for node — better-sqlite3 prebuilds match real Node ABI, not Electron's.
  const pathSep = process.platform === "win32" ? ";" : ":"
  const exeNames = process.platform === "win32" ? ["node.exe", "node.cmd"] : ["node"]
  for (const dir of (process.env.PATH ?? "").split(pathSep)) {
    if (!dir) continue
    for (const exe of exeNames) {
      const full = path.join(dir, exe)
      if (fs.existsSync(full)) {
        log.appendLine(`[vcoder] using node from PATH: ${full}`)
        return full
      }
    }
  }
  log.appendLine(`[vcoder] no node on PATH, falling back to ${process.execPath} with ELECTRON_RUN_AS_NODE=1`)
  return process.execPath
}

async function startServer(log: vscode.OutputChannel): Promise<{ port: number; proc: ChildProcess }> {
  const cfg = vscode.workspace.getConfiguration("vcoder")
  const configuredPort = cfg.get<number>("port") || 0
  const noProxy = cfg.get<string>("noProxy")?.trim() || "localhost,127.0.0.1,::1"
  const extraCaCerts = cfg.get<string>("extraCaCerts")?.trim()
  const insecureTls = cfg.get<boolean>("insecureTls") === true
  if (extraCaCerts && !fs.existsSync(extraCaCerts)) {
    log.appendLine(`[vcoder] warning: extraCaCerts file not found: ${extraCaCerts}`)
  }

  // If a server is already up on the saved port, adopt it without spawning.
  const saved = await readSavedPort()
  if (saved !== undefined && (await healthCheck(saved))) {
    log.appendLine(`[vcoder] adopting existing server on port ${saved}`)
    sharedServer = { port: saved }
    return sharedServer as { port: number; proc: ChildProcess }
  }

  // Pick a port: explicit user setting > saved port > DEFAULT_PORT > ephemeral.
  const candidates = [configuredPort, saved ?? 0, DEFAULT_PORT].filter((p): p is number => p > 0)
  let port = 0
  for (const c of candidates) {
    if (!(await isPortInUse(c))) {
      port = c
      break
    }
  }
  if (port === 0) port = await pickFreePort()

  const serverEntry = path.join(vcoderHomeServerDir(), "dist", "index.js")
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`server entry not found at ${serverEntry}; install may have failed`)
  }

  const nodeBin = await findNodeBinary(log)
  const isElectron = nodeBin === process.execPath
  const tlsNote = insecureTls
    ? " TLS=insecure"
    : extraCaCerts && fs.existsSync(extraCaCerts)
      ? ` extraCaCerts=${extraCaCerts}`
      : ""
  log.appendLine(`[vcoder] spawning shared server: ${nodeBin} ${serverEntry} --port ${port} (NO_PROXY=${noProxy}${tlsNote})`)

  const child = spawn(nodeBin, [serverEntry, "--port", String(port)], {
    cwd: vcoderHomeDir(),
    env: {
      ...process.env,
      VCODER_CALLER: "vscode",
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      ...(isElectron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      ...(extraCaCerts && fs.existsSync(extraCaCerts) ? { NODE_EXTRA_CA_CERTS: extraCaCerts } : {}),
      ...(insecureTls ? { NODE_TLS_REJECT_UNAUTHORIZED: "0" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: false,
  })

  child.stdout?.on("data", (chunk: Buffer) => log.append(`[server:${port}] ${chunk.toString("utf8")}`))
  child.stderr?.on("data", (chunk: Buffer) => log.append(`[server:${port}!] ${chunk.toString("utf8")}`))
  child.on("exit", (code, signal) => {
    log.appendLine(`[vcoder] server (port ${port}) exited code=${code} signal=${signal}`)
    if (sharedServer?.proc === child) {
      sharedServer = undefined
      updateStatusBar("disconnected")
    }
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

function openChatPanel(context: vscode.ExtensionContext, port: number): void {
  if (chatPanel) {
    chatPanel.reveal(vscode.ViewColumn.Beside, false)
    postActiveFile()
    return
  }

  chatPanel = vscode.window.createWebviewPanel(
    "vcoder.chat",
    "vcoder",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  )

  chatPanel.iconPath = {
    light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
    dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
  }

  chatPanel.webview.html = buildChatHtml(port, currentTheme)

  chatPanel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === "pickContext") {
      const picks = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: true,
        openLabel: "Add to vcoder context",
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      })
      if (!picks?.length) return
      for (const uri of picks) {
        chatPanel?.webview.postMessage({ type: "addContextFile", path: workspaceRel(uri.fsPath) })
      }
    }
  })

  chatPanel.onDidDispose(() => {
    chatPanel = undefined
  })

  postActiveFile()
}

async function openTerminalTUI(
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

function buildChatHtml(port: number, theme: "dark" | "light"): string {
  const api = `http://127.0.0.1:${port}`
  const d = theme === "dark"
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src *;"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:var(--vscode-editor-background,${d ? "#1e1e1e" : "#ffffff"});
  --fg:var(--vscode-editor-foreground,${d ? "#d4d4d4" : "#333"});
  --fg2:var(--vscode-descriptionForeground,${d ? "#888" : "#666"});
  --input:var(--vscode-input-background,${d ? "#2d2d2d" : "#f5f5f5"});
  --border:var(--vscode-panel-border,${d ? "#3c3c3c" : "#ddd"});
  --accent:var(--vscode-button-background,${d ? "#0e639c" : "#007acc"});
  --accent-fg:var(--vscode-button-foreground,#fff);
  --user-bg:var(--vscode-editorWidget-background,${d ? "#252526" : "#f0f0f0"});
  --menu-bg:var(--vscode-editorWidget-background,${d ? "#252526" : "#fff"});
  --code-bg:var(--vscode-textCodeBlock-background,${d ? "#0d0d0d" : "#f4f4f4"});
}
body{font-family:var(--vscode-font-family,system-ui,sans-serif);font-size:var(--vscode-font-size,13px);background:var(--bg);color:var(--fg);height:100vh;display:flex;flex-direction:column;overflow:hidden}
#msgs{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:12px}
#msgs::-webkit-scrollbar{width:6px}
#msgs::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.msg{display:flex;gap:8px;animation:fadein .2s}
@keyframes fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.msg.user{flex-direction:row-reverse}
.bubble{max-width:82%;padding:8px 11px;border-radius:8px;line-height:1.55;white-space:pre-wrap;word-break:break-word;font-size:13px}
.msg.user .bubble{background:var(--accent);color:var(--accent-fg);border-radius:8px 2px 8px 8px}
.msg.ai .bubble{background:var(--user-bg);border-radius:2px 8px 8px 8px}
.msg.ai.typing .bubble::after{content:'▋';animation:blink 1s infinite}
@keyframes blink{50%{opacity:0}}
.msg.ai.err .bubble{color:#f48771}
pre{background:var(--code-bg);border-radius:5px;padding:10px 12px;overflow-x:auto;margin:6px 0;font-size:12px}
code{background:var(--code-bg);padding:1px 4px;border-radius:3px;font-size:0.88em;font-family:var(--vscode-editor-font-family,monospace)}
pre code{background:none;padding:0;font-size:inherit}
#bottom{border-top:1px solid var(--border);padding:8px 10px;display:flex;flex-direction:column;gap:6px}
#prompt{width:100%;min-height:52px;max-height:180px;background:var(--input);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:7px 9px;font-family:inherit;font-size:inherit;resize:none;outline:none;line-height:1.5;transition:border-color .15s}
#prompt:focus{border-color:var(--accent)}
#toolbar{display:flex;align-items:center;gap:5px;position:relative}
.btn{background:var(--input);color:var(--fg);border:1px solid var(--border);border-radius:5px;padding:4px 9px;cursor:pointer;font-size:12px;white-space:nowrap;line-height:1.4;transition:opacity .15s}
.btn:hover{opacity:.8}
.btn.primary{background:var(--accent);color:var(--accent-fg);border-color:transparent;padding:4px 14px;font-size:13px}
.btn.primary:disabled{opacity:.45;cursor:not-allowed}
.btn.active{border-color:var(--accent);color:var(--accent)}
#spacer{flex:1}
.drop{position:static}
.dmenu{position:absolute;bottom:calc(100% + 5px);left:0;right:0;background:var(--menu-bg);border:1px solid var(--border);border-radius:7px;z-index:200;box-shadow:0 6px 20px rgba(0,0,0,.35);overflow:hidden auto;min-width:0;max-height:60vh}
.dmenu.hidden{display:none}
.di{padding:7px 13px;cursor:pointer;font-size:12px;transition:background .1s}
.di:hover{background:var(--accent);color:var(--accent-fg)}
.di.cur{opacity:.55;cursor:default}
.di.section{opacity:.5;font-size:10px;padding:5px 13px 2px;text-transform:uppercase;letter-spacing:.05em;cursor:default}
.di.section:hover{background:none;color:inherit}
.dsep{border-top:1px solid var(--border);margin:3px 0}
#ollama-row{display:flex;flex-direction:column;gap:4px;padding:6px 8px}
#ollama-row .row{display:flex;gap:4px}
.ollama-in{flex:1;background:var(--input);color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:4px 7px;font-size:11px;outline:none;font-family:inherit;min-width:0}
.ollama-in:focus{border-color:var(--accent)}
.sdot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--border);margin-right:4px;vertical-align:middle}
.sdot.ok{background:#4caf50}
.sdot.busy{background:#ff9800;animation:pulse 1s infinite}
@keyframes pulse{50%{opacity:.3}}
#ctx{display:flex;flex-wrap:wrap;gap:4px;padding:0 0 4px 0}
#ctx:empty{display:none}
.chip{display:inline-flex;align-items:center;gap:4px;background:var(--input);border:1px solid var(--border);border-radius:10px;padding:1px 6px 1px 8px;font-size:11px;max-width:100%;line-height:1.6}
.chip .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}
.chip.active{border-color:var(--accent);opacity:.85}
.chip .x{cursor:pointer;opacity:.55;padding:0 2px;font-size:13px}
.chip .x:hover{opacity:1}
</style>
</head>
<body>
<div id="msgs"><div class="msg ai"><div class="bubble" style="opacity:.5;font-style:italic">VDS-Coder Agent sẵn sàng.</div></div></div>
<div id="bottom">
  <div id="ctx"></div>
  <textarea id="prompt" placeholder="Ask anything..." rows="2"></textarea>
  <div id="toolbar">
    <button class="btn" id="ctx-btn" title="Add file or folder to context">+</button>
    <div class="drop">
      <button class="btn" id="mode-btn">Code ▾</button>
      <div class="dmenu hidden" id="mode-menu">
        <div class="di" data-a="build" data-l="Code">Code <span style="opacity:.5;font-size:11px">— gen code</span></div>
        <div class="di" data-a="build" data-l="Edit">Edit <span style="opacity:.5;font-size:11px">— edit files</span></div>
        <div class="di" data-a="plan" data-l="Plan">Plan <span style="opacity:.5;font-size:11px">— plan only</span></div>
      </div>
    </div>
    <div class="drop">
      <button class="btn" id="models-btn">Models ▾</button>
      <div class="dmenu hidden" id="models-menu">
        <div id="mlist"><div class="di" style="opacity:.5;cursor:default">Loading...</div></div>
        <div class="dsep"></div>
        <div class="di section">Add Ollama model</div>
        <div id="ollama-row">
          <input class="ollama-in" id="ollama-host" placeholder="http://localhost:11434/v1" value="http://localhost:11434/v1" title="Ollama base URL (local IP, domain, or localhost)"/>
          <div class="row">
            <input class="ollama-in" id="ollama-in" placeholder="model name (e.g. llama3.2)"/>
            <button class="btn" id="ollama-add" style="font-size:11px;padding:4px 7px">Add</button>
          </div>
        </div>
      </div>
    </div>
    <div id="spacer"></div>
    <span class="sdot" id="sdot"></span>
    <button class="btn primary" id="send-btn">↑</button>
  </div>
</div>
<script>
const API='${api}';
const vscodeApi=typeof acquireVsCodeApi!=='undefined'?acquireVsCodeApi():null;
let sid=null,agent='build',modeLabel='Code',busy=false,aiEl=null,aiTxt='',pID=null,mID=null;
let activeFile=null;
const ctxFiles=[];
const $=id=>document.getElementById(id);
const msgsEl=$('msgs'),promptEl=$('prompt'),sendBtn=$('send-btn'),ctxEl=$('ctx');
const modeBtn=$('mode-btn'),modeMenu=$('mode-menu');
const modelsBtn=$('models-btn'),modelsMenu=$('models-menu'),mlistEl=$('mlist');
const ollamaIn=$('ollama-in'),ollamaHost=$('ollama-host'),ollamaAdd=$('ollama-add'),sdot=$('sdot');

function setBusy(b){busy=b;sendBtn.disabled=b;sdot.className='sdot '+(b?'busy':'ok')}
function scrollBot(){msgsEl.scrollTop=msgsEl.scrollHeight}

function addMsg(role,html){
  const d=document.createElement('div');d.className='msg '+role;
  const b=document.createElement('div');b.className='bubble';
  b.innerHTML=html;d.appendChild(b);msgsEl.appendChild(d);scrollBot();return b;
}

function startAI(){
  aiTxt='';
  const d=document.createElement('div');d.className='msg ai typing';
  const b=document.createElement('div');b.className='bubble';
  d.appendChild(b);msgsEl.appendChild(d);scrollBot();
  aiEl={w:d,b};return aiEl;
}

function deltaAI(t){
  if(!aiEl)startAI();
  aiTxt+=t;
  aiEl.b.textContent=aiTxt;scrollBot();
}

function endAI(){
  if(aiEl){aiEl.w.classList.remove('typing');aiEl=null;aiTxt='';}
}

// SSE
function connectSSE(){
  const es=new EventSource(API+'/event');
  es.onopen=()=>sdot.className='sdot ok';
  es.onerror=()=>{sdot.className='sdot';setTimeout(connectSSE,3000);};
  es.onmessage=e=>{
    try{const m=JSON.parse(e.data);onEv(m);}catch{}
  };
}

function onEv(m){
  const p=m.properties??{};
  if(m.type==='message.part.delta'&&p.sessionID===sid&&p.field==='text')deltaAI(p.delta);
  else if(m.type==='session.status'&&p.sessionID===sid&&p.status?.type!=='busy'&&busy){
    setBusy(false);endAI();
  }
}

// Session
async function init(){
  try{
    const r=await fetch(API+'/session');
    const list=await r.json();
    if(Array.isArray(list)&&list.length){sid=list[0].id;await loadMsgs();}
    else await newSession();
    setBusy(false);
  }catch(e){setTimeout(init,2000);}
}

async function newSession(){
  const r=await fetch(API+'/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  const s=await r.json();sid=s.id;
}

async function loadMsgs(){
  if(!sid)return;
  try{
    const r=await fetch(API+'/session/'+sid+'/message');
    const data=await r.json();
    const msgs=data.messages??data??[];
    for(const m of msgs){
      const role=m.info?.role==='user'?'user':'ai';
      const txt=(m.parts??[]).filter(p=>p.type==='text').map(p=>p.text).join('');
      if(txt)addMsg(role,esc(txt));
    }
  }catch{}
}

function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

// Context files
function ctxList(){
  const out=[...ctxFiles];
  if(activeFile&&!out.includes(activeFile))out.unshift(activeFile);
  return out;
}
function renderCtx(){
  ctxEl.innerHTML='';
  for(const f of ctxList()){
    const chip=document.createElement('span');chip.className='chip'+(f===activeFile&&!ctxFiles.includes(f)?' active':'');
    const name=document.createElement('span');name.className='name';name.textContent=f;chip.appendChild(name);
    if(ctxFiles.includes(f)){
      const x=document.createElement('span');x.className='x';x.textContent='×';x.title='Remove';
      x.onclick=ev=>{ev.stopPropagation();const i=ctxFiles.indexOf(f);if(i>=0){ctxFiles.splice(i,1);renderCtx();}};
      chip.appendChild(x);
    }
    ctxEl.appendChild(chip);
  }
}
function addCtx(p){
  if(!p)return;
  if(!ctxFiles.includes(p))ctxFiles.push(p);
  renderCtx();
}

// Send
async function send(){
  const txt=promptEl.value.trim();
  if(!txt||busy||!sid)return;
  const files=ctxList();
  const mentions=files.map(f=>'@'+f).join(' ');
  const full=mentions?mentions+'\\n'+txt:txt;
  promptEl.value='';promptEl.style.height='';
  addMsg('user',esc(full));
  setBusy(true);startAI();
  try{
    const body={parts:[{type:'text',text:full}],agent};
    if(pID&&mID)body.model={providerID:pID,modelID:mID};
    await fetch(API+'/session/'+sid+'/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  }catch(e){endAI();setBusy(false);addMsg('ai err',esc('Error: '+e.message));}
}

// Models
async function loadModels(){
  try{
    const r=await fetch(API+'/provider');
    const data=await r.json();
    renderModels(data.all??[]);
  }catch{}
}

function renderModels(providers){
  mlistEl.innerHTML='';
  const visible=providers.filter(p=>p.models?.length);
  if(!visible.length){mlistEl.innerHTML='<div class="di" style="opacity:.5;cursor:default;font-size:11px">No models</div>';return;}
  for(const p of visible){
    const sec=document.createElement('div');sec.className='di section';sec.textContent=p.name||p.id;mlistEl.appendChild(sec);
    for(const m of (p.models||[]).slice(0,8)){
      const el=document.createElement('div');el.className='di'+(mID===m.id&&pID===p.id?' cur':'');
      el.textContent=m.name||m.id;
      el.onclick=()=>{pID=p.id;mID=m.id;modelsBtn.textContent=(m.name||m.id).slice(0,16)+' ▾';closeAll();};
      mlistEl.appendChild(el);
    }
  }
}

function normalizeHost(h){
  let v=(h||'').trim();
  if(!v)return 'http://localhost:11434/v1';
  if(!/^https?:\\/\\//i.test(v))v='http://'+v;
  v=v.replace(/\\/+$/,'');
  if(!/\\/v\\d+$/.test(v))v+='/v1';
  return v;
}

async function addOllama(){
  const name=ollamaIn.value.trim();if(!name)return;
  const api=normalizeHost(ollamaHost.value);
  ollamaAdd.disabled=true;
  try{
    const cfg=await(await fetch(API+'/config')).json();
    const provider=cfg.provider??{};
    const prev=provider.ollama??{};
    const models={...(prev.models??{})};
    models[name]={...(models[name]??{}),name};
    provider.ollama={
      ...prev,
      name:prev.name||'Ollama',
      npm:'@ai-sdk/openai-compatible',
      api,
      options:{...(prev.options??{}),baseURL:api},
      models,
    };
    const r=await fetch(API+'/config',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider})});
    if(!r.ok){const t=await r.text();throw new Error('PATCH /config '+r.status+': '+t);}
    ollamaIn.value='';await loadModels();await loadOllamaConfig();
  }catch(e){console.error('addOllama failed',e);addMsg('ai err',esc('Add model failed: '+e.message));}finally{ollamaAdd.disabled=false;}
}

async function loadOllamaConfig(){
  try{
    const cfg=await(await fetch(API+'/config')).json();
    const ol=cfg.provider?.ollama;
    if(ol){
      const url=ol.options?.baseURL||ol.api;
      if(url)ollamaHost.value=url;
    }
  }catch{}
}

// Dropdowns
function closeAll(){modeMenu.classList.add('hidden');modelsMenu.classList.add('hidden');}
modeBtn.onclick=e=>{e.stopPropagation();const o=!modeMenu.classList.contains('hidden');closeAll();if(!o)modeMenu.classList.remove('hidden');};
modelsBtn.onclick=e=>{e.stopPropagation();const o=!modelsMenu.classList.contains('hidden');closeAll();if(!o){modelsMenu.classList.remove('hidden');loadModels();}};
modeMenu.querySelectorAll('.di[data-a]').forEach(el=>el.onclick=e=>{e.stopPropagation();agent=el.dataset.a;modeLabel=el.dataset.l;modeBtn.textContent=modeLabel+' ▾';closeAll();});
document.addEventListener('click',closeAll);
ollamaAdd.onclick=e=>{e.stopPropagation();addOllama();};
ollamaIn.onclick=e=>e.stopPropagation();
ollamaHost.onclick=e=>e.stopPropagation();
ollamaIn.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();addOllama();}};
ollamaHost.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();ollamaIn.focus();}};

// Submit
sendBtn.onclick=send;
promptEl.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}};
promptEl.oninput=()=>{promptEl.style.height='auto';promptEl.style.height=Math.min(promptEl.scrollHeight,180)+'px';};

// Messages from extension
window.addEventListener('message',e=>{
  const d=e.data;if(!d)return;
  if(d.type==='themeChange'){
    const d2=d.theme==='dark';
    document.documentElement.style.setProperty('--bg',d2?'#1e1e1e':'#fff');
  }else if(d.type==='activeFile'){
    activeFile=d.path||null;renderCtx();
  }else if(d.type==='addContextFile'){
    addCtx(d.path);
  }
});

// + button: ask the extension to open a file/folder picker
$('ctx-btn').onclick=()=>{vscodeApi?.postMessage({type:'pickContext'});};

connectSSE();init();loadOllamaConfig();
</script>
</body>
</html>`
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
