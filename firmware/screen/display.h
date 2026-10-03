// 全域螢幕物件(Seeed_GFX的EPaper是800x480的記憶體畫布，update()才會送到面板，整頁刷新約33秒)
#pragma once
#include "TFT_eSPI.h"

extern EPaper epaper;

#define SCREEN_W 800
#define SCREEN_H 480

// 第一次要畫之前呼叫(初始化面板)；重複呼叫無妨
void displayBegin();

// 把畫布送到面板並刷新(約33秒)，刷完讓面板斷電
void displayFlush();
