# Build POS + KDS Windows installers on a Windows PC (no GitHub Actions needed).
# Usage (PowerShell, from repo root):
#   pnpm install
#   .\scripts\build-windows-installers.ps1
#
# Output:
#   dist\Code Orbit POS Setup 0.2.0.exe
#   dist-installers\kds\Code Orbit KDS Setup 0.2.0.exe

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

Write-Host "==> Generate Prisma client"
pnpm db:generate

Write-Host "==> Prepare Prisma for Electron packaging"
pnpm prisma:prepare-electron

Write-Host "==> Build seeded SQLite DB"
pnpm db:seedfile

Write-Host "==> Rebuild serialport for Electron"
pnpm serial:rebuild

Write-Host "==> Build POS bundle"
pnpm build

Write-Host "==> Build POS Windows installer"
pnpm exec electron-builder --win nsis --publish never

Write-Host "==> Build KDS bundle"
pnpm build:kds

Write-Host "==> Build KDS Windows installer"
pnpm exec electron-builder --config electron-builder.kds.yml --win nsis --publish never

Write-Host ""
Write-Host "Done. Installers:"
Get-ChildItem -Path dist, dist-installers\kds -Filter *.exe -Recurse -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty FullName
