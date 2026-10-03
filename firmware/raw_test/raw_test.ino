// 不依賴任何繪圖函式庫的最小螢幕測試：照Seeed_GFX2的Driver_ED2208(GDEP073E01，reTerminal E1002)
// 初始化指令直接用SPI驅動面板，畫6條色帶，每一步記錄BUSY腳位狀態，用來確認面板本身能不能刷新
#include <SPI.h>
#include <Wire.h>

#define PIN_SDA 19
#define PIN_SCL 20
#define PMIC_ADDR 0x6B // 出廠固件會設定一顆充電IC，但實測不在這組I2C上(只有0x44/0x51)，跟螢幕問題無關，保留掃描供參考

#define PIN_CS 10
#define PIN_DC 11
#define PIN_RST 12
#define PIN_BUSY 13
#define PIN_SCK 7
#define PIN_MOSI 9
#define PIN_MISO 8

#define W 800
#define H 480

// 面板原生色碼(每像素4bit，一個byte放2個像素)
const uint8_t C_BLACK = 0x0, C_WHITE = 0x1, C_YELLOW = 0x2, C_RED = 0x3, C_BLUE = 0x5, C_GREEN = 0x6;

SPIClass spi(HSPI);
SPISettings settings(2000000, MSBFIRST, SPI_MODE0); // 官方GxEPD2範例用2MHz

void cmd(uint8_t c) {
  spi.beginTransaction(settings);
  digitalWrite(PIN_DC, LOW);
  digitalWrite(PIN_CS, LOW);
  spi.transfer(c);
  digitalWrite(PIN_CS, HIGH);
  spi.endTransaction();
}

void data(uint8_t d) {
  spi.beginTransaction(settings);
  digitalWrite(PIN_DC, HIGH);
  digitalWrite(PIN_CS, LOW);
  spi.transfer(d);
  digitalWrite(PIN_CS, HIGH);
  spi.endTransaction();
}

void cmdData(uint8_t c, std::initializer_list<uint8_t> d) {
  cmd(c);
  for (uint8_t b : d) data(b);
}

// BUSY低電位=忙，高電位=閒(跟兩版Seeed_GFX一致)
bool waitBusy(const char *step, uint32_t timeoutMs = 60000) {
  uint32_t t0 = millis();
  delay(10);
  while (digitalRead(PIN_BUSY) == LOW) {
    if (millis() - t0 > timeoutMs) {
      Serial.printf("[raw] %-10s BUSY timeout after %lu ms\n", step, millis() - t0);
      return false;
    }
    delay(10);
  }
  Serial.printf("[raw] %-10s done in %lu ms\n", step, millis() - t0);
  return true;
}

void initPanel() {
  pinMode(PIN_CS, OUTPUT);
  pinMode(PIN_DC, OUTPUT);
  pinMode(PIN_RST, OUTPUT);
  pinMode(PIN_BUSY, INPUT);
  digitalWrite(PIN_CS, HIGH);
  spi.begin(PIN_SCK, PIN_MISO, PIN_MOSI, -1);

  Serial.printf("[raw] BUSY before reset = %d\n", digitalRead(PIN_BUSY));
  digitalWrite(PIN_RST, HIGH);
  delay(1);
  digitalWrite(PIN_RST, LOW);
  delay(20);
  digitalWrite(PIN_RST, HIGH);
  delay(10);
  Serial.printf("[raw] BUSY after reset = %d\n", digitalRead(PIN_BUSY));

  cmdData(0xAA, {0x49, 0x55, 0x20, 0x08, 0x09, 0x18}); // CMDH
  cmdData(0x01, {0x3F, 0x00, 0x32, 0x2A, 0x0E, 0x2A}); // PWRR
  cmdData(0x00, {0x5F, 0x69});                         // PSR
  cmdData(0x03, {0x00, 0x54, 0x00, 0x44});             // POFS
  cmdData(0x05, {0x40, 0x1F, 0x1F, 0x2C});             // BTST1
  cmdData(0x06, {0x6F, 0x1F, 0x16, 0x25});             // BTST2
  cmdData(0x08, {0x6F, 0x1F, 0x1F, 0x22});             // BTST3
  cmdData(0x13, {0x00, 0x04});                         // IPC
  cmdData(0x30, {0x02});                               // PLL
  cmdData(0x41, {0x00});                               // TSE
  cmdData(0x50, {0x3F});                               // CDI
  cmdData(0x60, {0x02, 0x00});                         // TCON
  cmdData(0x61, {W >> 8, W & 0xFF, H >> 8, H & 0xFF}); // TRES
  cmdData(0x82, {0x1E});                               // VDCS
  cmdData(0x84, {0x01});                               // T_VDCS
  cmdData(0x86, {0x00});                               // AGID
  cmdData(0xE3, {0x2F});                               // PWS
  cmdData(0xE0, {0x00});                               // CCSET
  cmdData(0xE6, {0x00});                               // TSSET
  cmd(0x04);                                           // PON
  waitBusy("power-on");
}

