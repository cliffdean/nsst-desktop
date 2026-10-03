// 設定相關的說明頁(畫在電子紙上；畫完要呼叫 epaper.update() 才會真的刷新，約35秒)
#pragma once
#include <Arduino.h>
#include <vector>

struct PageLine {
  String text;
  int size = 24;
  bool bold = false;
  uint16_t color = 0xF; // TFT_BLACK
};

// 通用說明頁：上方色塊標題 + 逐行文字(置中)
void pageDraw(const String &title, uint16_t titleBg, const std::vector<PageLine> &lines);

void pageSetupWifi(const String &apSsid);                       // 手機連線說明
void pageSetupDone(const String &wifiSsid, const String &ip);   // WiFi設好了，等桌面工具輸入IP
void pageNeedDesktop(const String &ip);                         // 沒設桌面工具(MQTT)時的提示
