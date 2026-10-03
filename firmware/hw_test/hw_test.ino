// reTerminal E1002 硬體測試：確認按鍵、TF卡、電池、溫濕度、WiFi、PSRAM、刷新時間、深度睡眠喚醒
// 畫面只用內建英文字型(中文字型之後從TF卡載入)，詳細log走Serial(COM23, 115200)
#include "TFT_eSPI.h"
#include <SD.h>
#include <SPI.h>
#include <Wire.h>
#include <WiFi.h>
#include "esp_sleep.h"

#define PIN_KEY_RIGHT 3   // KEY0，右邊綠色鍵
#define PIN_KEY_MIDDLE 4  // KEY1，中間白色鍵
#define PIN_KEY_LEFT 5    // KEY2，左邊白色鍵
#define PIN_LED 6         // 低電位亮
#define PIN_BUZZER 45
#define PIN_BAT_ADC 1
#define PIN_BAT_EN 21
#define PIN_SD_SCK 7
#define PIN_SD_MISO 8
#define PIN_SD_MOSI 9
#define PIN_SD_CS 14
#define PIN_SD_DET 15
#define PIN_SD_EN 16
#define PIN_I2C_SDA 19
#define PIN_I2C_SCL 20
#define SHT4X_ADDR 0x44

#define IDLE_SLEEP_MS (3 * 60 * 1000)

EPaper epaper;

// 深度睡眠後還保留的資料(RTC記憶體)
RTC_DATA_ATTR uint32_t bootCount = 0;
RTC_DATA_ATTR uint32_t lastRefreshMs = 0;

struct Report {
  String wake;
  String lastKey = "-";
  float batteryV = 0;
  bool sdInserted = false;
  bool sdOk = false;
  String sdInfo;
  bool shtOk = false;
  float temp = 0, hum = 0;
  int wifiCount = 0;
  String wifiTop;
  uint32_t psram = 0;
  uint32_t flash = 0;
} report;

uint32_t lastActivity = 0;

void beep(int ms = 60) {
  tone(PIN_BUZZER, 2000, ms);
}

String wakeReason() {
  switch (esp_sleep_get_wakeup_cause()) {
    case ESP_SLEEP_WAKEUP_EXT1: {
      uint64_t mask = esp_sleep_get_ext1_wakeup_status();
      if (mask & (1ULL << PIN_KEY_RIGHT)) return "button RIGHT(green)";
      if (mask & (1ULL << PIN_KEY_MIDDLE)) return "button MIDDLE";
      if (mask & (1ULL << PIN_KEY_LEFT)) return "button LEFT";
      return "ext1";
    }
    case ESP_SLEEP_WAKEUP_TIMER: return "timer";
    default: return "power on / reset";
  }
}

float readBattery() {
  pinMode(PIN_BAT_EN, OUTPUT);
  digitalWrite(PIN_BAT_EN, HIGH);
  delay(5);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_BAT_ADC, ADC_11db);
  uint32_t sum = 0;
  for (int i = 0; i < 8; i++) sum += analogReadMilliVolts(PIN_BAT_ADC);
  digitalWrite(PIN_BAT_EN, LOW);
  return sum / 8 / 1000.0 * 2; // 分壓電阻1:1
}

// SHT4x高精度量測：送0xFD，等10ms，讀6 bytes(溫度2+CRC、濕度2+CRC)，直接用I2C不額外裝函式庫
bool readSht4x(float &t, float &h) {
  Wire.beginTransmission(SHT4X_ADDR);
  Wire.write(0xFD);
  if (Wire.endTransmission() != 0) return false;
  delay(10);
  if (Wire.requestFrom(SHT4X_ADDR, 6) != 6) return false;
  uint8_t b[6];
  for (int i = 0; i < 6; i++) b[i] = Wire.read();
  uint16_t rt = (b[0] << 8) | b[1];
  uint16_t rh = (b[3] << 8) | b[4];
  t = -45 + 175.0 * rt / 65535.0;
  h = constrain(-6 + 125.0 * rh / 65535.0, 0, 100);
  return true;
}

