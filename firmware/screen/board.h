// reTerminal E1002 板子腳位與共用硬體(TF卡、電池、按鍵)
#pragma once
#include <Arduino.h>

#define PIN_KEY_RIGHT 3   // 右邊綠色鍵
#define PIN_KEY_MIDDLE 4  // 中間白色鍵
#define PIN_KEY_LEFT 5    // 左邊白色鍵
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

// 開機第一件事：TF卡跟螢幕共用SPI，卡片CS沒拉高會干擾匯流排，螢幕會收不到資料(畫面不變)
void boardEarlyInit();

// 螢幕begin之後呼叫：用螢幕的SPI實例補上MISO再掛TF卡
bool boardMountSd();

// 內建Flash的LittleFS檔案區(約24MB，見partitions.csv)：放字型等系統資源，讀取穩定不受TF卡影響
// 第一次使用會自動格式化(要幾十秒)
bool boardMountFlashFs();

float boardBatteryVolts();
int boardBatteryPercent(float volts);

void boardBeep(int ms = 60);
void boardLed(bool on);
bool boardReadClimate(float &temp, float &humidity);

// 是不是插著USB：這塊板子沒有可讀的充電狀態腳位，改看USB轉序列晶片(CH340)的TX線(接到GPIO44)：
// 晶片有電時TX固定輸出高電位，沒電時浮空，用內部下拉電阻就能分辨。
// 會暫時停掉Serial(借用GPIO44)再恢復，約30毫秒；Serial.begin之後呼叫時 restoreSerial=true
bool boardUsbPresent(bool restoreSerial = true);

int boardBatteryPercentNow();
