// nsst 電子紙看板固件(reTerminal E1002)
//
// 運作方式：每次開機/醒來跑一輪「連 WiFi → 連桌面工具的 MQTT → 收保留訊息(儀表板數據+配置) → 內容有變才刷新電子紙 → 回報狀態」，
// 然後依電源規則(power.h)決定：保持連線(即時收推送)，或深度睡眠(任一按鍵/定時喚醒)。插 USB 時永遠不休眠。
//
// 按鍵：綠(右)=喚醒/強制重畫，按住5秒=清除畫面；白鍵(左/中)=切換分頁(之後做)；兩顆白鍵同時按住2秒=設定模式(手機設定WiFi，睡眠中也可以直接按)
// 電子紙不宜頻繁刷新：只有內容(rev)真的變了、按綠鍵、或桌面工具下指令才會刷
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <WiFi.h>
#include <Wire.h>
#include "esp_sleep.h"
#include "appconfig.h"
#include "board.h"
#include "clock.h"
#include "dashboard.h"
#include "devserver.h"
#include "display.h"
#include "fonts.h"
#include "netmqtt.h"
#include "pages.h"
#include "power.h"
#include "setup.h"

static const char *kDashboardPath = "/db/dashboard.json";
static const uint32_t kSetupHoldMs = 2000;
static const uint32_t kClearHoldMs = 5000; // 按住綠鍵這麼久=清除畫面
static const uint32_t kOfflineGraceMs = 180UL * 1000; // MQTT斷線後多久內仍視為「連得上」(重試緩衝)
static const uint32_t kNeedSetupWindowMs = 10UL * 60 * 1000; // 沒設桌面工具時保持HTTP設定介面的時間
static const uint32_t kKeyWakeWindowMs = 90UL * 1000;        // 按鍵喚醒後保持設定介面的時間

RTC_DATA_ATTR uint32_t cycleCount = 0;

static AppConfig cfg;
static Preferences prefs;
static PowerPlan plan;
static PowerContext pctx;
static bool onlineMode = false;
static String wakeCause = "boot";
static bool wakeByGreen = false;
static uint32_t authOpenUntil = 0; // 冷開機(接USB燒錄/撥電源開關)後的一段時間內，設定介面不需認證，桌面工具才能接手重設連線
static const uint32_t kColdBootAuthOpenMs = 5UL * 60 * 1000;
static uint32_t lastPlanAt = 0, lastStatusAt = 0, lastReconnectAt = 0, offlineSince = 0, needSetupDeadline = 0;
static bool forceDraw = false;
static String gWanted;
static bool gWantedValid = false;
static int lastPageCount = 1;     // 最近一次畫面的總頁數

// 「停放」狀態(存在NVS)：螢幕目前是清成白色的，不要被舊資料蓋回去
//   0 沒有；1 自動(斷線太久)：連上MQTT拿到新資料就自動恢復；2 手動(按住綠鍵/桌面工具指令)：等按綠鍵或「恢復顯示」才恢復
static const char *kClearRev = "-clear";

// ---------------- 小工具 ----------------

static bool whiteKeysDown() {
  return digitalRead(PIN_KEY_MIDDLE) == LOW && digitalRead(PIN_KEY_LEFT) == LOW;
}

// 兩顆白鍵是不是連續按住了 ms 毫秒
static bool whiteKeysHeld(uint32_t ms) {
  uint32_t t0 = millis();
  while (millis() - t0 < ms) {
    if (!whiteKeysDown()) return false;
    delay(20);
  }
  return true;
}

// 兩顆白鍵一起按住 ms 毫秒才算(設定模式)。一偵測到兩顆都按下就短嗶一聲、亮燈：使用者分辨不出屏幕是醒著還是睡著，
// 這個聲音代表「屏幕醒著，收到了，繼續按住」；沒按滿就放開會直接取消
static bool whiteComboHeld(uint32_t ms) {
  if (!whiteKeysDown()) return false;
  boardBeep(50);
  boardLed(true);
  bool ok = whiteKeysHeld(ms);
  boardLed(false);
  return ok;
}

static String drawnRev() {
  return prefs.getString("rev", "");
}

static uint8_t parkedState() {
  return prefs.getUChar("parked", 0);
}

static void markSyncOk() {
  if (clockValid()) prefs.putUInt("ok_at", (uint32_t)time(nullptr));
}

