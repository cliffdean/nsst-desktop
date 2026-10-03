# 把字型傳到屏幕的 flash:/fonts/(屏幕自己從這台電腦下載，所以電腦與屏幕要在同一個區網)
#   .\firmware\upload-fonts.ps1 -ScreenIp 192.168.1.50 -Password <MQTT密碼>
# 密碼是桌面工具「電子紙看板」設定裡的 MQTT 密碼。字型檔先用 python firmware\fonts\make_fonts.py 產生。
param(
  [Parameter(Mandatory = $true)][string]$ScreenIp,
  [Parameter(Mandatory = $true)][string]$Password,
  [string[]]$Files = @('NotoSansTC-Regular.ttf', 'NotoSansTC-Bold.ttf'),
  [int]$HttpPort = 8765
)
. "$PSScriptRoot\common.ps1"
$myIp = Get-LocalIp
if (-not $myIp) { throw '找不到這台電腦的區網 IP' }
Write-Host "電腦 $myIp  →  屏幕 $ScreenIp"

$server = Start-Process python -ArgumentList @('-m', 'http.server', $HttpPort, '--bind', '0.0.0.0') `
  -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 1
try {
  $h = @{ 'X-Auth' = $Password }
  foreach ($f in $Files) {
    $local = Join-Path $PSScriptRoot "fonts\$f"
    if (-not (Test-Path $local)) { throw "找不到 $local (先執行 python firmware\fonts\make_fonts.py)" }
    Write-Host "傳送 $f ..."
    $url = "http://${myIp}:${HttpPort}/fonts/$f"
    Invoke-RestMethod -Method Post -Headers $h -TimeoutSec 180 `
      -Uri "http://$ScreenIp/fetch?url=$([uri]::EscapeDataString($url))&path=flash:/fonts/$f" | Out-Null
    $remote = Invoke-RestMethod -Headers $h -Uri "http://$ScreenIp/md5?path=flash:/fonts/$f"
    $remoteMd5 = if ($remote.md5) { "$($remote.md5)" } else { "$remote".Trim() }
    $localMd5 = (Get-FileHash $local -Algorithm MD5).Hash.ToLower()
    $ok = $remoteMd5.ToLower() -eq $localMd5
    $color = if ($ok) { 'Green' } else { 'Red' }
    $msg = if ($ok) { '一致' } else { '不一致！請重傳' }
    Write-Host "  MD5 屏幕 $remoteMd5 / 本機 $localMd5  $msg" -ForegroundColor $color
  }
} finally {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}
