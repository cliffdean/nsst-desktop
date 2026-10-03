#include "devserver.h"
#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <MD5Builder.h>
#include <ESPmDNS.h>
#include <SD.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include "board.h"
#include "display.h"

static WebServer server(80);
static bool started = false;
static int renderRequested = 0; // 0=無 1=畫並刷新 2=只畫到記憶體(試畫)
static int renderPage = -1;     // 要求畫第幾頁(從0開始)，-1=目前頁
static AppConfig *gCfg = nullptr;
static bool authOpen = false;     // 設定視窗(按鍵喚醒/設定模式)期間不需要認證，代表使用者人在屏幕旁
static bool configChanged = false;
static bool rebootRequested = false;
static void (*infoFill)(JsonObject) = nullptr;

WebServer &devServerHttp() {
  return server;
}

// 寫入類與檔案類操作要認證：標頭 X-Auth 帶 MQTT 密碼。還沒設過密碼(全新的屏幕)或設定視窗開著時放行
static bool authorized() {
  if (authOpen || !gCfg || gCfg->mqttPass.length() == 0) return true;
  return server.header("X-Auth") == gCfg->mqttPass;
}

#define REQUIRE_AUTH()                                         \
  do {                                                         \
    if (!authorized()) {                                       \
      server.send(401, "text/plain", "unauthorized\n");        \
      return;                                                  \
    }                                                          \
  } while (0)

// TF卡偶爾會掉線(跟螢幕共用SPI)：讀不到根目錄就重新掛載
static bool sdReady() {
  File root = SD.open("/");
  bool ok = root && root.isDirectory();
  if (root) root.close();
  if (!ok) {
    Serial.println("[dev] sd lost, remounting");
    ok = boardMountSd();
  }
  return ok;
}

// 路徑前綴 flash: 代表內建Flash(LittleFS)，例如 flash:/fonts/x.ttf；沒有前綴是TF卡
static fs::FS &pickFs(String &path) {
  if (path.startsWith("flash:")) {
    path = path.substring(6);
    return LittleFS;
  }
  sdReady();
  return SD;
}

static void ensureParentDirs(fs::FS &fs, const String &path) {
  int idx = 1;
  while ((idx = path.indexOf('/', idx)) > 0) {
    String dir = path.substring(0, idx);
    if (!fs.exists(dir)) fs.mkdir(dir);
    idx++;
  }
}

// 不需認證的基本資訊(桌面工具用屏幕IP連線時先讀這個確認是不是屏幕)
static void handleInfo() {
  JsonDocument doc;
  JsonObject o = doc.to<JsonObject>();
  o["device"] = "nsst-screen";
  o["fw"] = "0.2";
  o["mac"] = WiFi.macAddress();
  o["ip"] = WiFi.localIP().toString();
  o["ssid"] = WiFi.SSID();
  o["rssi"] = WiFi.RSSI();
  o["heap"] = ESP.getFreeHeap();
  o["psram"] = ESP.getFreePsram();
  o["has_mqtt"] = gCfg && gCfg->hasMqtt();
  o["auth_required"] = !authOpen && gCfg && gCfg->mqttPass.length() > 0;
  if (infoFill) infoFill(o);
  String out;
  serializeJson(doc, out);
  server.send(200, "application/json", out);
}

static void handleDiskUsage() {
  REQUIRE_AUTH();
  String json = "{\"sd_used_mb\":" + String((uint32_t)(SD.usedBytes() / (1024 * 1024))) +
                ",\"flash_used_kb\":" + String((uint32_t)(LittleFS.usedBytes() / 1024)) + "}";
  server.send(200, "application/json", json);
}

static void sendConfig() {
  JsonDocument doc;
  configToJson(*gCfg, doc.to<JsonObject>(), true);
  String out;
  serializeJson(doc, out);
  server.send(200, "application/json", out);
}

// GET /config 讀設定(密碼遮罩)；POST /config 傳JSON(格式同設定檔，只改有給的欄位)，存檔並通知主程式
// 桌面工具用這個把 MQTT 位置/帳密、休眠設定寫進屏幕；{"reboot":true} 寫完重開機套用
static void handleConfig() {
  REQUIRE_AUTH();
  if (!gCfg) {
    server.send(500, "text/plain", "no config\n");
    return;
  }
  if (server.method() == HTTP_GET) {
    sendConfig();
    return;
  }
  JsonDocument doc;
  if (deserializeJson(doc, server.arg("plain")) != DeserializationError::Ok) {
    server.send(400, "text/plain", "bad json\n");
    return;
  }
  bool changed = configMerge(*gCfg, doc.as<JsonObjectConst>());
  if (changed && !configSave(*gCfg)) {
    server.send(500, "text/plain", "save failed\n");
    return;
  }
  if (changed) configChanged = true;
  if (doc["reboot"] | false) rebootRequested = true;
  sendConfig();
}

