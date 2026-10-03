#include "dashboard.h"
#include <vector>
#include "display.h"
#include "fonts.h"

// 版面(800x480)：頂部黑色標題列+三個重點數字、左欄工程師、右欄本週追蹤專案、底部狀態列
// 配色原則(電子紙只有6色)：紅=待處理(要動手)、藍=待審核、黃底=逾期警示、綠=已清空，其餘黑白
static const int HEADER_H = 50;
static const int BODY_TOP = 58;
static const int BODY_BOTTOM = 448;
static const int FOOTER_Y = 452;
static const int LEFT_X = 12;
static const int LEFT_R = 316;
static const int DIVIDER_X = 326;
static const int RIGHT_X = 338;
static const int RIGHT_R = 788;
static const int ENG_PER_PAGE = 14; // 工程師超過這個數就分頁

// 圓角色塊：label一般字、value粗體；x為左上角，回傳寬度
static int pill(int x, int cy, int h, const String &label, const String &value, uint16_t bg, uint16_t fg, int labelSize,
                int valueSize) {
  int pad = 8;
  int lw = label.length() ? textWidth(label, labelSize) : 0;
  int vw = textWidth(value, valueSize, FontWeight::Bold);
  int gap = (lw && vw) ? 5 : 0;
  int w = pad * 2 + lw + gap + vw;
  epaper.fillRoundRect(x, cy - h / 2, w, h, 6, bg);
  if (lw) textDraw(label, x + pad, cy, labelSize, fg, bg);
  textDraw(value, x + pad + lw + gap, cy, valueSize, fg, bg, FontWeight::Bold);
  return w;
}

static int pillWidth(const String &label, const String &value, int labelSize, int valueSize) {
  int lw = label.length() ? textWidth(label, labelSize) : 0;
  int vw = textWidth(value, valueSize, FontWeight::Bold);
  return 16 + lw + ((lw && vw) ? 5 : 0) + vw;
}

static void dottedHLine(int x0, int x1, int y) {
  for (int x = x0; x <= x1; x += 4) epaper.drawFastHLine(x, y, 2, TFT_BLACK);
}

static void drawHeader(JsonObjectConst root) {
  epaper.fillRect(0, 0, SCREEN_W, HEADER_H, TFT_BLACK);
  String title = root["title"] | "工單看板";
  int x = 14;
  x += textDraw(title, x, HEADER_H / 2, 24, TFT_WHITE, TFT_BLACK, FontWeight::Bold) + 20;

  JsonObjectConst totals = root["totals"];
  int todo = totals["todo"] | 0;
  int review = totals["review"] | 0;
  int overdue = totals["overdue"] | 0;
  x += pill(x, HEADER_H / 2, 36, "待處理", String(todo), TFT_RED, TFT_WHITE, 16, 24) + 10;
  x += pill(x, HEADER_H / 2, 36, "待審核", String(review), TFT_BLUE, TFT_WHITE, 16, 24) + 10;
  if (overdue > 0) pill(x, HEADER_H / 2, 36, "逾期", String(overdue), TFT_YELLOW, TFT_BLACK, 16, 24);

  String updated = root["updated_at"] | "";
  if (updated.length()) textDraw("更新 " + updated, SCREEN_W - 14, HEADER_H / 2, 16, TFT_WHITE, TFT_BLACK, FontWeight::Regular, TextAlign::Right);
}

static void legend(int right, int cy) {
  int x = right;
  x -= textWidth("待審核", 14);
  textDraw("待審核", x, cy, 14, TFT_BLACK, TFT_WHITE);
  x -= 14;
  epaper.fillRect(x, cy - 5, 10, 10, TFT_BLUE);
  x -= 10 + textWidth("待處理", 14);
  textDraw("待處理", x, cy, 14, TFT_BLACK, TFT_WHITE);
  x -= 14;
  epaper.fillRect(x, cy - 5, 10, 10, TFT_RED);
}

// 數字：非0用粗體彩色強調，0用黑色一般字淡化
static void count(int value, int right, int cy, int size, uint16_t color) {
  if (value > 0) textDraw(String(value), right, cy, size, color, TFT_WHITE, FontWeight::Bold, TextAlign::Right);
  else textDraw("0", right, cy, size, TFT_BLACK, TFT_WHITE, FontWeight::Regular, TextAlign::Right);
}

