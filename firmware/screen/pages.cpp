#include "pages.h"
#include "display.h"
#include "fonts.h"

void pageDraw(const String &title, uint16_t titleBg, const std::vector<PageLine> &lines) {
  epaper.fillScreen(TFT_WHITE);
  epaper.fillRect(0, 0, SCREEN_W, 72, titleBg);
  textDraw(title, SCREEN_W / 2, 36, 30, titleBg == TFT_YELLOW ? TFT_BLACK : TFT_WHITE, titleBg, FontWeight::Bold, TextAlign::Center);
  int y = 120;
  for (const PageLine &l : lines) {
    int step = l.size + 22;
    if (l.text.length()) {
      textDraw(l.text, SCREEN_W / 2, y + l.size / 2, l.size, l.color, TFT_WHITE, l.bold ? FontWeight::Bold : FontWeight::Regular,
               TextAlign::Center, SCREEN_W - 40);
    }
    y += step;
  }
}

void pageSetupWifi(const String &apSsid) {
  pageDraw("設定 WiFi", TFT_YELLOW,
           {{"1. 用手機連線到這個 WiFi(不需要密碼)：", 22, false},
            {apSsid, 44, true, TFT_BLUE},
            {"2. 連上後會自動跳出設定頁，選擇要用的 WiFi 並輸入密碼", 22, false},
            {"沒有自動跳出的話，用手機瀏覽器開啟 192.168.4.1", 20, false},
            {"", 10},
            {"兩顆白鍵同時按住 2 秒，可隨時再進入這個模式", 18, false}});
}

void pageSetupDone(const String &wifiSsid, const String &ip) {
  pageDraw("WiFi 設定完成", TFT_GREEN,
           {{"已連上：" + wifiSsid, 26, true},
            {"", 8},
            {"屏幕 IP", 22, false},
            {ip, 54, true, TFT_BLUE},
            {"", 8},
            {"請在桌面工具的「電子紙看板」設定輸入這個 IP，", 22, false},
            {"按「連接屏幕」，其他設定會自動寫進屏幕", 22, false},
            {"這個設定視窗會維持 10 分鐘", 18, false}});
}

void pageNeedDesktop(const String &ip) {
  pageDraw("等待桌面工具", TFT_BLUE,
           {{"這台屏幕還沒有設定桌面工具的連線", 24, true},
            {"", 8},
            {"屏幕 IP", 22, false},
            {ip.length() ? ip : String("(WiFi 未連線，兩顆白鍵同時按住 2 秒設定)"), ip.length() ? 54 : 22, true, TFT_BLUE},
            {"", 8},
            {"請在桌面工具的「電子紙看板」設定輸入這個 IP，按「連接屏幕」", 20, false}});
}
