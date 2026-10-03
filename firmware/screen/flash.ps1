# 屏幕固件：編譯 + 燒錄。在 PowerShell 執行(任何位置都可以)：
#   .\firmware\screen\flash.ps1                 只燒程式(用現有的 build，最常用)
#   .\firmware\screen\flash.ps1 -Compile        先編譯再燒程式
#   .\firmware\screen\flash.ps1 -Compile -Full  編譯後整套燒(bootloader+分區表+程式，改了 partitions.csv 才需要)
#   .\firmware\screen\flash.ps1 -Port COM5      換序列埠(預設 COM23)
param(
  [switch]$Compile,
  [switch]$Full,
  [string]$Port = 'COM23'
)
. "$PSScriptRoot\..\common.ps1"
Set-Location $PSScriptRoot

if ($Compile) {
  & $Cli compile -b $Fqbn --library (Get-SeeedGfx) `
    --build-property build.flash_size=32MB --build-property upload.maximum_size=4194304 `
    --output-dir build .
  if ($LASTEXITCODE -ne 0) { throw '編譯失敗' }
}

$et = Get-Esptool
$common = @('--chip', 'esp32s3', '--port', $Port, '-b', '921600', 'write_flash',
            '--flash_mode', 'dio', '--flash_freq', '80m', '--flash_size', '32MB')
if ($Full) {
  & $et @common 0x0 build\screen.ino.bootloader.bin 0x8000 build\screen.ino.partitions.bin 0xe000 (Get-BootApp0) 0x10000 build\screen.ino.bin
} else {
  & $et @common 0x10000 build\screen.ino.bin
}
if ($LASTEXITCODE -ne 0) { throw '燒錄失敗(序列埠被佔用？板子有接 USB？電源開關在 ON？)' }
Write-Host '完成，屏幕已重開機' -ForegroundColor Green
