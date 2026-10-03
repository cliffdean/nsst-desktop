// 工作儀表板頁：工程師與本週追蹤(加星)專案的待處理/待審核，資料來自TF卡/db/dashboard.json(桌面工具產生)
#pragma once
#include <ArduinoJson.h>

struct DeviceStatus {
  int batteryPct = -1;
  float temperature = NAN;
  float humidity = NAN;
  String ip;       // 保持連線時顯示的屏幕IP(桌面工具用它寫設定)，空字串=不顯示
  String nextSync; // 例如 "14:40"，空字串=不顯示
  String note;     // 狀態列額外訊息(例如IP、錯誤)
};

// 總頁數：專案/工程師太多一頁放不下時自動分頁(工程師固定每頁14位，專案依各自高度裝滿一頁)。需要字型已載入(要量文字寬度)
int dashboardPageCount(const JsonDocument &doc);

// 畫第 page 頁(從0開始，超出會被限制)，回傳總頁數。doc為null(沒有資料)時畫「等待資料」畫面
int dashboardRender(const JsonDocument *doc, const DeviceStatus &status, int page = 0);
