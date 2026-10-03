// 屏幕設定：存在內建 Flash 的 /config.json，不寫死在程式裡
//   wifi    可存多組(家裡、公司…)，開機依序找附近有的那組連；用「同時按住兩顆白鍵」進設定模式用手機新增
//   mqtt    桌面工具的 MQTT 伺服器位置與帳密，由桌面工具透過 IP 寫入(POST /config)
//   power   休眠相關，由桌面工具透過 MQTT 的 config 主題推送
//   clock   NTP 伺服器與時區
// 沒有 /config.json 時用 secrets.h 的預設值(開發用)
#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include <vector>

struct WifiEntry {
  String ssid;
  String pass;
};

struct AppConfig {
  std::vector<WifiEntry> wifi;

  String mqttHost;
  uint16_t mqttPort = 1883;
  String mqttUser;
  String mqttPass;
  String deviceId = "e1002";

  // 電源模式(插USB充電時一律不休眠，不管哪種模式)：
  //   smart      上班時段內連得上MQTT就保持連線(WiFi省電)；晚上或連不上就深度睡眠，每 offWakeMin 分鐘醒來抓一次，沒資料就繼續睡
  //   periodic   每 wakeMin 分鐘醒來抓一次資料，平時深度睡眠
  //   always_on  一律保持連線
  String powerMode = "smart";
  int wakeMin = 30;        // periodic：醒來間隔
  int offWakeMin = 30;     // smart：下班時段/連不上時的醒來間隔，0=不定時醒來(睡到下個上班時段開始)
  String activeStart = "08:00"; // 上班時段，空字串=全天都算上班
  String activeEnd = "19:00";
  bool weekendsOff = true;  // 週末算下班時段
  bool periodicInWindowOnly = false; // periodic：只在上班時段內醒來
  bool usbAlwaysOn = true;  // 插USB時不休眠
  int lowBatteryPct = 15;   // 電量低於這個值不再保持連線，改深度睡眠保命
  int clearOfflineMin = 1440; // 斷線(沒成功連上MQTT)超過幾分鐘就把螢幕清成白色，保護電子紙(長時間顯示同一張圖會殘影)；0=不清除
  bool lightSleep = false;  // 實驗：保持連線時嘗試輕度睡眠(目前工具鏈未開啟自動輕度睡眠，預設關)

  String ntp = "pool.ntp.org";
  int tzHours = 8;

  bool hasMqtt() const { return mqttHost.length() > 0; }
};

void configLoad(AppConfig &cfg);
bool configSave(const AppConfig &cfg);

// 設定檔內容轉JSON；maskSecrets=true時密碼不輸出(給 GET /config 用)
void configToJson(const AppConfig &cfg, JsonObject out, bool maskSecrets);

// 套用外部給的JSON(POST /config)：只改有出現的欄位，回傳是否有任何改動
bool configMerge(AppConfig &cfg, JsonObjectConst in);

// 套用桌面工具從 MQTT config 主題推送的電源/時鐘配置(扁平欄位)
bool configApplyRemote(AppConfig &cfg, JsonObjectConst in);

// 新增或更新一組WiFi(同名覆蓋密碼，放到最前面優先嘗試)
void configAddWifi(AppConfig &cfg, const String &ssid, const String &pass);