static bool readDashboard(JsonDocument &doc) {
  File f = LittleFS.open(kDashboardPath, FILE_READ);
  if (!f) return false;
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  return !err;
}

static void saveDashboard(const String &json) {
  LittleFS.mkdir("/db");
  String tmp = String(kDashboardPath) + ".tmp";
  File f = LittleFS.open(tmp, FILE_WRITE);
  if (!f) return;
  f.print(json);
  f.close();
  LittleFS.remove(kDashboardPath);
  LittleFS.rename(tmp, kDashboardPath);
  gWantedValid = false;
}

// 目前「應該顯示」的內容版本：有儀表板數據就是它的rev，否則是狀態代碼(尚未設定桌面工具/等待資料)
// 每輪loop都會問，所以快取起來，儀表板檔案有變才重算(不然每30毫秒就讀一次Flash解析JSON)
static String wantedRev() {
  if (!gWantedValid) {
    JsonDocument doc;
    if (readDashboard(doc)) gWanted = String(doc["rev"] | "?");
    else gWanted = cfg.hasMqtt() ? "-wait" : "-setup";
    gWantedValid = true;
  }
  return gWanted;
}

// ---- 分頁：專案/工程師太多一頁放不下時，短按綠鍵翻頁，最後一頁再按回第一頁 ----
static int currentPage() {
  return prefs.getUChar("page", 0);
}

static void setPage(int p) {
  prefs.putUChar("page", (uint8_t)constrain(p, 0, 250));
}

// 目前資料的總頁數(要量文字寬度，所以要先載入字型)
static int pageCountNow() {
  if (!fontsReady()) fontsLoad();
  JsonDocument doc;
  if (!readDashboard(doc)) return 1;
  return dashboardPageCount(doc);
}

static void fillInfo(JsonObject o) {
  o["battery_pct"] = boardBatteryPercentNow();
  o["volts"] = serialized(String(boardBatteryVolts(), 2));
  o["usb"] = pctx.usb;
  o["mode"] = plan.reason;
  o["online"] = onlineMode;
  o["rev"] = drawnRev();
  o["wake"] = wakeCause;
  o["device_id"] = cfg.deviceId;
  o["power_mode"] = cfg.powerMode;
  o["parked"] = parkedState();
  o["page"] = currentPage() + 1;
  o["pages"] = lastPageCount;
  struct tm lt;
  if (clockNow(lt)) {
    char tb[24];
    strftime(tb, sizeof(tb), "%Y-%m-%d %H:%M:%S", &lt);
    o["time"] = tb;
  }
  o["uptime_s"] = millis() / 1000;
}

static void publishStatus() {
  if (!netMqttConnected()) return;
  JsonDocument doc;
  JsonObject o = doc.to<JsonObject>();
  o["fw"] = "0.2";
  o["battery"] = boardBatteryPercentNow();
  o["volts"] = serialized(String(boardBatteryVolts(), 2));
  o["usb"] = pctx.usb;
  o["ip"] = devServerAddress();
  o["ssid"] = netSsid();
  o["rssi"] = WiFi.RSSI();
  o["rev"] = drawnRev();
  o["mode"] = plan.reason;
  o["online"] = onlineMode;
  o["wake"] = wakeCause;
  o["parked"] = parkedState(); // 0=正常 1=斷線太久自動清除 2=手動清除
  o["page"] = currentPage() + 1;
  o["pages"] = lastPageCount;
  if (!plan.stayOnline) o["next_wake_s"] = plan.sleepSeconds;
  float t, h;
  if (boardReadClimate(t, h)) o["temp"] = serialized(String(t, 1));
  String out;
  serializeJson(doc, out);
  netMqttPublish(cfg, "status", out);
  lastStatusAt = millis();
}

// ---------------- 畫面 ----------------

// pageOverride：>=0 時畫指定頁(試畫/指令用)，否則畫目前記錄的頁
// 狀態列中間的狀態文字(USB/連線/睡眠模式)；畫面上顯示的是「上次畫圖當下」的狀態，狀態變了要重畫才不會誤導
static String statusNote() {
  if (plan.stayOnline) return pctx.usb ? "USB 供電．即時連線" : "即時連線";
  return plan.reason[0] == 'p' ? "定時同步" : "省電模式";
}

