#include "appconfig.h"
#include <LittleFS.h>
#include "secrets.h"

static const char *kConfigPath = "/config.json";

void configLoad(AppConfig &cfg) {
  cfg = AppConfig();
  // 開發用預設值(secrets.h)；正式使用靠 /config.json
  if (strlen(WIFI_SSID) > 0) cfg.wifi.push_back({WIFI_SSID, WIFI_PASSWORD});
  cfg.mqttHost = MQTT_HOST;
  cfg.mqttPort = MQTT_PORT;
  cfg.mqttUser = MQTT_USER;
  cfg.mqttPass = MQTT_PASSWORD;

  File f = LittleFS.open(kConfigPath, FILE_READ);
  if (!f) return;
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  if (err) {
    Serial.printf("[config] parse error: %s\n", err.c_str());
    return;
  }
  if (!doc["wifi"].isNull()) cfg.wifi.clear(); // 檔案裡有wifi欄位就以檔案為準，不再混入開發預設值
  configMerge(cfg, doc.as<JsonObjectConst>());
}

void configToJson(const AppConfig &cfg, JsonObject out, bool maskSecrets) {
  JsonArray wifi = out["wifi"].to<JsonArray>();
  for (const WifiEntry &w : cfg.wifi) {
    JsonObject o = wifi.add<JsonObject>();
    o["ssid"] = w.ssid;
    o["pass"] = maskSecrets ? (w.pass.length() ? "***" : "") : w.pass;
  }
  JsonObject mqtt = out["mqtt"].to<JsonObject>();
  mqtt["host"] = cfg.mqttHost;
  mqtt["port"] = cfg.mqttPort;
  mqtt["user"] = cfg.mqttUser;
  mqtt["pass"] = maskSecrets ? (cfg.mqttPass.length() ? "***" : "") : cfg.mqttPass;
  mqtt["device_id"] = cfg.deviceId;
  JsonObject power = out["power"].to<JsonObject>();
  power["mode"] = cfg.powerMode;
  power["wake_min"] = cfg.wakeMin;
  power["off_wake_min"] = cfg.offWakeMin;
  power["active_start"] = cfg.activeStart;
  power["active_end"] = cfg.activeEnd;
  power["weekends_off"] = cfg.weekendsOff;
  power["periodic_in_window_only"] = cfg.periodicInWindowOnly;
  power["usb_always_on"] = cfg.usbAlwaysOn;
  power["low_battery_pct"] = cfg.lowBatteryPct;
  power["clear_offline_min"] = cfg.clearOfflineMin;
  power["light_sleep"] = cfg.lightSleep;
  JsonObject clock = out["clock"].to<JsonObject>();
  clock["ntp"] = cfg.ntp;
  clock["tz"] = cfg.tzHours;
}

bool configSave(const AppConfig &cfg) {
  JsonDocument doc;
  configToJson(cfg, doc.to<JsonObject>(), false);
  String tmp = String(kConfigPath) + ".tmp";
  File f = LittleFS.open(tmp, FILE_WRITE);
  if (!f) return false;
  size_t n = serializeJson(doc, f);
  f.close();
  if (n == 0) return false;
  LittleFS.remove(kConfigPath);
  return LittleFS.rename(tmp, kConfigPath);
}

template <typename T>
static bool assign(T &dst, const T &value) {
  if (dst == value) return false;
  dst = value;
  return true;
}

