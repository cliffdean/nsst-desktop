# 測試用小 sketch(hello、hw_test…)：編譯 / 燒錄 / 看序列埠 log(8MB 預設分割表，不是屏幕固件)
#   .\firmware\sketch.ps1 hello                編譯並燒錄 firmware\hello
#   .\firmware\sketch.ps1 hello -Monitor       燒完接著看 log(Ctrl+C 結束)
#   .\firmware\sketch.ps1 hello -MonitorOnly   只看 log
#   .\firmware\sketch.ps1 hello -Port COM5     換序列埠(預設 COM23)
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Name,
  [switch]$Monitor,
  [switch]$MonitorOnly,
  [string]$Port = 'COM23'
)
. "$PSScriptRoot\common.ps1"
Set-Location (Join-Path $PSScriptRoot $Name)

if (-not $MonitorOnly) {
  & $Cli compile -b $Fqbn --library (Get-SeeedGfx) --output-dir build .
  if ($LASTEXITCODE -ne 0) { throw '編譯失敗' }
  & $Cli upload -b $Fqbn -p $Port --input-dir build .
  if ($LASTEXITCODE -ne 0) { throw '燒錄失敗(電源開關要在 ON、序列埠沒被佔用)' }
}
if ($Monitor -or $MonitorOnly) { & $Cli monitor -p $Port -c baudrate=115200 }
