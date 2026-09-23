# FINDINGS #80: portable rebuild — $PSScriptRoot is wherever this script
# lives, so the SAME file works on the home tree and the work clone without
# editing paths. Run it, then just relaunch Claude Desktop.
Set-Location $PSScriptRoot
if (-not (Test-Path (Join-Path $PSScriptRoot 'package.json'))) {
    Write-Host "No package.json at $PSScriptRoot — script must live in the repo root. Nothing built." -ForegroundColor Red
    exit 1
}
Write-Host "Tree: $PSScriptRoot" -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -eq 0) {
    Stop-Process -Name "Claude" -Force -ErrorAction SilentlyContinue
    Write-Host "Built and killed the tray — relaunch Claude Desktop now." -ForegroundColor Green
} else {
    Write-Host "BUILD FAILED — server untouched, fix the error first." -ForegroundColor Red
}