// 畫面上的狀態文字跟現在的實際狀態不一樣(例如拔了USB畫面還寫USB供電)。沒資料/被清除停放/設定畫面時不算
static bool statusStale() {
  String rev = drawnRev();
  if (parkedState() != 0 || rev.isEmpty() || rev == kClearRev || rev == "-setup") return false;
  return prefs.getString("note", "") != statusNote();
}

static void drawNow(bool dry = false, int pageOverride = -1) {
  boardLed(true);
  netPowerSave(false); // 畫圖要全速
  displayBegin();
  if (!fontsReady()) fontsLoad();

  String rev = wantedRev();
  if (rev == "-setup") {
    pageNeedDesktop(devServerAddress());
  } else {
    JsonDocument doc;
    bool has = readDashboard(doc);
    DeviceStatus st;
    st.batteryPct = boardBatteryPercentNow();
    float t, h;
    if (boardReadClimate(t, h)) {
      st.temperature = t;
      st.humidity = h;
    }
    st.note = statusNote();
    if (plan.stayOnline) {
      if (netWifiConnected()) st.ip = WiFi.localIP().toString();
    } else {
      st.nextSync = powerWakeText(plan.sleepSeconds);
    }
    int page = pageOverride >= 0 ? pageOverride : currentPage();
    int pages = dashboardRender(has ? &doc : nullptr, st, page);
    lastPageCount = pages;
    if (!dry) setPage(constrain(page, 0, pages - 1)); // 資料變少頁數變少時，頁碼跟著限制
  }
  if (!dry) {
    displayFlush();
    prefs.putString("rev", rev);
    prefs.putString("note", statusNote());
    prefs.putUChar("parked", 0);
  }
  if (plan.stayOnline && !plan.fullSpeed) netPowerSave(true);
  boardLed(false);
}

// 把螢幕清成全白(約33秒)並「停放」。電子紙長時間顯示同一張圖會殘影、縮短壽命，長期不用/斷線太久時清掉最好
static void drawClear(uint8_t parkMode) {
  Serial.printf("[main] clear screen (park=%u)\n", parkMode);
  boardLed(true);
  netPowerSave(false);
  displayBegin();
  epaper.fillScreen(TFT_WHITE);
  displayFlush();
  prefs.putString("rev", kClearRev);
  prefs.putUChar("parked", parkMode);
  if (plan.stayOnline && !plan.fullSpeed) netPowerSave(true);
  boardLed(false);
}

// 斷線太久：自動清除。回傳是否清了
static bool maybeAutoClear() {
  if (cfg.clearOfflineMin <= 0 || !clockValid() || parkedState() != 0) return false;
  uint32_t okAt = prefs.getUInt("ok_at", 0);
  if (okAt == 0) return false; // 從沒成功同步過(全新/剛設定)，不算斷線
  time_t now = time(nullptr);
  if (now < (time_t)okAt || (uint32_t)(now - okAt) < (uint32_t)cfg.clearOfflineMin * 60) return false;
  drawClear(1);
  return true;
}

// ---------------- 收到的訊息 ----------------

// 回傳這一輪是否需要重畫
static bool handleInbox(bool &powerChanged) {
  MqttInbox &in = netInbox();
  bool need = false;
  if (in.hasConfig) {
    in.hasConfig = false;
    JsonDocument doc;
    if (deserializeJson(doc, in.config) == DeserializationError::Ok) {
      if (configApplyRemote(cfg, doc.as<JsonObjectConst>())) {
        configSave(cfg);
        powerChanged = true;
        Serial.println("[main] config updated from desktop");
      }
    }
  }
  if (in.hasDashboard) {
    in.hasDashboard = false;
    JsonDocument doc;
    if (deserializeJson(doc, in.dashboard) == DeserializationError::Ok) {
      String rev = doc["rev"] | "?";
      JsonDocument cur;
      String curRev = readDashboard(cur) ? String(cur["rev"] | "?") : "";
      if (rev != curRev) saveDashboard(in.dashboard); // 內容有變才寫Flash
    }
  }
  if (in.hasCmd) {
    in.hasCmd = false;
    JsonDocument doc;
    if (deserializeJson(doc, in.cmd) == DeserializationError::Ok) {
      String c = doc["cmd"] | "";
      Serial.printf("[main] cmd %s\n", c.c_str());
      if (c == "refresh" || c == "resume") forceDraw = true;
      else if (c == "clear") drawClear(2);
      else if (c == "reboot") ESP.restart();
      else if (c == "status") publishStatus();
    }
  }
  uint8_t parked = parkedState();
  if (wantedRev() != drawnRev()) {
    // 手動停放：不管有沒有連線都不自動恢復；自動停放(斷線太久)：連上MQTT(有新資料)才恢復
    if (parked == 0 || (parked == 1 && netMqttConnected())) need = true;
  }
  if (forceDraw) {
    need = true; // refresh/resume 指令一律恢復顯示
    forceDraw = false;
  }
  return need;
}

