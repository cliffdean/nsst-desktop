// 設定模式(兩顆白鍵同時按住2秒進入)：屏幕開一個 WiFi 熱點，手機連上後自動彈出網頁，
// 列出附近的 WiFi 讓你選、輸入密碼，屏幕就能連上新的網路(換了環境也不怕)。
// 連上後把 IP 顯示在螢幕上，並維持 HTTP 設定介面 10 分鐘，讓桌面工具輸入這個 IP 把 MQTT 等設定寫進來。
// 這個函式會阻塞到結束，結束時由呼叫端重開機套用。
#pragma once
#include "appconfig.h"

void setupModeRun(AppConfig &cfg);
