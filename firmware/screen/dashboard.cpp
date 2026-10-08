#include "dashboard.h"
#include <vector>
#include "display.h"
#include "fonts.h"

// 版面(800x480)：頂部黑色標題列+三個重點數字、左欄上半工程師/下半待辦、右欄本週追蹤專案、底部狀態列
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
static const int ENG_PER_PAGE = 10; // 工程師超過這個數就分頁
static const int TODO_Y = 316;      // 待辦區起點：BODY_BOTTOM - (標題36 + 4筆*24)，固定位置

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

static void drawHeader(JsonObjectConst root, const DeviceStatus &st) {
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
  int right = SCREEN_W - 14;
  if (updated.length()) {
    String u = "更新 " + updated;
    textDraw(u, right, HEADER_H / 2, 16, TFT_WHITE, TFT_BLACK, FontWeight::Regular, TextAlign::Right);
    right -= textWidth(u, 16) + 16;
  }
  // 省電模式(不保持連線)才有下次同步時間，放在「更新」左側
  if (st.nextSync.length()) textDraw("下次同步 " + st.nextSync, right, HEADER_H / 2, 16, TFT_WHITE, TFT_BLACK, FontWeight::Regular, TextAlign::Right);
}

// 相較上次內容變化的量：變多用該欄的顏色(待處理紅/待審核藍/逾期黑)，變少用綠色；0不畫。回傳佔用寬度(0=沒畫)
// right=false：x是左緣往右畫(寬度超過maxW會被裁)；right=true：x是右緣往左畫
static int deltaTag(int delta, int x, int cy, uint16_t upColor, bool rightAlign = false, int maxW = 0) {
  if (delta == 0) return 0;
  String d = String(delta > 0 ? "+" : "-") + String(abs(delta));
  uint16_t color = delta > 0 ? upColor : TFT_GREEN;
  int w = textWidth(d, 13, FontWeight::Bold);
  textDraw(d, x, cy, 13, color, TFT_WHITE, FontWeight::Bold, rightAlign ? TextAlign::Right : TextAlign::Left, maxW);
  return w;
}

static int deltaWidth(int delta) {
  return delta == 0 ? 0 : textWidth(String(delta > 0 ? "+" : "-") + String(abs(delta)), 13, FontWeight::Bold) + 3;
}