// ---------------- 保持連線 ----------------

static void goOnline() {
  onlineMode = true;
  devServerBegin(&cfg, fillInfo);
  netPowerSave(plan.stayOnline && !plan.fullSpeed);
  lastPlanAt = millis();
  // 因為插USB等原因在沒連上MQTT時進入保持連線：重試緩衝從現在算起
  offlineSince = (cfg.hasMqtt() && !netMqttConnected()) ? millis() : 0;
  Serial.printf("[main] online (%s)\n", plan.reason);
}

static void goSleep() {
  if (netMqttConnected()) markSyncOk();
  netMqttDisconnect();
  devServerEnd();
  powerDeepSleep(plan.sleepSeconds);
}

// 綠鍵：短按=翻到下一頁(最後一頁再按回第一頁；只有一頁就是重畫；畫面被清除停放時是恢復顯示)；按住5秒=清除畫面(收納前用)
// 回傳這次有沒有處理到按鍵。畫面刷新要約35秒，所以一按下去先嗶一聲
static bool handleGreenKey() {
  if (digitalRead(PIN_KEY_RIGHT) != LOW) return false;
  delay(40);
  if (digitalRead(PIN_KEY_RIGHT) != LOW) return false;
  boardBeep(50);
  uint32_t t0 = millis();
  bool longPress = false;
  while (digitalRead(PIN_KEY_RIGHT) == LOW) {
    if (!longPress && millis() - t0 >= kClearHoldMs) {
      longPress = true;
      boardBeep(150);
      delay(200);
      boardBeep(150);
    }
    delay(10);
  }
  if (longPress) {
    drawClear(2);
    return true;
  }
  if (parkedState() == 0) {
    int pages = pageCountNow();
    setPage(pages > 1 ? (currentPage() + 1) % pages : 0);
    Serial.printf("[main] page -> %d/%d\n", currentPage() + 1, pages);
  }
  drawNow();
  return true;
}

// 重新評估電源規則
static void replan() {
  pctx.usb = boardUsbPresent();
  pctx.batteryPct = boardBatteryPercentNow();
  // MQTT斷線給3分鐘的重試緩衝(loop每10秒會重連)：短暫斷線、電腦剛開機、拔掉USB的瞬間都不該馬上去睡；連續連不上超過3分鐘才算連不上
  pctx.mqttOk = netMqttConnected() || (offlineSince != 0 && millis() - offlineSince < kOfflineGraceMs);
  PowerPlan next = powerPlan(cfg, pctx);
  if (!cfg.hasMqtt() && netWifiConnected() && (int32_t)(needSetupDeadline - millis()) > 0) { // 還沒設桌面工具：留著HTTP設定介面等桌面工具來寫設定
    next.stayOnline = true;
    next.reason = "need_setup";
  }
  bool speedChanged = next.fullSpeed != plan.fullSpeed;
  plan = next;
  if (speedChanged && onlineMode) netPowerSave(!plan.fullSpeed);
  lastPlanAt = millis();
}

// ---------------- 開機一輪 ----------------

// 按鍵喚醒後的一段時間內保持HTTP設定介面(不需認證)，方便桌面工具用IP寫設定；時間到就繼續睡
static void configWindow(uint32_t ms) {
  devServerBegin(&cfg, fillInfo);
  devServerAuthOpen(true);
  Serial.printf("[main] config window %us at %s\n", (unsigned)(ms / 1000), devServerAddress().c_str());
  uint32_t t0 = millis();
  while (millis() - t0 < ms) {
    devServerLoop();
    netMqttLoop();
    if (devServerTakeConfigChanged() || devServerRebootRequested()) {
      delay(600);
      ESP.restart();
    }
    if (whiteComboHeld(kSetupHoldMs)) {
      setupModeRun(cfg);
      ESP.restart();
    }
    if (handleGreenKey()) t0 = millis(); // 翻頁/清除要幾十秒，做完重新計時，不然視窗被吃光
    delay(5);
  }
  devServerAuthOpen(false);
}