void testSd() {
  pinMode(PIN_SD_EN, OUTPUT);
  digitalWrite(PIN_SD_EN, HIGH);
  pinMode(PIN_SD_DET, INPUT_PULLUP);
  delay(50);
  report.sdInserted = digitalRead(PIN_SD_DET) == LOW;
  // TF卡跟螢幕共用同一條SPI(HSPI)：螢幕初始化時沒有接MISO，這裡用螢幕的SPI實例補上MISO再掛TF卡(同Seeed_GFX官方範例)
  SPIClass &spi = epaper.getSPIinstance();
  spi.end(); // 已經begin過的SPI再begin會直接略過，要先end才會套用新的腳位
  spi.begin(PIN_SD_SCK, PIN_SD_MISO, PIN_SD_MOSI, -1);
  if (!SD.begin(PIN_SD_CS, spi)) {
    report.sdInfo = "mount failed";
    return;
  }
  const char *types[] = {"NONE", "MMC", "SD", "SDHC", "UNKNOWN"};
  uint8_t type = SD.cardType();
  uint64_t total = SD.totalBytes() / (1024 * 1024);
  uint64_t used = SD.usedBytes() / (1024 * 1024);

  // 寫入/讀回測試
  File f = SD.open("/hwtest.txt", FILE_APPEND);
  bool writeOk = f && f.printf("boot %lu\n", bootCount) > 0;
  if (f) f.close();
  f = SD.open("/hwtest.txt", FILE_READ);
  size_t size = f ? f.size() : 0;
  if (f) f.close();

  report.sdOk = writeOk && size > 0;
  report.sdInfo = String(types[type > 4 ? 4 : type]) + " " + String((uint32_t)total) + "MB, used " +
                  String((uint32_t)used) + "MB, write " + (report.sdOk ? "OK" : "FAIL");
}

void testWifi() {
  WiFi.mode(WIFI_STA);
  int n = WiFi.scanNetworks();
  report.wifiCount = n < 0 ? 0 : n;
  report.wifiTop = "";
  for (int i = 0; i < n && i < 4; i++) {
    if (i) report.wifiTop += ", ";
    report.wifiTop += WiFi.SSID(i) + "(" + WiFi.RSSI(i) + ")";
  }
  WiFi.scanDelete();
  WiFi.mode(WIFI_OFF);
}

void runTests() {
  Serial.println("[step] battery"); Serial.flush();
  report.batteryV = readBattery();
  Serial.println("[step] sht4x"); Serial.flush();
  report.shtOk = readSht4x(report.temp, report.hum);
  Serial.println("[step] sd"); Serial.flush();
  testSd();
  Serial.println("[step] wifi"); Serial.flush();
  testWifi();
  report.psram = ESP.getPsramSize();
  report.flash = ESP.getFlashChipSize();

  Serial.printf("[test] boot=%lu wake=%s key=%s\n", bootCount, report.wake.c_str(), report.lastKey.c_str());
  Serial.printf("[test] battery=%.2fV sht=%d %.1fC %.1f%%\n", report.batteryV, report.shtOk, report.temp, report.hum);
  Serial.printf("[test] sd inserted=%d %s\n", report.sdInserted, report.sdInfo.c_str());
  Serial.printf("[test] wifi %d: %s\n", report.wifiCount, report.wifiTop.c_str());
  Serial.printf("[test] psram=%lu flash=%lu\n", report.psram, report.flash);
}

void line(int &y, const char *label, const String &value, uint16_t color = TFT_BLACK) {
  epaper.setTextColor(TFT_BLACK, TFT_WHITE);
  epaper.drawString(label, 20, y, 4);
  epaper.setTextColor(color, TFT_WHITE);
  epaper.drawString(value, 230, y, 4);
  y += 34;
}

