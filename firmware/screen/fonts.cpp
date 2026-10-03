#include "fonts.h"
#include <LittleFS.h>
#include <list>
#include "OpenFontRender.h"
#include "display.h"

// FreeType透過這組函式從內建Flash(LittleFS)按需讀字型檔(取代OpenFontRender內建的M5Stack_SD_Preset)
// 字型不放TF卡：TF卡跟螢幕共用SPI，FreeType的隨機讀取容易出錯，一出錯整張卡都讀不到
// read()可能只回傳部分資料，這裡迴圈讀滿
// 記住路徑與位置，萬一讀取出錯就重新開檔跳回原位再讀
struct FontFile {
  File file;
  String path;
  size_t pos = 0;
  size_t size = 0;
};
static std::list<FontFile> ofrFiles;
static uint32_t readRetries = 0;

FT_FILE *OFR_fopen(const char *filename, const char *mode) {
  File f = LittleFS.open(filename, FILE_READ);
  if (!f) return nullptr;
  ofrFiles.push_back({f, String(filename), 0, f.size()});
  return &ofrFiles.back();
}

void OFR_fclose(FT_FILE *stream) {
  FontFile *ff = (FontFile *)stream;
  ff->file.close();
  ofrFiles.remove_if([ff](FontFile &x) { return &x == ff; });
}

static bool reopenAt(FontFile *ff) {
  ff->file.close();
  delay(5);
  ff->file = LittleFS.open(ff->path, FILE_READ);
  return ff->file && ff->file.seek(ff->pos);
}

size_t OFR_fread(void *ptr, size_t size, size_t nmemb, FT_FILE *stream) {
  FontFile *ff = (FontFile *)stream;
  size_t want = size * nmemb;
  if (ff->pos + want > ff->size) want = ff->size > ff->pos ? ff->size - ff->pos : 0;
  size_t got = 0;
  int retries = 5;
  while (got < want) {
    // 每次最多讀4KB：單次讀幾十KB比較容易出錯
    int n = ff->file.read((uint8_t *)ptr + got, min(want - got, (size_t)4096));
    if (n > 0) {
      got += n;
      ff->pos += n;
      continue;
    }
    readRetries++;
    Serial.printf("[font] read error %s at %u, retry\n", ff->path.c_str(), (unsigned)ff->pos);
    if (--retries <= 0 || !reopenAt(ff)) break;
  }
  return size ? got / size : 0;
}

int OFR_fseek(FT_FILE *stream, long int offset, int whence) {
  FontFile *ff = (FontFile *)stream;
  long target = whence == SEEK_SET ? offset : whence == SEEK_CUR ? (long)ff->pos + offset : (long)ff->size + offset;
  if (target < 0) return -1;
  ff->pos = target;
  if (ff->file.seek(ff->pos)) return 0;
  return reopenAt(ff) ? 0 : -1;
}

long int OFR_ftell(FT_FILE *stream) {
  return ((FontFile *)stream)->pos;
}

static const char *kRegularPath = "/fonts/NotoSansTC-Regular.ttf";
static const char *kBoldPath = "/fonts/NotoSansTC-Bold.ttf";

static OpenFontRender ofrRegular;
static OpenFontRender ofrBold;
static bool loaded = false;

// 目前這一次textDraw的字色(電子紙的調色盤編號，不是RGB)，給二值化畫點用
static uint16_t curFg = TFT_BLACK;

// 電子紙的色號不是RGB，不能交給渲染器去混色。渲染器一律用「白字(0xFFFF)疊黑底(0x0000)」計算，
// 混出來的亮度就是字形的覆蓋率：超過約45%才畫成目標色，其餘不畫(保留原本的底色)
static void plot(int32_t x, int32_t y, uint16_t c) {
  int lum = ((c >> 11) & 0x1F) * 2 + ((c >> 5) & 0x3F) + (c & 0x1F) * 2; // 最大 187
  // 白字畫在深色底上，筆畫在視覺上會比實際細(光暈效應)，門檻放低一點讓字更紮實
  int threshold = curFg == TFT_WHITE ? 58 : 82;
  if (lum >= threshold) epaper.drawPixel(x, y, curFg);
}