// 沒校過、或超過6小時沒校就用NTP校時(時鐘晶片會慢慢漂，也避免晶片裡的時間是舊的/錯的)
static void syncClockIfNeeded(bool wifi) {
  if (!wifi) return;
  uint32_t lastOk = prefs.getUInt("ntp_at2", 0);
  time_t now = time(nullptr);
  bool stale = !clockValid() || lastOk == 0 || (now > lastOk && now - lastOk > 6 * 3600) || now < lastOk;
  if (!stale) return;
  if (clockSyncNtp(cfg.ntp)) prefs.putUInt("ntp_at2", (uint32_t)time(nullptr));
}

static void runCycle() {
  bool wifi = netWifiConnected() || netWifiConnect(cfg, 20000);
  syncClockIfNeeded(wifi);
  bool mq = wifi && cfg.hasMqtt() && netMqttConnect(cfg, 6000);
  if (mq) netMqttWaitRetained(5000);

  pctx.usb = boardUsbPresent();
  pctx.batteryPct = boardBatteryPercentNow();
  pctx.mqttOk = mq;
  plan = powerPlan(cfg, pctx);
  if (wifi && !cfg.hasMqtt()) {
    plan.stayOnline = true;
    plan.reason = "need_setup";
    needSetupDeadline = millis() + kNeedSetupWindowMs;
  }

  bool powerChanged = false;
  bool need = handleInbox(powerChanged);
  if (powerChanged && strcmp(plan.reason, "need_setup") != 0) plan = powerPlan(cfg, pctx);
  if (wakeByGreen && parkedState() != 0) need = true; // 畫面被清除停放時，按綠鍵喚醒=恢復顯示(沒停放時只是重新連線，資料有變才畫)
  if (mq) markSyncOk();
  bool drew = false;
  if (need) {
    drawNow();
    drew = true;
  } else if (!mq) {
    drew = maybeAutoClear();
  }
  if (!drew && statusStale()) drawNow(); // 上次畫完後USB拔插/模式變了，狀態列要更新
  if (mq) publishStatus();

  if (wakeCause == "key" && wifi && !plan.stayOnline) configWindow(kKeyWakeWindowMs);

  if (plan.stayOnline) {
    goOnline();
  } else {
    Serial.printf("[main] sleep %us (%s)\n", (unsigned)plan.sleepSeconds, plan.reason);
    goSleep();
  }
}

void setup() {
  pctx.usb = boardUsbPresent(false); // Serial.begin之前先量(要借用GPIO44)
  Serial.begin(115200);
  delay(100);
  Serial.println();
  boardEarlyInit();
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  boardMountFlashFs();
  configLoad(cfg);
  clockInit(cfg.tzHours);
  clockLoadFromRtc();
  prefs.begin("nsst", false);
  cycleCount++;

  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  if (cause == ESP_SLEEP_WAKEUP_TIMER) {
    wakeCause = "timer";
  } else if (cause == ESP_SLEEP_WAKEUP_EXT1) {
    wakeCause = "key";
    wakeByGreen = (esp_sleep_get_ext1_wakeup_status() & (1ULL << PIN_KEY_RIGHT)) != 0;
  }
  Serial.printf("[main] boot #%u wake=%s usb=%d batt=%d%% cfg: wifi=%u mqtt=%s mode=%s\n", (unsigned)cycleCount, wakeCause.c_str(),
                pctx.usb, boardBatteryPercentNow(), (unsigned)cfg.wifi.size(), cfg.mqttHost.c_str(), cfg.powerMode.c_str());

  // 冷開機(不是睡眠喚醒)：開5分鐘免認證視窗。這是人在屏幕旁的情況(剛通電/剛重置)，也是忘記密碼或換了電腦時的恢復途徑
  if (wakeCause == "boot") {
    authOpenUntil = millis() + kColdBootAuthOpenMs;
    devServerAuthOpen(true);
  }

  // 白鍵喚醒(沒有按綠鍵)：先快速確認是不是「兩顆白鍵一起長按」要進設定模式。
  // 兩顆鍵很難剛好同時按下，所以先等最多0.8秒讓第二顆也按下；不是的話(單按白鍵=以後用來切分頁)就不連線，接著睡完原本預定的時間
  if (wakeCause == "key" && !wakeByGreen) {
    uint32_t t0 = millis();
    while (!whiteKeysDown() && millis() - t0 < 800) delay(10);
    if (whiteComboHeld(kSetupHoldMs)) {
      setupModeRun(cfg);
      ESP.restart();
    }
    Serial.println("[main] white key wake: nothing to do (page switching not implemented), back to sleep");
    powerDeepSleep(powerRemainingSleep());
  }

  // 按鍵喚醒：馬上嗶一聲、亮燈，讓使用者知道它醒了正在重新連線(連線和畫面刷新要一段時間)
  if (wakeCause == "key") {
    boardBeep(80);
    boardLed(true);
  }

  // 喚醒時一直按著綠鍵到5秒 = 清除畫面(收納前用)，清完就睡
  if (wakeByGreen && digitalRead(PIN_KEY_RIGHT) == LOW) {
    uint32_t t0 = millis();
    while (digitalRead(PIN_KEY_RIGHT) == LOW && millis() - t0 < kClearHoldMs) delay(20);
    if (millis() - t0 >= kClearHoldMs) {
      boardBeep(150);
      delay(200);
      boardBeep(150);
      drawClear(2);
      powerDeepSleep(0); // 只等按鍵喚醒
    }
  }

  // 設定模式：兩顆白鍵同時按住2秒(冷開機或按鍵喚醒時還按著)
  if (whiteComboHeld(kSetupHoldMs)) {
    setupModeRun(cfg);
    ESP.restart();
  }

  runCycle();
  boardLed(false);
}

