# Installs Jarvis to start automatically when you log in (no admin required).
# Creates a shortcut in your Startup folder that launches the web cockpit hidden.
#
#   Run once:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   Remove:    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$root = Split-Path -Parent $scriptDir
$vbs = Join-Path $scriptDir "jarvis-hidden.vbs"

if (-not (Test-Path $vbs)) { throw "Launcher not found: $vbs" }

# Sanity: node must be on PATH for the logon launch to work.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Warning "node was not found on PATH. Jarvis will not start at logon until Node.js is on PATH." }

$startup = [Environment]::GetFolderPath("Startup")
$lnk = Join-Path $startup "Jarvis.lnk"

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = "wscript.exe"
$sc.Arguments = '"' + $vbs + '"'
$sc.WorkingDirectory = $root
$sc.Description = "Jarvis - AI Chief of Staff (web cockpit)"
$sc.WindowStyle = 7
$sc.Save()

Write-Host ""
Write-Host "  Installed auto-start:" -ForegroundColor Green
Write-Host "    $lnk"
Write-Host "    launches (hidden): $vbs"
Write-Host ""
Write-Host "  Jarvis starts next time you log in and opens http://127.0.0.1:4321"
Write-Host "  Start it now without rebooting:"
Write-Host ("    wscript " + '"' + $vbs + '"') -ForegroundColor Cyan
Write-Host "  Remove auto-start:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1"
Write-Host ""
