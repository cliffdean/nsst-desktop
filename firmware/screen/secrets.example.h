// 複製成 secrets.h 再填入；secrets.h 不進 git
// 這些只是「沒有 /config.json 時」的開發預設值；正式使用時 WiFi 用手機設定、MQTT 由桌面工具用屏幕 IP 寫入
#pragma once
#define WIFI_SSID "your-wifi"
#define WIFI_PASSWORD "your-password"
#define MQTT_HOST ""
#define MQTT_PORT 1883
#define MQTT_USER "nsst"
#define MQTT_PASSWORD ""