bool configMerge(AppConfig &cfg, JsonObjectConst in) {
  bool changed = false;
  if (!in["wifi"].isNull()) {
    std::vector<WifiEntry> list;
    for (JsonObjectConst w : in["wifi"].as<JsonArrayConst>()) {
      String ssid = w["ssid"] | "";
      if (ssid.length() == 0) continue;
      String pass = w["pass"] | "";
      if (pass == "***") { // 遮罩過的值代表沒改，沿用原本的密碼
        for (const WifiEntry &old : cfg.wifi) if (old.ssid == ssid) pass = old.pass;
      }
      list.push_back({ssid, pass});
    }
    changed = true;
    cfg.wifi = list;
  }
  JsonObjectConst mqtt = in["mqtt"];
  if (!mqtt.isNull()) {
    if (!mqtt["host"].isNull()) changed |= assign(cfg.mqttHost, String(mqtt["host"].as<const char *>()));
    if (!mqtt["port"].isNull()) changed |= assign(cfg.mqttPort, (uint16_t)mqtt["port"].as<int>());
    if (!mqtt["user"].isNull()) changed |= assign(cfg.mqttUser, String(mqtt["user"].as<const char *>()));
    if (!mqtt["pass"].isNull() && String(mqtt["pass"].as<const char *>()) != "***") changed |= assign(cfg.mqttPass, String(mqtt["pass"].as<const char *>()));
    if (!mqtt["device_id"].isNull()) changed |= assign(cfg.deviceId, String(mqtt["device_id"].as<const char *>()));
  }
  JsonObjectConst power = in["power"];
  if (!power.isNull()) {
    JsonDocument flat;
    JsonObject o = flat.to<JsonObject>();
    o["power_mode"] = power["mode"];
    o["wake_min"] = power["wake_min"];
    o["off_wake_min"] = power["off_wake_min"];
    o["active_start"] = power["active_start"];
    o["active_end"] = power["active_end"];
    o["weekends_off"] = power["weekends_off"];
    o["periodic_in_window_only"] = power["periodic_in_window_only"];
    o["usb_always_on"] = power["usb_always_on"];
    o["low_battery_pct"] = power["low_battery_pct"];
    o["clear_offline_min"] = power["clear_offline_min"];
    o["light_sleep"] = power["light_sleep"];
    changed |= configApplyRemote(cfg, o);
  }
  JsonObjectConst clock = in["clock"];
  if (!clock.isNull()) {
    if (!clock["ntp"].isNull()) changed |= assign(cfg.ntp, String(clock["ntp"].as<const char *>()));
    if (!clock["tz"].isNull()) changed |= assign(cfg.tzHours, clock["tz"].as<int>());
  }
  return changed;
}

bool configApplyRemote(AppConfig &cfg, JsonObjectConst in) {
  bool changed = false;
  if (!in["power_mode"].isNull()) {
    String m = in["power_mode"].as<const char *>();
    if (m == "smart" || m == "always_on" || m == "periodic") changed |= assign(cfg.powerMode, m);
  }
  if (!in["wake_min"].isNull()) changed |= assign(cfg.wakeMin, max(1, in["wake_min"].as<int>()));
  if (!in["off_wake_min"].isNull()) changed |= assign(cfg.offWakeMin, max(0, in["off_wake_min"].as<int>()));
  if (!in["active_start"].isNull()) changed |= assign(cfg.activeStart, String(in["active_start"].as<const char *>()));
  if (!in["active_end"].isNull()) changed |= assign(cfg.activeEnd, String(in["active_end"].as<const char *>()));
  if (!in["weekends_off"].isNull()) changed |= assign(cfg.weekendsOff, in["weekends_off"].as<bool>());
  if (!in["periodic_in_window_only"].isNull()) changed |= assign(cfg.periodicInWindowOnly, in["periodic_in_window_only"].as<bool>());
  if (!in["usb_always_on"].isNull()) changed |= assign(cfg.usbAlwaysOn, in["usb_always_on"].as<bool>());
  if (!in["low_battery_pct"].isNull()) changed |= assign(cfg.lowBatteryPct, constrain(in["low_battery_pct"].as<int>(), 0, 90));
  if (!in["clear_offline_min"].isNull()) changed |= assign(cfg.clearOfflineMin, max(0, in["clear_offline_min"].as<int>()));
  if (!in["light_sleep"].isNull()) changed |= assign(cfg.lightSleep, in["light_sleep"].as<bool>());
  if (!in["ntp"].isNull()) changed |= assign(cfg.ntp, String(in["ntp"].as<const char *>()));
  if (!in["tz"].isNull()) changed |= assign(cfg.tzHours, in["tz"].as<int>());
  return changed;
}

void configAddWifi(AppConfig &cfg, const String &ssid, const String &pass) {
  for (size_t i = 0; i < cfg.wifi.size(); i++) {
    if (cfg.wifi[i].ssid == ssid) {
      cfg.wifi.erase(cfg.wifi.begin() + i);
      break;
    }
  }
  cfg.wifi.insert(cfg.wifi.begin(), {ssid, pass});
}
