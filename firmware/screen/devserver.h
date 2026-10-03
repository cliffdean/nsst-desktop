// HTTP 服務：設定介面 + 開發用工具。只在需要時啟動(保持連線時、按鍵喚醒後的設定視窗、設定模式)
//   GET  /info            基本資訊(不需認證)：IP、SSID、電量、模式、畫面版本…
//   GET/POST /config      讀/寫設定(JSON，密碼遮罩)；桌面工具用屏幕IP把MQTT位置、帳密、休眠設定寫進來
//   POST /reboot          重開機
//   GET  /ls?dir=/db      列目錄；路徑加 flash: 前綴代表內建Flash(LittleFS，放字型/資料庫)，例如 flash:/fonts
//   POST /fetch?url=http://...&path=/x  叫屏幕自己去下載檔案(path可加flash:前綴)，大小核對後才生效
//   GET  /md5?path=/x     檔案MD5(核對用)　POST /rm?path=/x 刪除檔案
//   POST /render          重新讀資料並刷新電子紙(約35秒)；?dry=1 只畫到記憶體不刷新；?page=2 指定第幾頁(從1算)
//   GET  /preview.bmp     下載記憶體裡的畫面(不刷新電子紙也能看版面)
// 認證：除了 /info，其餘要在標頭帶 X-Auth: <MQTT密碼>；屏幕還沒設過密碼，或設定視窗開著時不用
// 不提供「電腦推上去」的上傳：ESP32 WebServer解析大型multipart不穩，實測會截斷
#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include <WebServer.h>
#include "appconfig.h"

// infoFill：主程式補上電量、模式等執行期資訊到 /info
void devServerBegin(AppConfig *cfg, void (*infoFill)(JsonObject) = nullptr);
void devServerEnd();
bool devServerRunning();
void devServerLoop();
WebServer &devServerHttp();
void devServerAuthOpen(bool open);
String devServerAddress();  // 例如 "192.168.10.122"，沒連上回空字串
int devServerTakeRenderRequest(int *page = nullptr); // 0=無 1=畫並刷新 2=只畫到記憶體；page 是要求的頁(從0開始)，沒指定回-1
bool devServerTakeConfigChanged();
bool devServerRebootRequested();
