#include "netmqtt.h"
#include <WiFi.h>
#include <PubSubClient.h>

static WiFiClient wifiClient;
static PubSubClient mqtt(wifiClient);
static MqttInbox inbox;
static String topicPrefix;

MqttInbox &netInbox() {
  return inbox;
}

bool netWifiConnected() {
  return WiFi.status() == WL_CONNECTED;
}

String netSsid() {
  return netWifiConnected() ? WiFi.SSID() : String();
}

void netPowerSave(bool on) {
  WiFi.setSleep(on ? WIFI_PS_MAX_MODEM : WIFI_PS_NONE);
  setCpuFrequencyMhz(on ? 80 : 240);
}

// 掃描附近網路，依設定檔的順序找第一組有出現的連線；一組都沒出現就直接試第一組(可能是隱藏的網路)
bool netWifiConnect(const AppConfig &cfg, uint32_t timeoutMs) {
  if (cfg.wifi.empty()) {
    Serial.println("[net] no wifi configured");
    return false;
  }
  WiFi.mode(WIFI_STA);
  WiFi.setHostname("nsst-screen");
  WiFi.setAutoReconnect(true);

  const WifiEntry *pick = nullptr;
  int n = WiFi.scanNetworks(false, true);
  for (const WifiEntry &w : cfg.wifi) {
    for (int i = 0; i < n && !pick; i++) {
      if (WiFi.SSID(i) == w.ssid) pick = &w;
    }
    if (pick) break;
  }
  WiFi.scanDelete();
  if (!pick) pick = &cfg.wifi[0];

  Serial.printf("[net] wifi -> %s\n", pick->ssid.c_str());
  WiFi.begin(pick->ssid.c_str(), pick->pass.c_str());
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < timeoutMs) delay(100);
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[net] wifi connect failed");
    return false;
  }
  Serial.printf("[net] wifi ok ip=%s rssi=%d (%lums)\n", WiFi.localIP().toString().c_str(), WiFi.RSSI(), millis() - t0);
  return true;
}

static void onMessage(char *topic, byte *payload, unsigned int length) {
  String t(topic);
  String body;
  body.reserve(length);
  for (unsigned int i = 0; i < length; i++) body += (char)payload[i];
  if (t.endsWith("/dashboard")) {
    inbox.dashboard = body;
    inbox.hasDashboard = true;
  } else if (t.endsWith("/config")) {
    inbox.config = body;
    inbox.hasConfig = true;
  } else if (t.endsWith("/cmd")) {
    inbox.cmd = body;
    inbox.hasCmd = true;
  }
  Serial.printf("[mqtt] %s (%u bytes)\n", topic, length);
}

bool netMqttConnect(const AppConfig &cfg, uint32_t timeoutMs) {
  if (!cfg.hasMqtt() || !netWifiConnected()) return false;
  topicPrefix = "nsst/screen/" + cfg.deviceId + "/";
  mqtt.setServer(cfg.mqttHost.c_str(), cfg.mqttPort);
  mqtt.setBufferSize(32768); // 儀表板內容可能有十幾KB
  mqtt.setKeepAlive(60);
  mqtt.setSocketTimeout(5);
  mqtt.setCallback(onMessage);

  String clientId = "nsst-screen-" + String((uint32_t)(ESP.getEfuseMac() >> 16), HEX);
  uint32_t t0 = millis();
  while (!mqtt.connected() && millis() - t0 < timeoutMs) {
    if (mqtt.connect(clientId.c_str(), cfg.mqttUser.c_str(), cfg.mqttPass.c_str())) break;
    Serial.printf("[mqtt] connect failed rc=%d\n", mqtt.state());
    if (mqtt.state() == MQTT_CONNECT_BAD_CREDENTIALS || mqtt.state() == MQTT_CONNECT_UNAUTHORIZED) return false; // 密碼錯，重試沒用
    delay(500);
  }
  if (!mqtt.connected()) return false;
  mqtt.subscribe((topicPrefix + "dashboard").c_str(), 1);
  mqtt.subscribe((topicPrefix + "config").c_str(), 1);
  mqtt.subscribe((topicPrefix + "cmd").c_str(), 0);
  Serial.printf("[mqtt] connected to %s:%u (%lums)\n", cfg.mqttHost.c_str(), cfg.mqttPort, millis() - t0);
  return true;
}

bool netMqttConnected() {
  return mqtt.connected();
}

void netMqttLoop() {
  mqtt.loop();
}

void netMqttDisconnect() {
  if (mqtt.connected()) mqtt.disconnect();
}

bool netMqttPublish(const AppConfig &cfg, const char *subtopic, const String &payload, bool retain) {
  if (!mqtt.connected()) return false;
  return mqtt.publish((topicPrefix + subtopic).c_str(), payload.c_str(), retain);
}

bool netMqttWaitRetained(uint32_t timeoutMs) {
  uint32_t t0 = millis();
  while (millis() - t0 < timeoutMs && mqtt.connected()) {
    mqtt.loop();
    if (inbox.hasDashboard && inbox.hasConfig) break;
    delay(20);
  }
  // 兩個都到之後再多收一下，避免漏掉緊接著的其他訊息
  uint32_t t1 = millis();
  while (millis() - t1 < 150) mqtt.loop();
  return inbox.hasDashboard;
}
