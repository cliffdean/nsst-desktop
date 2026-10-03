/**
 * Product: reTerminal E1002
 * Display: 7.3 inch full-color E Ink Spectra 6, 800x480
 * Wiki: https://wiki.seeedstudio.com/reterminal_e10xx_main_page/
 */

#include <Seeed_GFX.h>
#include <font/GFXFF/FreeSans18pt7b.h>
#include <font/GFXFF/FreeSansBold24pt7b.h>

Seeed_GFX display(Seeed_Product::reTerminal_E1002);

void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println("[gfx2] begin");
    if (!display.begin()) {
        Serial.println(display.lastResult().message);
        return;
    }

    // Pre-clear: force physical white refresh to erase previous image
    display.fillScreen(TFT_WHITE);
    uint32_t tc = millis();
    const GfxResult clearResult = display.refresh();
    Serial.printf("[gfx2] pre-clear refresh: %lu ms ok=%d %s\n", (unsigned long)(millis() - tc), clearResult.ok(), clearResult.message ? clearResult.message : "");
    delay(500);
    display.fillScreen(TFT_WHITE);
    display.fillRect(0, 0, display.width(), 92, TFT_BLACK);
    display.setTextDatum(MC_DATUM);
    display.setTextColor(TFT_WHITE);
    display.setFreeFont(&FreeSansBold24pt7b);
    display.setTextSize(1);
    display.drawString("reTerminal E1002", display.width() / 2, 46);
    display.fillRoundRect(60, 140, 200, 220, 20, TFT_RED);
    display.fillRoundRect(300, 140, 200, 220, 20, TFT_YELLOW);
    display.fillRoundRect(540, 140, 200, 220, 20, TFT_BLUE);
    display.setTextColor(TFT_BLACK);
    display.setFreeFont(&FreeSans18pt7b);
    display.drawString("7.3 inch Spectra 6", display.width() / 2, 420);
    display.setFreeFont(nullptr);
    display.setTextSize(1);
    display.setTextDatum(TL_DATUM);
    uint32_t t0 = millis();
    const GfxResult refreshResult = display.refresh();
    Serial.printf("[gfx2] final refresh: %lu ms ok=%d\n", (unsigned long)(millis() - t0), refreshResult.ok());
    if (!refreshResult.ok()) {
        Serial.println(refreshResult.message);
    }
}

void loop() { delay(1000); }
