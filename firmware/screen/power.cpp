#include "power.h"
#include <WiFi.h>
#include "driver/rtc_io.h"
#include "esp_sleep.h"
#include "board.h"
#include "clock.h"

static int minutesOf(const String &hhmm) {
  if (hhmm.length() < 4) return -1;
  int c = hhmm.indexOf(':');
  if (c < 1) return -1;
  return hhmm.substring(0, c).toInt() * 60 + hhmm.substring(c + 1).toInt();
}

static bool inWindow(const AppConfig &cfg, const struct tm &t) {
  if (cfg.weekendsOff && (t.tm_wday == 0 || t.tm_wday == 6)) return false;
  int s = minutesOf(cfg.activeStart), e = minutesOf(cfg.activeEnd);
  if (s < 0 || e < 0) return true;
  int m = t.tm_hour * 60 + t.tm_min;
  return s <= e ? (m >= s && m < e) : (m >= s || m < e); // 開始>結束代表跨午夜
}

bool powerInWorkWindow(const AppConfig &cfg) {
  struct tm t;
  if (!clockNow(t)) return true;
  return inWindow(cfg, t);
}

// 從 now+minSeconds 起每15分鐘往後找，第一個落在上班時段內的時間(最多找8天)，回傳距離現在的秒數
static uint32_t secondsUntilWindow(const AppConfig &cfg, uint32_t minSeconds) {
  if (!clockValid()) return minSeconds;
  time_t now = time(nullptr);
  time_t t = now + minSeconds;
  for (int i = 0; i < 8 * 96; i++) {
    struct tm local;
    localtime_r(&t, &local);
    if (inWindow(cfg, local)) return (uint32_t)(t - now);
    t += 900;
  }
  return minSeconds;
}

PowerPlan powerPlan(const AppConfig &cfg, const PowerContext &ctx) {
  PowerPlan p;
  if (ctx.usb && cfg.usbAlwaysOn) {
    p.stayOnline = true;
    p.fullSpeed = true;
    p.reason = "usb";
    return p;
  }
  uint32_t periodic = (uint32_t)max(1, cfg.wakeMin) * 60;
  // 連不上MQTT(抓取失敗)：清除畫面後睡眠，等下次定時再試。是否真的清由主程式依 clearOfflineMin 與畫面狀態決定
  auto unreachable = [&](uint32_t sleepSeconds) {
    p.sleepSeconds = sleepSeconds;
    p.clearScreen = true;
    p.reason = "unreachable";
    return p;
  };
  if (cfg.powerMode == "always_on") {
    if (ctx.mqttOk) {
      p.stayOnline = true;
      p.reason = "always_on";
      return p;
    }
    return unreachable(periodic);
  }
  if (cfg.powerMode == "periodic") {
    uint32_t s = cfg.periodicInWindowOnly ? secondsUntilWindow(cfg, periodic) : periodic;
    if (!ctx.mqttOk) return unreachable(s);
    p.sleepSeconds = s;
    p.reason = "periodic";
    return p;
  }
  // smart
  uint32_t off = (uint32_t)cfg.offWakeMin * 60;
  auto offSleep = [&]() { return off > 0 ? off : secondsUntilWindow(cfg, 60); };
  if (ctx.batteryPct < cfg.lowBatteryPct) {
    p.sleepSeconds = offSleep();
    p.reason = "low_battery";
    return p;
  }
  if (!ctx.mqttOk) return unreachable(offSleep());
  if (powerInWorkWindow(cfg)) {
    p.stayOnline = true;
    p.reason = "work_online";
    return p;
  }
  p.sleepSeconds = offSleep();
  p.reason = "off_hours";
  return p;
}

String powerWakeText(uint32_t sleepSeconds) {
  if (!clockValid() || sleepSeconds == 0) return "";
  time_t t = time(nullptr) + sleepSeconds;
  struct tm local;
  localtime_r(&t, &local);
  char buf[8];
  snprintf(buf, sizeof(buf), "%02d:%02d", local.tm_hour, local.tm_min);
  return String(buf);
}

// 預定的下次定時醒來時間(epoch)，放在RTC記憶體，深度睡眠期間保留
RTC_DATA_ATTR static time_t gNextWakeEpoch = 0;

uint32_t powerRemainingSleep() {
  if (gNextWakeEpoch == 0 || !clockValid()) return 0;
  time_t now = time(nullptr);
  return gNextWakeEpoch > now ? (uint32_t)(gNextWakeEpoch - now) : 0;
}

void powerDeepSleep(uint32_t seconds) {
  Serial.printf("[power] deep sleep %us\n", (unsigned)seconds);
  gNextWakeEpoch = (seconds > 0 && clockValid()) ? time(nullptr) + seconds : 0;
  Serial.flush();
  WiFi.disconnect(true, false);
  WiFi.mode(WIFI_OFF);
  digitalWrite(PIN_SD_EN, LOW); // TF卡斷電，睡眠時不白白耗電
  digitalWrite(PIN_LED, HIGH);

  // 三顆鍵都能喚醒：綠鍵=喚醒並重新連線；白鍵=切換分頁，或兩顆一起長按直接進設定模式(不用先喚醒)。
  // 單按白鍵喚醒後只做快速確認就繼續睡(見 screen.ino)，電量幾乎不受影響
  uint64_t mask = (1ULL << PIN_KEY_RIGHT) | (1ULL << PIN_KEY_MIDDLE) | (1ULL << PIN_KEY_LEFT);
  esp_sleep_enable_ext1_wakeup(mask, ESP_EXT1_WAKEUP_ANY_LOW);
  // 一般的上拉電阻在深度睡眠時會關掉，要改用常開電源域的上拉，按鍵才喚醒得了(官方範例同樣做法)
  const int pins[] = {PIN_KEY_RIGHT, PIN_KEY_MIDDLE, PIN_KEY_LEFT};
  for (int p : pins) {
    rtc_gpio_pullup_en((gpio_num_t)p);
    rtc_gpio_pulldown_dis((gpio_num_t)p);
  }
  if (seconds > 0) esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL);
  esp_deep_sleep_start();
}
