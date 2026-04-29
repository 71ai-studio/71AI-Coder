#Requires -Version 5.1
<#
.SYNOPSIS
  Build vcoder: server bundle + VS Code extension.

.PARAMETER SkipInstall
  Skip bun install (use when dependencies are already up to date).

.PARAMETER VsixOnly
  After building, also package a .vsix file.

.EXAMPLE
  .\build.ps1
  .\build.ps1 -VsixOnly
  .\build.ps1 -SkipInstall -VsixOnly
#>
param(
    [switch]$SkipInstall,
    [switch]$VsixOnly
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location $Root

function Step($n, $total, $msg) {
    Write-Host ""
    Write-Host "[$n/$total] $msg" -ForegroundColor Cyan
}

function Ok($msg)  { Write-Host "  OK  $msg" -ForegroundColor Green }
function Err($msg) { Write-Host "  ERR $msg" -ForegroundColor Red; exit 1 }

function Run($cmd, $args) {
    & $cmd @args
    if ($LASTEXITCODE -ne 0) { Err "'$cmd $($args -join ' ')' failed (exit $LASTEXITCODE)" }
}

$total = if ($SkipInstall) { 2 } else { 3 }
if ($VsixOnly) { $total++ }

Write-Host ""
Write-Host "=======================================" -ForegroundColor White
Write-Host "  vcoder build" -ForegroundColor White
Write-Host "=======================================" -ForegroundColor White

$step = 1

# ── 1. Install dependencies ───────────────────────────────────────────────
if (-not $SkipInstall) {
    Step $step $total "Installing dependencies (npm install)"
    Run npm @("install")
    Ok "dependencies ready"
    $step++
}

# ── 2. Build server bundle ────────────────────────────────────────────────
Step $step $total "Building server  →  server\dist\index.js"
Run npm @("run", "build", "--workspace=server")
$size = [math]::Round((Get-Item "$Root\server\dist\index.js").Length / 1MB, 1)
Ok "server\dist\index.js  ($size MB)"
$step++

# ── 3. Build extension (type-check + esbuild + stage server) ─────────────
Step $step $total "Building extension  →  extension\dist\extension.js"
Run npm @("run", "package", "--workspace=extension")
Ok "extension\dist\extension.js"
Ok "extension\server\  (staged for .vsix)"
$step++

# ── 4. (optional) Package .vsix ──────────────────────────────────────────
if ($VsixOnly) {
    Step $step $total "Packaging .vsix"
    Set-Location "$Root\extension"
    Run npx @("vsce", "package", "--no-dependencies")
    Set-Location $Root
    $vsix = Get-ChildItem "$Root\extension\*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Ok $vsix.FullName
}

Write-Host ""
Write-Host "=======================================" -ForegroundColor White
Write-Host "  Build complete!" -ForegroundColor Green
Write-Host "=======================================" -ForegroundColor White
Write-Host ""
if (-not $VsixOnly) {
    Write-Host "To package .vsix:" -ForegroundColor Yellow
    Write-Host "  .\build.ps1 -VsixOnly -SkipInstall" -ForegroundColor Yellow
    Write-Host ""
}