static int enginePages(JsonArrayConst engineers) {
  return max(1, ((int)engineers.size() + ENG_PER_PAGE - 1) / ENG_PER_PAGE);
}

static void drawEngineers(JsonArrayConst engineers, int page) {
  int total = engineers.size();
  int pages = enginePages(engineers);
  textDraw(pages > 1 ? "工程師 " + String(min(page, pages - 1) + 1) + "/" + String(pages) : String("工程師"), LEFT_X, 72, 18, TFT_BLACK, TFT_WHITE,
           FontWeight::Bold);
  legend(LEFT_R, 72);

  if (total == 0) {
    textDraw("沒有工程師資料", LEFT_X, 110, 16, TFT_BLACK, TFT_WHITE);
    return;
  }
  int maxLoad = 1;
  for (JsonObjectConst e : engineers) maxLoad = max(maxLoad, (int)(e["todo"] | 0) + (int)(e["review"] | 0));

  // 超過一頁時每頁固定 ENG_PER_PAGE 位；這一頁沒有工程師(專案頁比較多)就留白
  int first = pages > 1 ? page * ENG_PER_PAGE : 0;
  int n = pages > 1 ? min(ENG_PER_PAGE, total - first) : total;
  if (n <= 0) return;
  const int top = 90;
  int rowH = constrain((BODY_BOTTOM - top) / (pages > 1 ? ENG_PER_PAGE : n), 22, 36);
  int nameSize = rowH >= 30 ? 18 : 16;
  int numSize = rowH >= 30 ? 20 : 17;
  const int nameW = 70;
  const int barX = LEFT_X + nameW + 6;
  const int barMaxW = 100;
  const int overdueX = barX + barMaxW + 8; // 「逾」色塊固定一欄，上下對齊
  int shown = min(n, (BODY_BOTTOM - top) / rowH);

  for (int i = 0; i < shown; i++) {
    JsonObjectConst e = engineers[first + i];
    int todo = e["todo"] | 0;
    int review = e["review"] | 0;
    int overdue = e["overdue"] | 0;
    int cy = top + rowH * i + rowH / 2;

    if (overdue > 0) epaper.fillRoundRect(LEFT_X - 4, cy - rowH / 2 + 2, nameW + 6, rowH - 4, 4, TFT_YELLOW);
    textDraw(e["name"] | "", LEFT_X, cy, nameSize, TFT_BLACK, overdue > 0 ? TFT_YELLOW : TFT_WHITE, FontWeight::Regular,
             TextAlign::Left, nameW);

    int barH = rowH >= 30 ? 14 : 10;
    int tw = todo * barMaxW / maxLoad;
    int rw = review * barMaxW / maxLoad;
    if (tw) epaper.fillRect(barX, cy - barH / 2, tw, barH, TFT_RED);
    if (rw) epaper.fillRect(barX + tw, cy - barH / 2, rw, barH, TFT_BLUE);
    if (overdue > 0) {
      pill(overdueX, cy, barH + 8, "逾", String(overdue), TFT_YELLOW, TFT_BLACK, 13, 14);
    }

    count(todo, LEFT_R - 40, cy, numSize, TFT_RED);
    count(review, LEFT_R, cy, numSize, TFT_BLUE);
  }
}

// 流程階段一格：「裝機 1/2」，名稱黑字、待處理紅字、待審核藍字；回傳寬度(measureOnly時不畫)
static int stageChip(JsonObjectConst s, int x, int cy, bool measureOnly) {
  const int size = 15;
  String name = s["name"] | "";
  String todo = String((int)(s["todo"] | 0));
  String review = String((int)(s["review"] | 0));
  int w1 = textWidth(name, size);
  int w2 = textWidth(todo, size, FontWeight::Bold);
  int w3 = textWidth("/", size);
  int w4 = textWidth(review, size, FontWeight::Bold);
  int w = w1 + 4 + w2 + 1 + w3 + 1 + w4;
  if (measureOnly) return w;
  int px = x;
  textDraw(name, px, cy, size, TFT_BLACK, TFT_WHITE);
  px += w1 + 4;
  textDraw(todo, px, cy, size, (s["todo"] | 0) > 0 ? TFT_RED : TFT_BLACK, TFT_WHITE, FontWeight::Bold);
  px += w2 + 1;
  textDraw("/", px, cy, size, TFT_BLACK, TFT_WHITE);
  px += w3 + 1;
  textDraw(review, px, cy, size, (s["review"] | 0) > 0 ? TFT_BLUE : TFT_BLACK, TFT_WHITE, FontWeight::Bold);
  return w;
}

