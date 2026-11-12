# Starts the DEMO API (4100) and web app (3100) against the separate vso_demo database, detached.
# Usage (PowerShell, from this folder):  .\demo-start.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force _logs | Out-Null
$env:MONGODB_URI = "mongodb://127.0.0.1:27017/?directConnection=true"
$env:MONGODB_DB = "vso_demo"
$env:PORT = "4100"
$env:APP_ORIGIN = "http://localhost:3100"
$env:API_ORIGIN = "http://localhost:4100"
$env:APP_MODE = "local"
$env:ALLOW_DEV_AUTH = "true"
$env:NODE_ENV = "development"
$env:SALES_FINDER = "off"
$env:VSO_API_ORIGIN = "http://localhost:4100"
Start-Process -FilePath "cmd.exe" -ArgumentList '/c', 'npm run dev --workspace @venture-studio/api > _logs\api.log 2>&1' -WindowStyle Hidden
$webLog = Join-Path $PSScriptRoot "_logs\web.log"
Start-Process -FilePath "cmd.exe" -ArgumentList '/c', "npx next dev -p 3100 > `"$webLog`" 2>&1" -WorkingDirectory (Join-Path $PSScriptRoot "apps\web") -WindowStyle Hidden
Write-Host "Demo API: http://localhost:4100   Demo web: http://localhost:3100"