static void handleReboot() {
  REQUIRE_AUTH();
  rebootRequested = true;
  server.send(200, "text/plain", "rebooting\n");
}

static void handleList() {
  REQUIRE_AUTH();
  String dir = server.hasArg("dir") ? server.arg("dir") : "/";
  fs::FS &fs = pickFs(dir);
  File root = fs.open(dir);
  if (!root || !root.isDirectory()) {
    server.send(404, "text/plain", "not a directory\n");
    return;
  }
  String out;
  for (File f = root.openNextFile(); f; f = root.openNextFile()) {
    out += String(f.isDirectory() ? "d " : "f ") + f.name() + " " + String((uint32_t)f.size()) + "\n";
  }
  server.send(200, "text/plain", out);
}

// 叫屏幕從網址下載檔案：POST /fetch?url=http://電腦IP:埠/檔案&path=flash:/fonts/x.ttf(內建Flash) 或 path=/db/x.json(TF卡)
// 只提供「屏幕主動下載」：電腦推上來的multipart上傳，ESP32 WebServer解析大檔常截斷，已移除
// 先寫.part，大小跟Content-Length一致才改名
static void handleFetch() {
  REQUIRE_AUTH();
  String url = server.arg("url");
  String path = server.arg("path");
  fs::FS &fs = pickFs(path);
  if (!url.startsWith("http://") || !path.startsWith("/")) {
    server.send(400, "text/plain", "need url=http://... and path=/... or flash:/...\n");
    return;
  }
  HTTPClient http;
  http.setTimeout(15000);
  http.begin(url);
  int code = http.GET();
  if (code != 200) {
    http.end();
    server.send(502, "text/plain", "download http " + String(code) + "\n");
    return;
  }
  long total = http.getSize();
  ensureParentDirs(fs, path);
  String tmp = path + ".part";
  fs.remove(tmp);
  File f = fs.open(tmp, FILE_WRITE);
  WiFiClient *stream = http.getStreamPtr();
  static uint8_t buf[4096];
  long got = 0;
  uint32_t lastData = millis();
  uint32_t t0 = millis();
  while (f && http.connected() && (total < 0 || got < total) && millis() - lastData < 15000) {
    size_t avail = stream->available();
    if (!avail) {
      delay(2);
      continue;
    }
    int n = stream->readBytes(buf, min(avail, sizeof(buf)));
    if (n > 0) {
      if (f.write(buf, n) != (size_t)n) break;
      got += n;
      lastData = millis();
    }
  }
  if (f) f.close();
  http.end();
  bool ok = total < 0 ? got > 0 : got == total;
  if (ok) {
    fs.remove(path);
    fs.rename(tmp, path);
  } else {
    fs.remove(tmp);
  }
  Serial.printf("[dev] fetch %s -> %s %ld/%ld bytes %lums %s\n", url.c_str(), path.c_str(), got, total, millis() - t0,
                ok ? "ok" : "FAILED");
  server.send(ok ? 200 : 500, "text/plain", String(ok ? "ok " : "failed ") + String(got) + "/" + String(total) + "\n");
}

// 檔案校驗：GET /md5?path=/x，整個檔案讀一遍算MD5，用來確認TF卡上的檔案跟電腦上的一致(也順便測讀取是否穩定)
static void handleMd5() {
  REQUIRE_AUTH();
  String path = server.arg("path");
  fs::FS &fs = pickFs(path);
  File f = fs.open(path, FILE_READ);
  if (!f) {
    server.send(404, "text/plain", "not found\n");
    return;
  }
  MD5Builder md5;
  md5.begin();
  static uint8_t buf[4096];
  size_t total = 0;
  uint32_t t0 = millis();
  while (true) {
    int n = f.read(buf, sizeof(buf));
    if (n <= 0) break;
    md5.add(buf, n);
    total += n;
  }
  size_t size = f.size();
  f.close();
  md5.calculate();
  server.send(200, "text/plain",
              md5.toString() + " " + String((unsigned)total) + "/" + String((unsigned)size) + " " + String(millis() - t0) + "ms\n");
}

// 刪除檔案：POST /rm?path=/x
static void handleRemove() {
  REQUIRE_AUTH();
  String path = server.arg("path");
  fs::FS &fs = pickFs(path);
  bool ok = fs.remove(path);
  server.send(ok ? 200 : 404, "text/plain", ok ? "removed\n" : "not found\n");
}

