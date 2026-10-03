#include "display.h"

EPaper epaper;
static bool began = false;

void displayBegin() {
  if (began) return;
  epaper.begin();
  began = true;
}

void displayFlush() {
  displayBegin();
  uint32_t t0 = millis();
  epaper.update();
  epaper.sleep(); // 面板斷電：電子紙不供電也會保持畫面，供電只會耗電、長時間通電還傷面板
  Serial.printf("[display] refresh %lums\n", millis() - t0);
}
