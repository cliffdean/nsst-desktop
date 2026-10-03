# 重新備份屏幕目前的整顆 32MB Flash(約 1~2 分鐘)。預設存成 e1002-backup-<時間>.bin，不會蓋掉出廠備份
#   .\firmware\backup-factory.ps1
#   .\firmware\backup-factory.ps1 -Port COM5 -Out D:\backup\x.bin
param(
  [string]$Port = 'COM23',
  [string]$Out = (Join-Path $PSScriptRoot ('backup\e1002-backup-{0}.bin' -f (Get-Date -Format 'yyyyMMdd-HHmm')))
)
. "$PSScriptRoot\common.ps1"
& (Get-Esptool) --port $Port -b 921600 read_flash 0 0x2000000 $Out
if ($LASTEXITCODE -ne 0) { throw '讀取失敗(電源開關要在 ON、序列埠沒被佔用)' }
Write-Host "已備份：$Out" -ForegroundColor Green
