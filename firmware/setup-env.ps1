# 新電腦重建燒錄環境(第一次用)。事先要手動做：到 https://github.com/arduino/arduino-cli/releases
# 下載 Windows 64bit zip，解壓到 D:\MyTools\tools\arduino-cli ；並已安裝 git、Python。
#   .\firmware\setup-env.ps1
. "$PSScriptRoot\common.ps1"
if (-not (Test-Path $Cli)) { throw "找不到 arduino-cli：$Cli (先下載解壓，見檔頭說明)" }

& $Cli config init 2>$null
& $Cli config add board_manager.additional_urls https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
& $Cli core update-index
& $Cli core install esp32:esp32@3.1.1

$userDir = (& $Cli config get directories.user | Where-Object { $_.Trim() } | Select-Object -First 1).Trim()
$libs = Join-Path $userDir 'libraries'
New-Item -ItemType Directory -Force $libs | Out-Null
foreach ($r in @(
    @('Seeed_GFX', 'https://github.com/Seeed-Studio/Seeed_GFX.git'),
    @('OpenFontRender', 'https://github.com/takkaO/OpenFontRender.git'))) {
  if (-not (Test-Path (Join-Path $libs $r[0]))) { git clone --depth 1 $r[1] (Join-Path $libs $r[0]) }
}
& $Cli lib install 'ArduinoJson@7' 'PubSubClient'
Write-Host "完成。函式庫資料夾：$libs" -ForegroundColor Green
