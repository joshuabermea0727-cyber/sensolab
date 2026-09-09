# start-demo.ps1 — levanta SensoLab y abre un túnel público.
#   Uso:  ./start-demo.ps1
#   Requiere: Docker Desktop abierto + cloudflared instalado.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "==> Levantando el contenedor (app + sitio + backend)..." -ForegroundColor Cyan
docker compose up -d --build

Write-Host "==> Esperando a que el backend responda..." -ForegroundColor Cyan
for ($i = 0; $i -lt 20; $i++) {
  try { Invoke-RestMethod http://localhost:4000/api/health -TimeoutSec 2 | Out-Null; break }
  catch { Start-Sleep 1 }
}
Write-Host "    OK — http://localhost:4000" -ForegroundColor Green

$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) { $cf = "C:\Program Files (x86)\cloudflared\cloudflared.exe" }
if (-not (Test-Path $cf)) {
  Write-Host "cloudflared no encontrado. Instálalo con:  winget install Cloudflare.cloudflared" -ForegroundColor Yellow
  exit 1
}

Write-Host ""
Write-Host "==> Abriendo túnel público. Comparte la URL https://XXXX.trycloudflare.com que aparezca." -ForegroundColor Cyan
Write-Host "    (la app estará en esa URL; el sitio en esa URL + /site/)" -ForegroundColor DarkGray
Write-Host "    Ctrl+C para cerrar el túnel. El contenedor sigue vivo; apágalo con: docker compose down" -ForegroundColor DarkGray
Write-Host ""
& $cf tunnel --url http://localhost:4000 --no-autoupdate
