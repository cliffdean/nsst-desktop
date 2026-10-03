# 固件腳本共用的路徑與函式(由其他 .ps1 用 . "$PSScriptRoot\common.ps1" 載入，不用單獨執行)
$ErrorActionPreference = 'Stop'
# arduino-cli 輸出是 UTF-8，中文版 Windows 主控台預設 GBK 會把中文路徑讀成亂碼
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$script:Cli  = 'D:\MyTools\tools\arduino-cli\arduino-cli.exe'
$script:Fqbn = 'esp32:esp32:XIAO_ESP32S3:PSRAM=opi,CDCOnBoot=cdc'
$script:A15  = Join-Path $env:LOCALAPPDATA 'Arduino15\packages\esp32'

function Get-SeeedGfx {
  # Seeed_GFX 裝在 arduino-cli 的使用者資料夾(directories.user)\libraries 底下
  $user = (& $script:Cli config get directories.user | Where-Object { $_.Trim() } | Select-Object -First 1).Trim()
  $p = Join-Path $user 'libraries\Seeed_GFX'
  if (-not (Test-Path $p)) { throw "找不到 Seeed_GFX：$p (先執行 .\firmware\setup-env.ps1)" }
  return $p
}

function Get-Esptool {
  $f = Get-ChildItem (Join-Path $script:A15 'tools\esptool_py\*\esptool.exe') | Sort-Object FullName | Select-Object -Last 1
  if (-not $f) { throw '找不到 esptool(要先裝 ESP32 Core，執行 .\firmware\setup-env.ps1)' }
  return $f.FullName
}

function Get-BootApp0 {
  return (Get-ChildItem (Join-Path $script:A15 'hardware\esp32\*\tools\partitions\boot_app0.bin') | Select-Object -Last 1).FullName
}

function Get-LocalIp {
  # 電腦在區網的 IP(給屏幕下載字型用)；排除虛擬網卡與 169.254
  $ip = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '127.0.0.1' -and $_.InterfaceAlias -notmatch 'vEthernet|VMware|VirtualBox|Loopback' } |
    Select-Object -First 1
  return $ip.IPAddress
}
