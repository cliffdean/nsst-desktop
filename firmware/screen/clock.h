// 時間：優先用 NTP(連上WiFi時)，同時寫進板上的 PCF8563 時鐘晶片；沒網路時(例如深度睡眠醒來後先不連線)從晶片讀回
#pragma once
#include <Arduino.h>
#include <time.h>

// 設定時區(UTC+tz小時)；每次開機都要呼叫一次
void clockInit(int tzHours);

// 嘗試用NTP校時(需要已連上WiFi)；成功就同步到時鐘晶片。失敗時退回讀晶片。回傳時間是否可信
bool clockSyncNtp(const String &ntpServer, uint32_t timeoutMs = 6000);

// 只從晶片讀(不需要網路)，把系統時間設好。回傳時間是否可信
bool clockLoadFromRtc();

// 系統時間是否已經設過(不是1970年)
bool clockValid();

// 目前本地時間；時間不可信時回傳false
bool clockNow(struct tm &local);
