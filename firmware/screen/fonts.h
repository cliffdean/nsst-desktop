// 中文字型：Noto Sans TC(Big5字集裁剪)放在內建Flash的LittleFS /fonts/，OpenFontRender按需讀取，不用整個載入記憶體
// 電子紙只有6色，抗鋸齒的中間色會被就近對應成怪顏色，所以邊緣像素一律二值化：接近字色才畫，否則不畫(背景透明)
#pragma once
#include <Arduino.h>

enum class FontWeight { Regular, Bold };
enum class TextAlign { Left, Center, Right };

bool fontsLoad();
bool fontsReady();

// y是文字垂直中線；maxWidth>0時超出寬度會截斷並加「…」；回傳實際畫出的寬度
int textDraw(const String &s, int x, int y, int size, uint16_t color, uint16_t bg, FontWeight weight = FontWeight::Regular,
             TextAlign align = TextAlign::Left, int maxWidth = 0);
int textWidth(const String &s, int size, FontWeight weight = FontWeight::Regular);
// 截斷到maxWidth以內(含「…」)
String textFit(const String &s, int size, FontWeight weight, int maxWidth);