void draw() {
  epaper.fillScreen(TFT_WHITE);
  epaper.fillRect(0, 0, 800, 50, TFT_BLACK);
  epaper.setTextColor(TFT_WHITE, TFT_BLACK);
  epaper.drawString("reTerminal E1002 hardware test", 20, 12, 4);
  epaper.drawString("#" + String(bootCount), 700, 12, 4);

  int y = 66;
  line(y, "Wake reason", report.wake);
  line(y, "Last button", report.lastKey, TFT_BLUE);
  line(y, "Battery", String(report.batteryV, 2) + " V", report.batteryV < 3.5 ? TFT_RED : TFT_GREEN);
  line(y, "Temp / Humid", report.shtOk ? String(report.temp, 1) + " C / " + String(report.hum, 0) + " %" : "SHT4x not found",
       report.shtOk ? TFT_BLACK : TFT_RED);
  line(y, "TF card", String(report.sdInserted ? "[in] " : "[no card] ") + report.sdInfo, report.sdOk ? TFT_BLACK : TFT_RED);
  line(y, "WiFi scan", String(report.wifiCount) + " networks");
  epaper.setTextColor(TFT_BLACK, TFT_WHITE);
  epaper.drawString(report.wifiTop.substring(0, 60), 20, y, 2);
  y += 26;
  line(y, "PSRAM / Flash", String(report.psram / 1024 / 1024) + " MB / " + String(report.flash / 1024 / 1024) + " MB");
  line(y, "Prev refresh", lastRefreshMs ? String(lastRefreshMs / 1000.0, 1) + " s" : "(first run)");

  // 6色色塊，確認顏色是否正確
  const uint16_t colors[] = {TFT_BLACK, TFT_WHITE, TFT_RED, TFT_YELLOW, TFT_GREEN, TFT_BLUE};
  const char *names[] = {"BLACK", "WHITE", "RED", "YELLOW", "GREEN", "BLUE"};
  for (int i = 0; i < 6; i++) {
    int x = 20 + i * 128;
    epaper.fillRect(x, 410, 110, 40, colors[i]);
    epaper.drawRect(x, 410, 110, 40, TFT_BLACK);
    epaper.setTextColor(TFT_BLACK, TFT_WHITE);
    epaper.drawString(names[i], x, 455, 2);
  }
  epaper.setTextColor(TFT_BLACK, TFT_WHITE);
  epaper.drawString("Press any key to re-test. Sleep after 3 min idle, any key wakes.", 300, 66 + 34 * 8 + 30, 2);

  Serial.println("[step] epaper.update"); Serial.flush();
  uint32_t t0 = millis();
  epaper.update();
  lastRefreshMs = millis() - t0;
  Serial.printf("[test] refresh took %lu ms\n", lastRefreshMs);
}

void goSleep() {
  Serial.println("[test] idle, going to deep sleep");
  Serial.flush();
  uint64_t mask = (1ULL << PIN_KEY_RIGHT) | (1ULL << PIN_KEY_MIDDLE) | (1ULL << PIN_KEY_LEFT);
  esp_sleep_enable_ext1_wakeup(mask, ESP_EXT1_WAKEUP_ANY_LOW);
  esp_deep_sleep_start();
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("[step] setup start"); Serial.flush();
  // TF卡跟螢幕共用SPI：插著卡時一定要先供電並把卡的CS拉高，否則卡片會干擾匯流排，螢幕收不到資料、畫面不會變
  pinMode(PIN_SD_CS, OUTPUT);
  digitalWrite(PIN_SD_CS, HIGH);
  pinMode(PIN_SD_EN, OUTPUT);
  digitalWrite(PIN_SD_EN, HIGH);
  delay(20);
  bootCount++;
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);
  pinMode(PIN_KEY_RIGHT, INPUT_PULLUP);
  pinMode(PIN_KEY_MIDDLE, INPUT_PULLUP);
  pinMode(PIN_KEY_LEFT, INPUT_PULLUP);
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  beep();

  report.wake = wakeReason();
  if (report.wake.startsWith("button")) report.lastKey = report.wake.substring(7);

  Serial.println("[step] epaper.begin"); Serial.flush();
  epaper.begin();
  Serial.println("[step] epaper ok"); Serial.flush();
  runTests();
  draw();
  digitalWrite(PIN_LED, HIGH);
  lastActivity = millis();
}

void loop() {
  const int pins[] = {PIN_KEY_RIGHT, PIN_KEY_MIDDLE, PIN_KEY_LEFT};
  const char *names[] = {"RIGHT(green)", "MIDDLE", "LEFT"};
  for (int i = 0; i < 3; i++) {
    if (digitalRead(pins[i]) == LOW) {
      delay(50);
      if (digitalRead(pins[i]) != LOW) continue;
      uint32_t pressedAt = millis();
      while (digitalRead(pins[i]) == LOW) delay(10);
      uint32_t held = millis() - pressedAt;
      report.lastKey = String(names[i]) + (held > 800 ? " long " : " short ") + String(held) + "ms";
      Serial.printf("[test] key %s\n", report.lastKey.c_str());
      beep();
      digitalWrite(PIN_LED, LOW);
      runTests();
      draw();
      digitalWrite(PIN_LED, HIGH);
      lastActivity = millis();
    }
  }
  if (millis() - lastActivity > IDLE_SLEEP_MS) goSleep();
  delay(20);
}