// 6條直色帶：黑 白 黃 紅 藍 綠
void pushStripes() {
  const uint8_t order[] = {C_BLACK, C_WHITE, C_YELLOW, C_RED, C_BLUE, C_GREEN};
  static uint8_t row[W / 2];
  for (int x = 0; x < W; x += 2) {
    uint8_t c = order[(x * 6) / W];
    row[x / 2] = (c << 4) | c;
  }
  uint32_t t0 = millis();
  cmd(0x10);
  spi.beginTransaction(settings);
  digitalWrite(PIN_DC, HIGH);
  digitalWrite(PIN_CS, LOW);
  for (int y = 0; y < H; y++) spi.writeBytes(row, sizeof(row));
  digitalWrite(PIN_CS, HIGH);
  spi.endTransaction();
  Serial.printf("[raw] data sent in %lu ms\n", millis() - t0);
}

int pmicRead(uint8_t reg) {
  Wire.beginTransmission(PMIC_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom(PMIC_ADDR, 1) != 1) return -1;
  return Wire.read();
}

bool pmicWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(PMIC_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

void dumpPmic(const char *tag) {
  Serial.printf("[pmic] %s:", tag);
  for (uint8_t r = 0; r <= 0x0B; r++) Serial.printf(" %02X=%02X", r, pmicRead(r) & 0xFF);
  Serial.println();
}

// 照出廠固件的log設定：關看門狗(REG05 bit5:4=00)、VINDPM 4100mV(REG06 bit3:0)、輸入上限1000mA(REG00 bit4:0)、充電480mA(REG02 bit5:0)
void setupPmic() {
  Serial.print("[i2c] scan:");
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) Serial.printf(" 0x%02X", a);
  }
  Serial.println();
  if (pmicRead(0x00) < 0) {
    Serial.println("[pmic] not found at 0x6B");
    return;
  }
  dumpPmic("before");
  int r05 = pmicRead(0x05), r06 = pmicRead(0x06), r00 = pmicRead(0x00), r02 = pmicRead(0x02);
  pmicWrite(0x05, r05 & ~0x30);
  pmicWrite(0x06, (r06 & 0xF0) | ((4100 - 3900) / 100));
  pmicWrite(0x00, (r00 & 0xE0) | ((1000 - 100) / 100));
  pmicWrite(0x02, (r02 & 0xC0) | (480 / 60));
  dumpPmic("after ");
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n[raw] start");
  // TF卡跟螢幕共用SPI：卡片的CS沒拉高時會跟著回應匯流排上的資料，干擾螢幕(Seeed論壇確認拔卡即恢復)
  // 開機第一件事：TF卡供電並把CS拉高，讓卡片保持閒置
  pinMode(14, OUTPUT);
  digitalWrite(14, HIGH);
  pinMode(16, OUTPUT);
  digitalWrite(16, HIGH);
  delay(20);
  Wire.begin(PIN_SDA, PIN_SCL);
  setupPmic();
  initPanel();
  pushStripes();
  cmdData(0x12, {0x00}); // 刷新
  delay(1);
  waitBusy("refresh");
  cmdData(0x02, {0x00}); // POF
  delay(1);
  waitBusy("power-off");
  Serial.println("[raw] finished");
}

void loop() {
  delay(1000);
}
