#include "setup.h"
#include <WiFi.h>
#include <DNSServer.h>
#include <WebServer.h>
#include "board.h"
#include "devserver.h"
#include "display.h"
#include "fonts.h"
#include "pages.h"

static const char kPortalHtml[] PROGMEM = R"HTML(<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>設定屏幕 WiFi</title>
<style>
body{font-family:system-ui,-apple-system,"Microsoft JhengHei",sans-serif;margin:0;background:#f4f6fa;color:#222}
header{background:#2f6fd8;color:#fff;padding:16px;font-size:19px;font-weight:600}
main{padding:14px;max-width:520px;margin:0 auto}
.card{background:#fff;border-radius:12px;padding:6px 14px;margin-bottom:12px;box-shadow:0 1px 3px #0002}
.net{display:flex;justify-content:space-between;align-items:center;padding:14px 4px;border-bottom:1px solid #eee;font-size:16px}
.net:last-child{border:0}
input{width:100%;box-sizing:border-box;padding:13px;font-size:16px;margin:8px 0;border:1px solid #ccd;border-radius:8px}
button{width:100%;padding:14px;font-size:16px;border:0;border-radius:10px;background:#2f6fd8;color:#fff;margin:6px 0}
button.gray{background:#8892a6}
.muted{color:#778;font-size:13px;padding:8px 0}.ok{color:#1a8f3c;font-weight:600}.err{color:#c8283c}
</style></head><body><header>設定屏幕 WiFi</header><main>
<div class="card" id="list"><div class="muted">正在搜尋附近的 WiFi…</div></div>
<div class="card" id="form" style="display:none">
<div id="sel" style="font-weight:600;padding-top:10px"></div>
<input id="pw" type="password" placeholder="WiFi 密碼(開放網路留空)" autocomplete="off">
<button id="go">連線</button><div id="msg" class="muted"></div></div>
<button class="gray" id="rescan">重新搜尋</button>
</main><script>
var $=function(i){return document.getElementById(i)},chosen='';
function esc(s){return s.replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function bars(r){return r>-55?'▂▄▆█':r>-67?'▂▄▆':r>-78?'▂▄':'▂'}
function scan(){
  $('list').innerHTML='<div class="muted">正在搜尋附近的 WiFi…(約 5 秒)</div>';
  fetch('/wifi/scan').then(function(r){return r.json()}).then(function(a){
    $('list').innerHTML=a.length?a.map(function(n){return '<div class="net" data-s="'+encodeURIComponent(n.ssid)+'"><span>'+esc(n.ssid)+(n.open?'':' 🔒')+'</span><span class="muted">'+bars(n.rssi)+'</span></div>'}).join(''):'<div class="muted">沒有找到 WiFi，請靠近一點再重新搜尋</div>';
  }).catch(function(){$('list').innerHTML='<div class="err" style="padding:12px 0">搜尋失敗，請按「重新搜尋」</div>'});
}
$('list').onclick=function(e){var n=e.target.closest('.net');if(!n)return;chosen=decodeURIComponent(n.dataset.s);
  $('sel').textContent=chosen;$('form').style.display='block';$('msg').textContent='';$('pw').value='';$('pw').focus()};
$('rescan').onclick=scan;
$('go').onclick=function(){
  if(!chosen)return;$('go').disabled=true;$('msg').className='muted';$('msg').textContent='連線中…(約 10 秒)';
  fetch('/wifi/connect',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:'ssid='+encodeURIComponent(chosen)+'&pass='+encodeURIComponent($('pw').value)}).then(poll);
};
function poll(){
  fetch('/wifi/status').then(function(r){return r.json()}).then(function(s){
    if(s.state==='ok'){$('msg').className='ok';$('msg').innerHTML='已連上「'+esc(s.ssid)+'」<br>屏幕 IP：<b>'+s.ip+'</b><br>接下來請在桌面工具輸入這個 IP。你的手機會自動切回原本的網路。';return}
    if(s.state==='fail'){$('go').disabled=false;$('msg').className='err';$('msg').textContent='連線失敗，請確認密碼後再試一次';return}
    setTimeout(poll,1000)}).catch(function(){setTimeout(poll,1500)});
}
scan();
</script></body></html>)HTML";

enum class ConnState { Idle, Connecting, Ok, Fail };

static DNSServer dns;
static ConnState connState = ConnState::Idle;
static String connSsid, connPass, connIp;
static uint32_t connStartedAt = 0;
static uint32_t okAt = 0;
static String scanCache;
static uint32_t scanAt = 0;

static void sendPortal() {
  devServerHttp().send_P(200, "text/html; charset=utf-8", kPortalHtml);
}

// 同一個名稱只留訊號最強的一個(多個AP/多頻段的同名網路)，依訊號排序
static void handleScan() {
  if (scanCache.length() == 0 || millis() - scanAt > 8000) {
    int n = WiFi.scanNetworks(false, false);
    JsonDocument doc;
    JsonArray arr = doc.to<JsonArray>();
    for (int i = 0; i < n; i++) {
      String ssid = WiFi.SSID(i);
      if (ssid.length() == 0) continue;
      bool dup = false;
      for (JsonObject o : arr) {
        if (o["ssid"] == ssid) {
          dup = true;
          if (WiFi.RSSI(i) > o["rssi"].as<int>()) o["rssi"] = WiFi.RSSI(i);
        }
      }
      if (dup) continue;
      JsonObject o = arr.add<JsonObject>();
      o["ssid"] = ssid;
      o["rssi"] = WiFi.RSSI(i);
      o["open"] = WiFi.encryptionType(i) == WIFI_AUTH_OPEN;
    }
    WiFi.scanDelete();
    // 依訊號強到弱排序(簡單的選擇排序，數量不多)
    for (size_t i = 0; i < arr.size(); i++) {
      for (size_t j = i + 1; j < arr.size(); j++) {
        if (arr[j]["rssi"].as<int>() > arr[i]["rssi"].as<int>()) {
          JsonDocument tmp;
          tmp.set(arr[i]);
          arr[i].set(arr[j]);
          arr[j].set(tmp);
        }
      }
    }
    scanCache = "";
    serializeJson(doc, scanCache);
    scanAt = millis();
  }
  devServerHttp().send(200, "application/json", scanCache);
}

static void handleConnect() {
  WebServer &http = devServerHttp();
  connSsid = http.arg("ssid");
  connPass = http.arg("pass");
  if (connSsid.length() == 0) {
    http.send(400, "text/plain", "ssid required");
    return;
  }
  Serial.printf("[setup] connect to '%s'\n", connSsid.c_str());
  connState = ConnState::Connecting;
  connStartedAt = millis();
  WiFi.begin(connSsid.c_str(), connPass.c_str());
  http.send(200, "application/json", "{\"ok\":true}");
}

static void handleWifiStatus() {
  JsonDocument doc;
  const char *names[] = {"idle", "connecting", "ok", "fail"};
  doc["state"] = names[(int)connState];
  doc["ssid"] = connSsid;
  doc["ip"] = connIp;
  String out;
  serializeJson(doc, out);
  devServerHttp().send(200, "application/json", out);
}

// 手機的「需要登入網路」偵測會請求各種固定網址(generate_204、hotspot-detect…)，一律導到設定頁就會自動彈出
static void handleNotFound() {
  WebServer &http = devServerHttp();
  http.sendHeader("Location", "http://192.168.4.1/", true);
  http.send(302, "text/plain", "");
}

static void serviceOnce() {
  dns.processNextRequest();
  devServerLoop();
}

void setupModeRun(AppConfig &cfg) {
  Serial.println("[setup] enter setup mode");
  // 兩聲嗶：兩顆白鍵按滿2秒，進入設定模式
  boardBeep(120);
  delay(180);
  boardBeep(120);
  boardLed(true);

  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP_STA);
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char apName[24];
  snprintf(apName, sizeof(apName), "NSST-Screen-%02X%02X", mac[4], mac[5]);
  WiFi.softAP(apName); // 開放熱點：只在使用者按住按鍵的這段時間存在，而且設定頁只能選WiFi，不會洩漏什麼
  delay(300);
  IPAddress apIp = WiFi.softAPIP();
  dns.start(53, "*", apIp);
  Serial.printf("[setup] AP '%s' at %s\n", apName, apIp.toString().c_str());

  devServerAuthOpen(true);
  WebServer &http = devServerHttp();
  // 先註冊設定頁的路由(WebServer依註冊順序比對，「/」要比 devServer 的 /info 先)
  http.on("/", HTTP_GET, sendPortal);
  http.on("/wifi/scan", HTTP_GET, handleScan);
  http.on("/wifi/connect", HTTP_POST, handleConnect);
  http.on("/wifi/status", HTTP_GET, handleWifiStatus);
  http.onNotFound(handleNotFound);
  devServerBegin(&cfg);

  // 說明頁畫在電子紙上(約35秒)，期間手機其實已經可以連熱點
  displayBegin();
  fontsLoad();
  pageSetupWifi(apName);
  displayFlush();
  boardLed(false);

  uint32_t startedAt = millis();
  const uint32_t apTimeout = 5UL * 60 * 1000;
  bool doneDrawn = false;
  uint32_t lanDeadline = 0;

  while (true) {
    serviceOnce();

    if (connState == ConnState::Connecting) {
      if (WiFi.status() == WL_CONNECTED) {
        connState = ConnState::Ok;
        connIp = WiFi.localIP().toString();
        okAt = millis();
        configAddWifi(cfg, connSsid, connPass);
        configSave(cfg);
        Serial.printf("[setup] wifi ok %s ip=%s\n", connSsid.c_str(), connIp.c_str());
      } else if (millis() - connStartedAt > 20000) {
        connState = ConnState::Fail;
        WiFi.disconnect(false);
        Serial.println("[setup] wifi connect failed");
      }
    }
    // 連上後先讓手機把「成功」頁面拿走，再關熱點、畫說明頁、進入等待桌面工具的階段
    if (connState == ConnState::Ok && !doneDrawn && millis() - okAt > 6000) {
      doneDrawn = true;
      dns.stop();
      WiFi.softAPdisconnect(true);
      WiFi.mode(WIFI_STA);
      boardLed(true);
      pageSetupDone(connSsid, connIp);
      displayFlush();
      boardLed(false);
      lanDeadline = millis() + 10UL * 60 * 1000;
    }
    if (doneDrawn) {
      if (devServerTakeConfigChanged() || devServerRebootRequested()) break; // 桌面工具已把設定寫進來
      if ((int32_t)(millis() - lanDeadline) > 0) break;
    } else if (millis() - startedAt > apTimeout && connState != ConnState::Connecting) {
      Serial.println("[setup] timeout, leaving");
      break;
    }
    // 再按一次兩顆白鍵可提前離開
    if (digitalRead(PIN_KEY_MIDDLE) == LOW && digitalRead(PIN_KEY_LEFT) == LOW) {
      delay(1500);
      if (digitalRead(PIN_KEY_MIDDLE) == LOW && digitalRead(PIN_KEY_LEFT) == LOW) break;
    }
    delay(2);
  }
  devServerAuthOpen(false);
  Serial.println("[setup] done");
  delay(500); // 讓最後一個HTTP回應送完
  boardBeep(400); // 一聲長嗶：離開設定模式
}