void loop() {
  if (!onlineMode) { // 不該到這裡：保險起見直接睡
    goSleep();
    return;
  }
  devServerLoop();
  netMqttLoop();
  if (authOpenUntil != 0 && (int32_t)(millis() - authOpenUntil) > 0) {
    authOpenUntil = 0;
    devServerAuthOpen(false);
  }

  if (devServerRebootRequested()) {
    delay(600);
    ESP.restart();
  }
  if (devServerTakeConfigChanged()) {
    Serial.println("[main] config changed via http, restarting");
    delay(600);
    ESP.restart(); // WiFi/MQTT設定改了，重開機最單純
  }

  // MQTT斷線：每10秒重連；連不上超過3分鐘就交給電源規則(smart模式會去睡)
  if (cfg.hasMqtt() && !netMqttConnected() && millis() - lastReconnectAt > 10000) {
    lastReconnectAt = millis();
    if (!netWifiConnected()) netWifiConnect(cfg, 10000);
    if (netMqttConnect(cfg, 4000)) {
      offlineSince = 0;
      netMqttWaitRetained(3000);
    } else if (offlineSince == 0) {
      offlineSince = millis();
    }
  }

  bool powerChanged = false;
  bool need = handleInbox(powerChanged);
  int reqPage = -1;
  int req = devServerTakeRenderRequest(&reqPage);
  if (req == 2) {
    drawNow(true, reqPage);
  } else if (req == 1) {
    if (reqPage >= 0) setPage(reqPage);
    need = true;
  }
  if (need) {
    drawNow();
    publishStatus();
  }

  if (handleGreenKey()) publishStatus();
  if (whiteComboHeld(kSetupHoldMs)) {
    setupModeRun(cfg);
    ESP.restart();
  }

  // 每分鐘重新評估一次(是否還在上班時段、有沒有拔USB、電量…)
  if (millis() - lastPlanAt > 60000 || powerChanged) {
    replan();
    // 狀態列的USB/模式文字過期就重畫；連續兩次(約1分鐘)都不一樣才算，避免偵測閃一下就刷33秒的螢幕
    static uint8_t staleCount = 0;
    staleCount = statusStale() ? staleCount + 1 : 0;
    if (staleCount >= 2) {
      staleCount = 0;
      Serial.println("[main] status note changed, redraw");
      drawNow();
      publishStatus();
    }
    if (!plan.stayOnline) {
      if (statusStale()) drawNow(); // 睡著前把狀態列更新成「省電模式」，不要留著過期的「USB 供電」
      Serial.printf("[main] leaving online: %s\n", plan.reason);
      publishStatus();
      goSleep();
    }
  }
  if (millis() - lastStatusAt > 5UL * 60 * 1000) publishStatus();

  delay(plan.fullSpeed ? 5 : 30);
}
