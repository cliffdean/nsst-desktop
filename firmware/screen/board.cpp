#include "board.h"
#include <SD.h>
#include <LittleFS.h>
#include <SPI.h>
#include <Wire.h>
#include "display.h"

void boardEarlyInit() {
  pinMode(PIN_SD_CS, OUTPUT);
  digitalWrite(PIN_SD_CS, HIGH);
  pinMode(PIN_SD_EN, OUTPUT);
  digitalWrite(PIN_SD_EN, HIGH);
  pinMode(PIN_SD_DET, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, HIGH);
  pinMode(PIN_KEY_RIGHT, INPUT_PULLUP);
  pinMode(PIN_KEY_MIDDLE, INPUT_PULLUP);
  pinMode(PIN_KEY_LEFT, INPUT_PULLUP);
  delay(20);
}

bool boardMountSd() {
  if (digitalRead(PIN_SD_DET) != LOW) {
    Serial.println("[sd] no card");
    return false;
  }
  SPIClass &spi = epaper.getSPIinstance();
  SD.end();
  spi.end(); // 已經begin過的SPI再begin會直接略過，要先end才會套用含MISO的腳位
  spi.begin(PIN_SD_SCK, PIN_SD_MISO, PIN_SD_MOSI, -1);
  // 速度用4MHz：TF卡跟螢幕共用線路，高速不穩(出廠固件甚至用1MHz)；同時開檔上限提高到16(字型渲染器會一直開著字型檔)
  if (!SD.begin(PIN_SD_CS, spi, 4000000, "/sd", 16)) {
    Serial.println("[sd] mount failed");
    return false;
  }
  Serial.printf("[sd] mounted %lluMB\n", SD.cardSize() / (1024 * 1024));
  return true;
}

bool boardMountFlashFs() {
  uint32_t t0 = millis();
  if (!LittleFS.begin(true, "/flash", 10, "spiffs")) {
    Serial.println("[flash] LittleFS mount failed");
    return false;
  }
  Serial.printf("[flash] LittleFS %uKB used / %uKB in %lums\n", (unsigned)(LittleFS.usedBytes() / 1024),
                (unsigned)(LittleFS.totalBytes() / 1024), millis() - t0);
  return true;
}

float boardBatteryVolts() {
  pinMode(PIN_BAT_EN, OUTPUT);
  digitalWrite(PIN_BAT_EN, HIGH);
  delay(5);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_BAT_ADC, ADC_11db);
  uint32_t sum = 0;
  for (int i = 0; i < 8; i++) sum += analogReadMilliVolts(PIN_BAT_ADC);
  digitalWrite(PIN_BAT_EN, LOW);
  return sum / 8 / 1000.0f * 2; // 分壓1:1
}

// 鋰電池粗略換算：4.15V以上視為滿電，3.4V以下視為沒電，中間線性
int boardBatteryPercent(float volts) {
  int pct = (int)((volts - 3.4f) / (4.15f - 3.4f) * 100);
  return constrain(pct, 0, 100);
}

void boardBeep(int ms) {
  tone(PIN_BUZZER, 2000, ms);
}

void boardLed(bool on) {
  digitalWrite(PIN_LED, on ? LOW : HIGH);
}

// SHT4x高精度量測：送0xFD，等10ms，讀6 bytes(溫度2+CRC、濕度2+CRC)
bool boardReadClimate(float &temp, float &humidity) {
  Wire.beginTransmission(0x44);
  Wire.write(0xFD);
  if (Wire.endTransmission() != 0) return false;
  delay(10);
  if (Wire.requestFrom(0x44, 6) != 6) return false;
  uint8_t b[6];
  for (int i = 0; i < 6; i++) b[i] = Wire.read();
  temp = -45 + 175.0f * ((b[0] << 8) | b[1]) / 65535.0f;
  humidity = constrain(-6 + 125.0f * ((b[3] << 8) | b[4]) / 65535.0f, 0.0f, 100.0f);
  return true;
}

bool boardUsbPresent(bool restoreSerial) {
  const int pinRx = 44;
  if (restoreSerial) Serial.end();
  pinMode(pinRx, INPUT_PULLDOWN);
  delay(15);
  int high = 0;
  for (int i = 0; i < 6; i++) {
    high += digitalRead(pinRx);
    delay(2);
  }
  pinMode(pinRx, INPUT);
  if (restoreSerial) Serial.begin(115200);
  return high >= 5;
}

int boardBatteryPercentNow() {
  return boardBatteryPercent(boardBatteryVolts());
}