// 一個專案佔幾行流程(只量不畫)
static int stageLines(JsonArrayConst stages) {
  if (stages.size() == 0) return 0;
  int lines = 1;
  int x = RIGHT_X + 8;
  for (JsonObjectConst s : stages) {
    int w = stageChip(s, 0, 0, true);
    if (x + w > RIGHT_R && x > RIGHT_X + 8) {
      lines++;
      x = RIGHT_X + 8;
    }
    x += w + 16;
  }
  return lines;
}

static const int PROJECT_LINE_H = 22;
static const int PROJECT_TOP = 86;

static int projectCardHeight(JsonObjectConst p) {
  return 30 + stageLines(p["stages"]) * PROJECT_LINE_H + 6;
}

// 把專案依各自的高度裝滿一頁，回傳每一頁第一個專案的索引(最後多放一個結尾索引=專案總數)
static std::vector<int> paginateProjects(JsonArrayConst projects) {
  std::vector<int> starts;
  int y = PROJECT_TOP;
  int idx = 0;
  for (JsonObjectConst p : projects) {
    int h = projectCardHeight(p);
    if (starts.empty() || y + h > BODY_BOTTOM) { // 這個放不下就換頁(一頁至少放一個，再高也放)
      if (!starts.empty()) y = PROJECT_TOP;
      starts.push_back(idx);
    }
    y += h;
    idx++;
  }
  starts.push_back(idx);
  return starts;
}

static int projectPages(JsonArrayConst projects) {
  if (projects.size() == 0) return 1;
  return (int)paginateProjects(projects).size() - 1;
}

static void drawProjects(JsonArrayConst projects, int page, int totalPages) {
  textDraw("★ 本週追蹤專案", RIGHT_X, 72, 18, TFT_BLACK, TFT_WHITE, FontWeight::Bold);
  int n = projects.size();
  if (n == 0) {
    textDraw("尚未加星任何專案", RIGHT_X, 120, 18, TFT_BLACK, TFT_WHITE);
    textDraw("在桌面工具的「專案查詢」加星，就會出現在這裡", RIGHT_X, 150, 15, TFT_BLACK, TFT_WHITE);
    return;
  }
  std::vector<int> starts = paginateProjects(projects);
  int pages = (int)starts.size() - 1;
  String countText = totalPages > 1 ? "第 " + String(page + 1) + "/" + String(totalPages) + " 頁・共 " + String(n) + " 個" : "共 " + String(n) + " 個";
  textDraw(countText, RIGHT_R, 72, 14, TFT_BLACK, TFT_WHITE, FontWeight::Regular, TextAlign::Right);
  if (page >= pages) { // 工程師頁數比專案多：這一頁沒有專案
    textDraw("(沒有更多專案了)", RIGHT_X, 120, 16, TFT_BLACK, TFT_WHITE);
    return;
  }

  const int lineH = PROJECT_LINE_H;
  int y = PROJECT_TOP;
  int drawn = starts[page];
  int endIdx = starts[page + 1];
  for (int pi = starts[page]; pi < endIdx; pi++) {
    JsonObjectConst p = projects[pi];
    JsonArrayConst stages = p["stages"];
    int lines = stageLines(stages);
    int cardH = 30 + lines * lineH + 6;

    int todo = p["todo"] | 0;
    int review = p["review"] | 0;
    int overdue = p["overdue"] | 0;
    int cy = y + 14;

    // 右側重點數字(由右往左排)
    int px = RIGHT_R;
    if (todo + review == 0) {
      px -= pillWidth("", "✓ 已清空", 14, 15);
      pill(px, cy, 24, "", "✓ 已清空", TFT_GREEN, TFT_WHITE, 14, 15);
    } else {
      px -= pillWidth("審", String(review), 14, 16);
      pill(px, cy, 24, "審", String(review), review ? TFT_BLUE : TFT_WHITE, review ? TFT_WHITE : TFT_BLACK, 14, 16);
      px -= 6 + pillWidth("待", String(todo), 14, 16);
      pill(px, cy, 24, "待", String(todo), todo ? TFT_RED : TFT_WHITE, todo ? TFT_WHITE : TFT_BLACK, 14, 16);
      if (overdue > 0) {
        px -= 6 + pillWidth("逾", String(overdue), 14, 16);
        pill(px, cy, 24, "逾", String(overdue), TFT_YELLOW, TFT_BLACK, 14, 16);
      }
    }
    textDraw(p["name"] | "", RIGHT_X, cy, 18, TFT_BLACK, TFT_WHITE, FontWeight::Bold, TextAlign::Left, px - RIGHT_X - 10);

    int sx = RIGHT_X + 8;
    int sy = y + 30 + lineH / 2;
    for (JsonObjectConst s : stages) {
      int w = stageChip(s, 0, 0, true);
      if (sx + w > RIGHT_R && sx > RIGHT_X + 8) {
        sx = RIGHT_X + 8;
        sy += lineH;
      }
      stageChip(s, sx, sy, false);
      sx += w + 16;
    }

    y += cardH;
    drawn++;
    if (drawn < endIdx) dottedHLine(RIGHT_X, RIGHT_R, y - 3);
  }
}

