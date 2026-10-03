# 把備份整顆寫回屏幕(連同當時的 Wi-Fi 與 SenseCraft 綁定一起還原)，會覆蓋掉自製固件與字型
#   .\firmware\restore-factory.ps1                    寫回出廠備份 e1002-factory-32MB.bin
#   .\firmware\restore-factory.ps1 -File x.bin -Port COM5
param(
  [string]$File = (Join-Path $PSScriptRoot 'backup\e1002-factory-32MB.bin'),
  [string]$Port = 'COM23'
)
. "$PSScriptRoot\common.ps1"
if (-not (Test-Path $File)) { throw "找不到備份檔：$File" }
$ans = Read-Host '這會覆蓋屏幕上的全部內容(自製固件、字型、設定)，輸入 yes 繼續'
if ($ans -ne 'yes') { Write-Host '已取消'; return }
& (Get-Esptool) --port $Port -b 921600 write_flash 0 $File
if ($LASTEXITCODE -ne 0) { throw '寫入失敗' }
Write-Host '已還原' -ForegroundColor Green