static void handleRender() {
  REQUIRE_AUTH();
  bool dry = server.arg("dry") == "1";
  renderPage = server.hasArg("page") ? max(0, (int)server.arg("page").toInt() - 1) : -1;
  renderRequested = dry ? 2 : 1;
  server.send(200, "text/plain", dry ? "dry render queued (no panel refresh)\n" : "render queued (about 35s)\n");
}

// 調色盤編號 -> 螢幕實際顯示的近似RGB(Spectra 6的色調偏暗偏柔，這裡用接近實際的色值)
static const uint8_t *previewColor(uint8_t index) {
  static const uint8_t kBlack[] = {20, 20, 20}, kWhite[] = {235, 235, 225}, kRed[] = {190, 40, 30},
                       kBlue[] = {30, 70, 150}, kGreen[] = {50, 120, 70}, kYellow[] = {225, 200, 40};
  switch (index) {
    case 0x0F: return kBlack;
    case 0x00: return kWhite;
    case 0x06: return kRed;
    case 0x0D: return kBlue;
    case 0x02: return kGreen;
    case 0x0B: return kYellow;
    default: return kWhite;
  }
}

// 下載目前記憶體畫布(800x480)成24位元BMP：不刷新電子紙也能看版面
static void handlePreview() {
  REQUIRE_AUTH();
  const int w = SCREEN_W, h = SCREEN_H;
  const uint32_t rowSize = w * 3;
  const uint32_t dataSize = rowSize * h;
  uint8_t hdr[54] = {'B', 'M'};
  auto put32 = [&](int off, uint32_t v) {
    for (int i = 0; i < 4; i++) hdr[off + i] = (v >> (8 * i)) & 0xFF;
  };
  put32(2, 54 + dataSize);
  put32(10, 54);
  put32(14, 40);
  put32(18, w);
  put32(22, (uint32_t)(-h)); // 負高度=由上往下存
  hdr[26] = 1;
  hdr[28] = 24;
  put32(34, dataSize);
  server.setContentLength(54 + dataSize);
  server.send(200, "image/bmp", "");
  server.sendContent((const char *)hdr, 54);
  static uint8_t row[SCREEN_W * 3];
  for (int y = 0; y < h; y++) {
    for (int x = 0; x < w; x++) {
      // 畫布是4bit調色盤編號(Seeed_GFX的6色定義)，直接轉成螢幕實際顯示的近似RGB(BMP是BGR順序)
      const uint8_t *rgb = previewColor(epaper.readPixelValue(x, y) & 0x0F);
      row[x * 3 + 0] = rgb[2];
      row[x * 3 + 1] = rgb[1];
      row[x * 3 + 2] = rgb[0];
    }
    server.sendContent((const char *)row, rowSize);
  }
}

void devServerBegin(AppConfig *cfg, void (*fillInfo)(JsonObject)) {
  gCfg = cfg;
  infoFill = fillInfo;
  if (started) return;
  if (WiFi.status() == WL_CONNECTED) MDNS.begin("nsst-screen");
  static const char *headers[] = {"X-Auth"};
  server.collectHeaders(headers, 1);
  server.on("/", HTTP_GET, handleInfo);
  server.on("/info", HTTP_GET, handleInfo);
  server.on("/usage", HTTP_GET, handleDiskUsage);
  server.on("/config", HTTP_ANY, handleConfig);
  server.on("/reboot", HTTP_POST, handleReboot);
  server.on("/ls", HTTP_GET, handleList);
  server.on("/render", HTTP_POST, handleRender);
  server.on("/fetch", HTTP_POST, handleFetch);
  server.on("/md5", HTTP_GET, handleMd5);
  server.on("/rm", HTTP_POST, handleRemove);
  server.on("/preview.bmp", HTTP_GET, handlePreview);
  server.begin();
  started = true;
  Serial.printf("[http] server started on %s\n", WiFi.localIP().toString().c_str());
}

void devServerEnd() {
  if (!started) return;
  server.stop();
  MDNS.end();
  started = false;
}

bool devServerRunning() {
  return started;
}

void devServerAuthOpen(bool open) {
  authOpen = open;
}

bool devServerTakeConfigChanged() {
  bool r = configChanged;
  configChanged = false;
  return r;
}

bool devServerRebootRequested() {
  return rebootRequested;
}

void devServerLoop() {
  if (started) server.handleClient();
}

String devServerAddress() {
  return WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : String();
}

int devServerTakeRenderRequest(int *page) {
  int r = renderRequested;
  renderRequested = 0;
  if (page) *page = renderPage;
  renderPage = -1;
  return r;
}
