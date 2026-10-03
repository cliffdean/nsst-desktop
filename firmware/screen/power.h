// 電源與休眠規則：每一輪(開機/醒來/保持連線時每分鐘)依當下狀況算出「接下來怎麼做」
//   1. 插USB充電(且 usbAlwaysOn)      → 保持連線，不休眠，WiFi全速
//   2. always_on                        → 保持連線(WiFi省電)
//   3. periodic                         → 深度睡眠，每 wakeMin 分鐘醒來抓一次
//   4. smart(預設)
//        電量低於 lowBatteryPct         → 深度睡眠(保命)，每 offWakeMin 分鐘醒來
//        上班時段 且 連得上MQTT         → 保持連線(WiFi省電)，即時收推送
//        其餘(下班時段/連不上)          → 深度睡眠，每 offWakeMin 分鐘醒來(0=睡到下個上班時段)，沒資料就繼續睡
// 任一按鍵隨時可喚醒
#pragma once
#include <Arduino.h>
#include "appconfig.h"

struct PowerContext {
  bool usb = false;       // 目前插著USB
  int batteryPct = 100;
  bool mqttOk = false;    // 這一輪連得上MQTT
};

struct PowerPlan {
  bool stayOnline = false;
  bool fullSpeed = false;    // 保持連線時用全速(插USB)；false=WiFi省電+降頻
  uint32_t sleepSeconds = 0; // stayOnline=false時要睡幾秒
  const char *reason = "";   // 給status/log看的原因代碼
};

PowerPlan powerPlan(const AppConfig &cfg, const PowerContext &ctx);

// 現在是不是上班時段(含週末規則)。時間不可信時視為上班時段
bool powerInWorkWindow(const AppConfig &cfg);

// "HH:MM" 格式的下次醒來時間，時間不可信回空字串
String powerWakeText(uint32_t sleepSeconds);

// 進入深度睡眠；三顆按鍵都能喚醒(白鍵喚醒後只做快速確認：不是兩顆白鍵長按就馬上繼續睡)，seconds>0 另外設定時喚醒。不會返回
void powerDeepSleep(uint32_t seconds);

// 白鍵把屏幕喚醒、但不需要做事時，要接著睡完「原本預定的睡眠時間」，不能重新計時。回傳還剩幾秒(沒有預定或已過回傳0)
uint32_t powerRemainingSleep();