// 完全不透明的連續像素渲染器會改走橫線快速路徑，顏色同樣是假的0xFFFF，要換成目標色號，否則會畫成黑色
static void plotHLine(int32_t x, int32_t y, int32_t w, uint16_t c) {
  epaper.drawFastHLine(x, y, w, curFg);
}

static bool loadOne(OpenFontRender &ofr, const char *path) {
  if (!LittleFS.exists(path)) {
    Serial.printf("[font] missing %s\n", path);
    return false;
  }
  ofr.setDrawer(static_cast<TFT_eSPI &>(epaper));
  ofr.set_drawPixel(plot);
  ofr.set_drawFastHLine(plotHLine);
  ofr.setCacheSize(1, 8, 48 * 1024); // 字形快取放PSRAM綽綽有餘
  FT_Error err = ofr.loadFont(path);
  if (err) {
    Serial.printf("[font] load %s failed err=%d\n", path, err);
    return false;
  }
  return true;
}

bool fontsLoad() {
  if (loaded) return true;
  uint32_t t0 = millis();
  bool okR = loadOne(ofrRegular, kRegularPath);
  bool okB = loadOne(ofrBold, kBoldPath);
  loaded = okR && okB;
  Serial.printf("[font] regular=%d bold=%d in %lums\n", okR, okB, millis() - t0);
  return loaded;
}

bool fontsReady() {
  return loaded;
}

static OpenFontRender &pick(FontWeight w) {
  return w == FontWeight::Bold ? ofrBold : ofrRegular;
}

int textWidth(const String &s, int size, FontWeight weight) {
  if (!loaded || s.length() == 0) return 0;
  OpenFontRender &ofr = pick(weight);
  ofr.setFontSize(size);
  return ofr.getTextWidth("%s", s.c_str());
}

// 逐個UTF-8字元往回刪，直到加上「…」後放得下
String textFit(const String &s, int size, FontWeight weight, int maxWidth) {
  if (maxWidth <= 0 || textWidth(s, size, weight) <= maxWidth) return s;
  String cut = s;
  while (cut.length() > 0) {
    int i = cut.length() - 1;
    while (i > 0 && (cut[i] & 0xC0) == 0x80) i--; // 退到這個UTF-8字元的第一個byte
    cut.remove(i);
    String candidate = cut + "…";
    if (textWidth(candidate, size, weight) <= maxWidth) return candidate;
  }
  return "…";
}

int textDraw(const String &s, int x, int y, int size, uint16_t color, uint16_t bg, FontWeight weight, TextAlign align,
             int maxWidth) {
  if (s.length() == 0) return 0;
  if (!loaded) {
    // 字型還沒載入(例如TF卡沒有字型檔)：退回內建英文字型，至少看得到訊息
    epaper.setTextColor(color, bg);
    epaper.setTextDatum(align == TextAlign::Left ? ML_DATUM : align == TextAlign::Center ? MC_DATUM : MR_DATUM);
    epaper.drawString(s, x, y, 2);
    return epaper.textWidth(s, 2);
  }
  String str = textFit(s, size, weight, maxWidth);
  OpenFontRender &ofr = pick(weight);
  ofr.setFontSize(size);
  curFg = color;
  Align a = align == TextAlign::Left ? Align::MiddleLeft : align == TextAlign::Center ? Align::MiddleCenter : Align::MiddleRight;
  FT_BBox bbox;
  FT_Error err;
  ofr.drawHString(str.c_str(), x, y, 0xFFFF, 0x0000, a, Drawing::Execute, bbox, err);
  return bbox.xMax - bbox.xMin;
}