static void drawFooter(const DeviceStatus &st, int page = 0, int pages = 1) {
  epaper.drawFastHLine(0, FOOTER_Y, SCREEN_W, TFT_BLACK);
  int cy = FOOTER_Y + 14;
  String left;
  if (st.batteryPct >= 0) left += "電量 " + String(st.batteryPct) + "%";
  if (!isnan(st.temperature)) left += (left.length() ? "　" : "") + String(st.temperature, 1) + "°C";
  if (!isnan(st.humidity)) left += String(left.length() ? "　" : "") + "濕度 " + String((int)lroundf(st.humidity)) + "%";
  textDraw(left, 12, cy, 14, st.batteryPct >= 0 && st.batteryPct < 20 ? TFT_RED : TFT_BLACK, TFT_WHITE);
  String center = st.note;
  if (pages > 1) center += String(center.length() ? "　" : "") + "短按綠鍵翻頁 " + String(page + 1) + "/" + String(pages);
  if (center.length()) textDraw(center, SCREEN_W / 2, cy, 14, TFT_BLACK, TFT_WHITE, FontWeight::Regular, TextAlign::Center, 420);
  if (st.ip.length()) textDraw("IP " + st.ip, SCREEN_W - 12, cy, 14, TFT_BLACK, TFT_WHITE, FontWeight::Regular, TextAlign::Right);
  else if (st.nextSync.length()) textDraw("下次同步 " + st.nextSync, SCREEN_W - 12, cy, 14, TFT_BLACK, TFT_WHITE, FontWeight::Regular, TextAlign::Right);
}

static void drawWaiting(const DeviceStatus &st) {
  epaper.fillRect(0, 0, SCREEN_W, HEADER_H, TFT_BLACK);
  textDraw("工單看板", 14, HEADER_H / 2, 24, TFT_WHITE, TFT_BLACK, FontWeight::Bold);
  textDraw("等待桌面工具推送資料", SCREEN_W / 2, 200, 32, TFT_BLACK, TFT_WHITE, FontWeight::Bold, TextAlign::Center);
  textDraw("TF卡上還沒有 /db/dashboard.json", SCREEN_W / 2, 250, 18, TFT_BLACK, TFT_WHITE, FontWeight::Regular, TextAlign::Center);
  drawFooter(st);
}

int dashboardPageCount(const JsonDocument &doc) {
  JsonObjectConst root = doc.as<JsonObjectConst>();
  return max(enginePages(root["engineers"]), projectPages(root["projects"]));
}

int dashboardRender(const JsonDocument *doc, const DeviceStatus &status, int page) {
  epaper.fillScreen(TFT_WHITE);
  if (!doc) {
    drawWaiting(status);
    return 1;
  }
  JsonObjectConst root = doc->as<JsonObjectConst>();
  int pages = max(enginePages(root["engineers"]), projectPages(root["projects"]));
  page = constrain(page, 0, pages - 1);
  drawHeader(root);
  epaper.drawFastVLine(DIVIDER_X, BODY_TOP, BODY_BOTTOM - BODY_TOP, TFT_BLACK);
  drawEngineers(root["engineers"], page);
  drawProjects(root["projects"], page, pages);
  drawFooter(status, page, pages);
  return pages;
}
