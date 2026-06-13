# Removes the Jarvis auto-start shortcut from your Startup folder.
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1

$ErrorActionPreference = "Stop"
$lnk = Join-Path ([Environment]::GetFolderPath("Startup")) "Jarvis.lnk"

if (Test-Path $lnk) {
  Remove-Item $lnk -Force
  Write-Host "  Removed auto-start: $lnk" -ForegroundColor Green
} else {
  Write-Host "  No auto-start shortcut found (nothing to remove)."
}

# Note: this does not stop a server that's currently running. To stop it:
#   Get-NetTCPConnection -LocalPort 4321 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