// 專案列的一個「標籤+數字」色塊(由右往左排，px是目前右緣，畫完會往左移)；變化量放在色塊右側
static void metricPill(int &px, int cy, const char *label, int value, int delta, uint16_t bg, uint16_t fg, uint16_t upColor, bool showPill) {
  int g = deltaWidth(delta);
  px -= g;
  deltaTag(delta, px + 3, cy, upColor);
  if (showPill) {
    px -= pillWidth(label, String(value), 14, 16);
    pill(px, cy, 24, label, String(value), bg, fg, 14, 16);
  }
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

// 左欄上半：工程師，單欄一人一列(名字+待處理+待審核+逾期數量，逾期用黃底色塊)。
// 工程師最多約10位，所以待辦區固定貼在左欄底部(TODO_Y)，不隨工程師人數上下移動
static void drawEngineers(JsonArrayConst engineers, int page) {
  int total = engineers.size();
  int pages = enginePages(engineers);
  textDraw(pages > 1 ? "工程師 " + String(min(page, pages - 1) + 1) + "/" + String(pages) : String("工程師"), LEFT_X, 72, 18, TFT_BLACK, TFT_WHITE,
           FontWeight::Bold);
  legend(LEFT_R, 72);

  const int top = 90;
  if (total == 0) {
    textDraw("沒有工程師資料", LEFT_X, 110, 16, TFT_BLACK, TFT_WHITE);
    return;
  }
  int first = pages > 1 ? page * ENG_PER_PAGE : 0;
  int n = pages > 1 ? min(ENG_PER_PAGE, total - first) : total;
  // 人少時列高放寬一點(上限30)，滿10位時剛好填滿 top ~ TODO_Y 之間
  int rowH = constrain((TODO_Y - 4 - top) / max(n, 1), 22, 30);
  const int nameW = 76;              // 名字欄(4個中文字寬)，有逾期的名字底色用黃色
  const int todoR = LEFT_X + 118;    // 待處理數字右緣
  const int reviewR = LEFT_X + 178;  // 待審核數字右緣
  const int overdueX = LEFT_X + 220; // 逾期色塊左緣，跟待審核數字之間留足間距

  for (int i = 0; i < n; i++) {
    JsonObjectConst e = engineers[first + i];
    int todo = e["todo"] | 0;
    int review = e["review"] | 0;
    int overdue = e["overdue"] | 0;
    int cy = top + rowH * i + rowH / 2;

    if (overdue > 0) epaper.fillRoundRect(LEFT_X - 4, cy - rowH / 2 + 1, nameW + 8, rowH - 2, 4, TFT_YELLOW);
    textDraw(e["name"] | "", LEFT_X, cy, 17, TFT_BLACK, overdue > 0 ? TFT_YELLOW : TFT_WHITE, FontWeight::Regular, TextAlign::Left, nameW);
    count(todo, todoR, cy, 18, TFT_RED);
    count(review, reviewR, cy, 18, TFT_BLUE);
    // 三個數字相較上次內容的變化量，緊貼在各自數字右側：待處理夾在待處理與待審核數字之間(空間較窄)，待審核在逾期色塊左側
    deltaTag(e["todo_delta"] | 0, todoR + 4, cy, TFT_RED, false, reviewR - todoR - 28);
    deltaTag(e["review_delta"] | 0, reviewR + 4, cy, TFT_BLUE, false, overdueX - reviewR - 6);
    // 逾期數量：黃底小色塊，沒有逾期就留白
    if (overdue > 0) {
      String o = String(overdue);
      int w = max(26, textWidth(o, 15, FontWeight::Bold) + 14);
      epaper.fillRoundRect(overdueX, cy - 10, w, 20, 4, TFT_YELLOW);
      textDraw(o, overdueX + w / 2, cy, 15, TFT_BLACK, TFT_YELLOW, FontWeight::Bold, TextAlign::Center);
      deltaTag(e["overdue_delta"] | 0, overdueX + w + 4, cy, TFT_BLACK);
    } else {
      deltaTag(e["overdue_delta"] | 0, overdueX, cy, TFT_BLACK); // 逾期清零了：色塊消失，只留下 -N 讓人知道是清掉的
    }
  }
}

// 左欄下半：待辦事項(桌面工具的待辦，置頂的排前面)；從y開始往下畫到 BODY_BOTTOM，放不下的以「還有N項」收尾
static void drawTodos(JsonArrayConst todos, int y) {
  dottedHLine(LEFT_X, LEFT_R, y + 4);
  int total = todos.size();
  textDraw("待辦事項", LEFT_X, y + 20, 18, TFT_BLACK, TFT_WHITE, FontWeight::Bold);
  if (total > 0) textDraw(String(total) + " 項", LEFT_R, y + 20, 14, TFT_BLACK, TFT_WHITE, FontWeight::Regular, TextAlign::Right);

  const int rowH = 24;
  int itemsTop = y + 36;
  if (total == 0) {
    textDraw("目前沒有待辦事項", LEFT_X, itemsTop + rowH / 2, 16, TFT_BLACK, TFT_WHITE);
    return;
  }
  int fit = (BODY_BOTTOM - itemsTop) / rowH;
  if (fit <= 0) return;
  int shown = total <= fit ? total : fit - 1; // 放不下時最後一行留給「還有N項」
  for (int i = 0; i < shown; i++) {
    JsonObjectConst t = todos[i];
    int cy = itemsTop + rowH * i + rowH / 2;
    bool overdue = t["overdue"] | false;
    // 前面的小方塊：置頂=紅色實心，其餘=空心框
    if (t["pinned"] | false) epaper.fillRect(LEFT_X, cy - 5, 10, 10, TFT_RED);
    else epaper.drawRect(LEFT_X, cy - 5, 10, 10, TFT_BLACK);
    String remind = t["remind"] | "";
    int remindW = remind.length() ? textWidth(remind, 13) + 6 : 0;
    textDraw(t["title"] | "", LEFT_X + 18, cy, 16, TFT_BLACK, TFT_WHITE, FontWeight::Regular, TextAlign::Left, LEFT_R - LEFT_X - 18 - remindW);
    if (remind.length()) textDraw(remind, LEFT_R, cy, 13, overdue ? TFT_RED : TFT_BLACK, TFT_WHITE, overdue ? FontWeight::Bold : FontWeight::Regular, TextAlign::Right);
  }
  if (shown < total) {
    textDraw("…還有 " + String(total - shown) + " 項", LEFT_X, itemsTop + rowH * shown + rowH / 2, 14, TFT_BLACK, TFT_WHITE);
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
      // 由右往左：審、待、逾。每個色塊右側放它的變化量(相較上次內容)，逾期清零了色塊消失但仍留下 -N
      metricPill(px, cy, "審", review, p["review_delta"] | 0, review ? TFT_BLUE : TFT_WHITE, review ? TFT_WHITE : TFT_BLACK, TFT_BLUE, true);
      px -= 6;
      metricPill(px, cy, "待", todo, p["todo_delta"] | 0, todo ? TFT_RED : TFT_WHITE, todo ? TFT_WHITE : TFT_BLACK, TFT_RED, true);
      px -= 6;
      metricPill(px, cy, "逾", overdue, p["overdue_delta"] | 0, TFT_YELLOW, TFT_BLACK, TFT_BLACK, overdue > 0);
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
  drawHeader(root, status);
  epaper.drawFastVLine(DIVIDER_X, BODY_TOP, BODY_BOTTOM - BODY_TOP, TFT_BLACK);
  drawEngineers(root["engineers"], page);
  drawTodos(root["todos"], TODO_Y);
  drawProjects(root["projects"], page, pages);
  drawFooter(status, page, pages);
  return pages;
}
