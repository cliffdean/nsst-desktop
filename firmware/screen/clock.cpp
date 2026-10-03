#include "clock.h"
#include <Wire.h>
#include <sys/time.h>
#include "esp_sntp.h"

#define PCF8563_ADDR 0x51
static const time_t kMinValid = 1735689600; // 2025-01-01，早於這個時間一定是沒校過

static uint8_t bcdToDec(uint8_t v) { return (v >> 4) * 10 + (v & 0x0F); }
static uint8_t decToBcd(uint8_t v) { return ((v / 10) << 4) | (v % 10); }

static char gTz[16] = "UTC0";

void clockInit(int tzHours) {
  // POSIX TZ字串的正負號跟直覺相反：UTC+8 要寫成 "UTC-8"
  snprintf(gTz, sizeof(gTz), "UTC%+d", -tzHours);
  setenv("TZ", gTz, 1);
  tzset();
}

bool clockValid() {
  return time(nullptr) > kMinValid;
}

// 晶片裡存的是本地時間(BCD)，VL位元(秒暫存器bit7)為1代表掉電過、時間不可信
static bool readRtcChip(struct tm &t) {
  Wire.beginTransmission(PCF8563_ADDR);
  Wire.write(0x02);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(PCF8563_ADDR, 7) != 7) return false;
  uint8_t b[7];
  for (int i = 0; i < 7; i++) b[i] = Wire.read();
  if (b[0] & 0x80) return false;
  memset(&t, 0, sizeof(t));
  t.tm_sec = bcdToDec(b[0] & 0x7F);
  t.tm_min = bcdToDec(b[1] & 0x7F);
  t.tm_hour = bcdToDec(b[2] & 0x3F);
  t.tm_mday = bcdToDec(b[3] & 0x3F);
  t.tm_wday = b[4] & 0x07;
  t.tm_mon = bcdToDec(b[5] & 0x1F) - 1;
  t.tm_year = bcdToDec(b[6]) + 100; // 晶片只存兩位數年份，視為2000年代
  t.tm_isdst = -1;
  return t.tm_year >= 125 && t.tm_mon >= 0 && t.tm_mon < 12 && t.tm_mday >= 1 && t.tm_mday <= 31;
}

static bool writeRtcChip(const struct tm &t) {
  Wire.beginTransmission(PCF8563_ADDR);
  Wire.write(0x02);
  Wire.write(decToBcd(t.tm_sec));
  Wire.write(decToBcd(t.tm_min));
  Wire.write(decToBcd(t.tm_hour));
  Wire.write(decToBcd(t.tm_mday));
  Wire.write(t.tm_wday & 0x07);
  Wire.write(decToBcd(t.tm_mon + 1));
  Wire.write(decToBcd(t.tm_year % 100));
  return Wire.endTransmission() == 0;
}

bool clockLoadFromRtc() {
  struct tm t;
  if (!readRtcChip(t)) return clockValid(); // 晶片不可信但系統時間(深度睡眠期間保留)可能還在
  time_t epoch = mktime(&t);
  // 系統時間(睡眠期間由內部計時器維持)已經有效時以它為準，兩者差太多才用晶片的
  if (clockValid() && labs((long)(time(nullptr) - epoch)) < 300) return true;
  struct timeval tv = {epoch, 0};
  settimeofday(&tv, nullptr);
  return true;
}

bool clockSyncNtp(const String &ntpServer, uint32_t timeoutMs) {
  // 不能用 configTime()：它會把TZ重設成GMT，本地時間就變成UTC(實測慢8小時，會讓上班時段判斷錯誤)。configTzTime()會一併設定時區
  sntp_set_sync_status(SNTP_SYNC_STATUS_RESET);
  configTzTime(gTz, ntpServer.c_str(), "time.google.com", "time.windows.com");
  uint32_t t0 = millis();
  // 一定要等SNTP真的回應：系統時間可能早就被時鐘晶片設成「看起來有效」的舊時間，只看clockValid()會把舊時間當成校好了
  while (millis() - t0 < timeoutMs) {
    if (sntp_get_sync_status() == SNTP_SYNC_STATUS_COMPLETED && clockValid()) {
      time_t now = time(nullptr);
      struct tm local;
      localtime_r(&now, &local);
      writeRtcChip(local);
      Serial.printf("[clock] ntp ok %04d-%02d-%02d %02d:%02d\n", local.tm_year + 1900, local.tm_mon + 1, local.tm_mday, local.tm_hour, local.tm_min);
      return true;
    }
    delay(50);
  }
  Serial.println("[clock] ntp failed, using rtc chip");
  return clockLoadFromRtc();
}

bool clockNow(struct tm &local) {
  if (!clockValid()) return false;
  time_t now = time(nullptr);
  localtime_r(&now, &local);
  return true;
}
