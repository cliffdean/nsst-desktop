// WiFi 與 MQTT 連線
//   WiFi：設定檔裡可以存多組，掃描附近有哪些就連哪一組(換環境不用重新設定)
//   MQTT：訂閱 nsst/screen/<deviceId>/{dashboard,config,cmd}，收到的內容先放進 inbox，由主程式處理
#pragma once
#include <Arduino.h>
#include "appconfig.h"

bool netWifiConnect(const AppConfig &cfg, uint32_t timeoutMs = 20000);
bool netWifiConnected();
String netSsid();

// 保持連線時的省電：true=WiFi省電模式+CPU降到80MHz；false=全速(連線、畫圖、插USB時)
void netPowerSave(bool on);

struct MqttInbox {
  bool hasDashboard = false;
  String dashboard;
  bool hasConfig = false;
  String config;
  bool hasCmd = false;
  String cmd;
};
MqttInbox &netInbox();

bool netMqttConnect(const AppConfig &cfg, uint32_t timeoutMs = 8000);
bool netMqttConnected();
void netMqttLoop();
void netMqttDisconnect();
bool netMqttPublish(const AppConfig &cfg, const char *subtopic, const String &payload, bool retain = false);

// 等到收到 dashboard 與 config 兩個保留訊息(或逾時)。回傳是否收到 dashboard
bool netMqttWaitRetained(uint32_t timeoutMs);
