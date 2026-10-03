# nsst-desktop

EIP 工單桌面小工具：常駐系統匣、快捷鍵喚出、本地計時、Git 整合、LLM 產生工單回覆與 commit 訊息。
另含電子紙看板(reTerminal E1002)的自製固件，看板數據由桌面工具提供，跟 EIP 後端無關。

```
nsst-desktop/
├─ src/          桌面工具(Electron)：main 主程序、renderer 畫面、preload
├─ scripts/      啟動腳本
├─ firmware/     電子紙看板固件(Arduino)
│  ├─ screen/    **看板正式固件**(儀表板、MQTT、電源模式、設定模式)，見第三節
│  ├─ fonts/     中文字型(Noto Sans TC 裁剪版，make_fonts.py 產生，.ttf 不進 git)
│  ├─ hw_test/   硬體測試：按鍵、TF卡、電池、溫濕度、WiFi、刷新時間、深度睡眠喚醒(用 Seeed_GFX)
│  ├─ raw_test/  不靠繪圖函式庫、直接用 SPI 驅動面板畫 6 色色帶，排查螢幕問題用
│  ├─ hello/     Seeed_GFX 官方 HelloWorld(未處理 TF 卡 CS，插卡時畫面不會變)
│  ├─ hello2/    Seeed_GFX2 官方 HelloWorld(需 ESP32 Core 3.3 以上才能編譯，目前未用)
│  ├─ gxepd2_test/ 官方開源倉庫的 GxEPD2 範例(同樣未處理 TF 卡)
│  ├─ backup/    出廠固件備份(不進 git)
│  └─ *.ps1      PowerShell 腳本：setup-env(建環境)、sketch(測試 sketch)、upload-fonts(傳字型)、backup-factory / restore-factory(備份/還原)；screen/flash.ps1(屏幕固件編譯燒錄)
└─ start-hidden.bat  背景啟動桌面工具(不開終端機視窗)
```

架構：`EIP 後端 --(既有API)--> 桌面工具 --(區網)--> 電子紙看板`。
後端只負責提供 EIP 數據給桌面工具，桌面工具與看板之間的同步都在本機/區網完成。

---

## 一、桌面工具

需求：Node.js(目前用 v25)

```powershell
npm install
npm start               # 開發時用；VSCode 終端機會帶 ELECTRON_RUN_AS_NODE，scripts/start.js 已處理
.\start-hidden.bat      # 平常使用：背景啟動，輸出寫到 start-out.log / start-err.log
```

第一次啟動後到「設定」填 EIP API 網址，用 EIP 帳密登入取得 Token。

---

## 二、電子紙看板固件開發環境

### 硬體

| 項目 | 規格 |
|---|---|
| 裝置 | Seeed reTerminal E1002 |
| 螢幕 | 7.3 吋 E Ink Spectra 6 全彩，800×480，只能顯示 6 色：白、黑、紅、黃、綠、藍(`TFT_WHITE` / `TFT_BLACK` / `TFT_RED` / `TFT_YELLOW` / `TFT_GREEN` / `TFT_BLUE`)，其他顏色會被就近對應 |
| 主控 | ESP32-S3(QFN56 rev v0.2)，PSRAM 8MB(OPI)，Flash 實測 **32MB** |
| USB | CH340/CH341 USB 轉序列，Windows 上目前是 **COM23**(換 USB 孔可能會變) |
| MAC | 44:bd:8d:ec:23:7c |
| 其他 | 2000mAh 電池、3 顆按鍵、蜂鳴器、LED、電源開關、溫濕度感測器、RTC、TF 卡槽(目前插 32GB SDHC) |
| 刷新 | 整頁刷新實測約 **33 秒**(出廠固件也一樣)，刷新時會閃好幾次，沒有局部刷新 |

腳位(已在 hw_test 實測)：

| 功能 | GPIO | 備註 |
|---|---|---|
| 螢幕 SPI | SCK 7、MOSI 9、CS 10、DC 11、RST 12、BUSY 13 | BUSY 低=忙、高=閒 |
| TF 卡 | 跟螢幕共用 SCK 7 / MOSI 9，MISO 8、CS 14、偵測 15(低=有卡)、供電 16(高=開) | 見下方「必要設定」第 1 點 |
| 按鍵 | 右(綠) 3、中(白) 4、左(白) 5 | 低電位=按下，三顆都能從深度睡眠喚醒(ext1) |
| LED / 蜂鳴器 | LED 6(低=亮)、蜂鳴器 45 | |
| 電池電壓 | ADC 1，量測致能 21 | 分壓 1:1，實際電壓 = 讀值 × 2 |
| I2C | SDA 19、SCL 20 | 0x44 溫濕度 SHT4x、0x51 RTC PCF8563 |
| Debug Serial | TX 43、RX 44(經 CH340 到 COM23) | 115200 |

### 工具與路徑

| 工具 | 版本 | 位置 |
|---|---|---|
| arduino-cli | 1.5.1 | `D:\MyTools\tools\arduino-cli\arduino-cli.exe` |
| ESP32 Arduino Core | 3.1.1 | `%LOCALAPPDATA%\Arduino15\packages\esp32`(跟 Arduino IDE 共用) |
| esptool | 隨 ESP32 Core | `%LOCALAPPDATA%\Arduino15\packages\esp32\tools\esptool_py\<版本>\esptool.exe` |
| Seeed_GFX | 2.0.3 | `D:\我的\文件\Arduino\libraries\Seeed_GFX`(從 GitHub `Seeed-Studio/Seeed_GFX` clone)，**目前使用** |
| Seeed_GFX2 | 1.0.0 | 同上資料夾，新一代函式庫；需要 ESP32 Core 3.3 以上，目前 Core 3.1.1 編譯不過，暫不使用 |
| GxEPD2 + Adafruit GFX | 1.6.9 / 1.12.6 | `arduino-cli lib install GxEPD2` 安裝，只有 gxepd2_test 用到 |

原本 libraries 裡的 `TFT_eSPI` 跟 Seeed_GFX 的標頭檔同名會衝突，已移到 `D:\我的\文件\Arduino\libraries_disabled\TFT_eSPI`；
其他專案需要時再搬回 `libraries`(搬回後編譯 Seeed_GFX 專案要加 `--library` 指定)。

ESP32 Core 曾嘗試升級到 3.3.x，但會連帶下載用不到的 RISC-V 工具鏈(約 400MB，GitHub 下載很慢)，已中止，維持 3.1.1。

新電腦重建環境：

```powershell
# 1. 手動：到 https://github.com/arduino/arduino-cli/releases 下載 Windows 64bit zip，解壓到 D:\MyTools\tools\arduino-cli
#    (另外要有 git、Python)
# 2. 之後一行搞定：安裝 ESP32 Core 3.1.1 + Seeed_GFX、OpenFontRender、ArduinoJson、PubSubClient
.\firmware\setup-env.ps1
```

### 每個 sketch 的必要設定

1. **TF 卡的 CS 一定要先拉高(最重要，踩過的坑)**：TF 卡跟螢幕共用 SPI，插著卡時如果沒先把卡的 CS(GPIO14)拉高，
   卡片會跟著回應匯流排上的資料，螢幕收不到正確的參數與畫面，症狀是「BUSY 正常、刷新也跑了 30 秒，但畫面完全不變或只是變淡」。
   官方範例都沒處理這點(Seeed 論壇也有人遇到，拔卡就好)。每個 sketch 的 `setup()` 最前面都要加：
   ```cpp
   pinMode(14, OUTPUT); digitalWrite(14, HIGH); // TF卡 CS 拉高(閒置)
   pinMode(16, OUTPUT); digitalWrite(16, HIGH); // TF卡供電
   delay(20);
   ```
   要讀寫 TF 卡時，用螢幕的 SPI 實例補上 MISO，並且要先 `end()` 才會套用新腳位(見 hw_test 的 `testSd()`)：
   ```cpp
   SPIClass &spi = epaper.getSPIinstance();
   spi.end();
   spi.begin(7, 8, 9, -1);
   SD.begin(14, spi);
   ```
2. sketch 資料夾內要有 `driver.h`，指定螢幕型號：
   ```cpp
   #define BOARD_SCREEN_COMBO 521 // reTerminal E1002 (7.3吋 Spectra 6 彩色)
   ```
3. 板子選 `XIAO_ESP32S3`，PSRAM 要開 OPI，Serial 走 CH340(UART0)所以 USB CDC On Boot 要關：
   ```
   FQBN = esp32:esp32:XIAO_ESP32S3:PSRAM=opi,CDCOnBoot=cdc
   ```
   Flash 實際是 32MB，但用板子預設的 8MB 分割表即可正常使用。
4. 編譯時加 `--library` 指定 Seeed_GFX，避免日後 TFT_eSPI 搬回來時挑錯函式庫。

### 編譯 / 燒錄 / 看 log

在專案根目錄的 PowerShell 執行(所有腳本都用 PowerShell；第一次若被擋「禁止執行指令碼」，先執行一次 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`)：

```powershell
.\firmware\sketch.ps1 hello                # 編譯並燒錄 firmware\hello(換成別的 sketch 資料夾名即可)
.\firmware\sketch.ps1 hello -Monitor       # 燒完接著看 Serial log(Ctrl+C 結束)
.\firmware\sketch.ps1 hello -MonitorOnly   # 只看 log
.\firmware\sketch.ps1 hello -Port COM5     # 換序列埠(預設 COM23)
```

注意：
- 燒錄時裝置電源開關要在 **ON**，關機或深度睡眠中無法燒錄。
- 螢幕整頁刷新約 33 秒，畫面會閃好幾次，這是 Spectra 6 的正常現象。
- 序列埠可以用 Python(pyserial)讀：開啟 COM23 後拉一下 RTS 就會重開機，從頭抓到開機 log。
- `build/` 已在 .gitignore。

---

## 三、電子紙看板(桌面工具 + firmware/screen)

這是**擴展功能**：桌面工具設定裡勾選「啟用電子紙看板」才會運作，詳細設定也只在啟用後顯示。
數據由桌面工具用既有的 EIP API 算(不需要改後端)，不經過任何外部雲端服務。

```
EIP 後端 --(既有API)--> 桌面工具 screenService ──MQTT(內建伺服器,區網)──> 屏幕(ESP32)
                         ├ 數據彙整(工程師/加星專案的待處理、待審核)        ├ 收「保留訊息」：dashboard / config
                         ├ MQTT 伺服器(aedes，帳密認證)                     ├ 內容(rev)有變才刷新電子紙
                         └ 用屏幕 IP 把設定寫進屏幕(HTTP)                   └ 回報 status：電量/IP/模式/畫面版本
```

### 桌面端

- `src/main/screenService.js`：數據彙整、MQTT 伺服器、排程、`probe`/`provision`(寫入屏幕)。aedes 1.x 是 ESM，Electron 內建 Node 20 要用動態 `import()`。
- `src/renderer/screen-settings.js`：設定畫面。**原則：測試/預覽/推送/連接都用畫面上目前的值，成功才儲存**(見記憶 settings-test-before-save)。
- MQTT 主題 `nsst/screen/<deviceId>/`：`dashboard`(保留)、`config`(保留)、`cmd`(一次性：refresh/reboot/status)、`status`(屏幕發)。
- 數字定義(使用者指定，跟桌面工具左側工單清單一致)：**待處理**＝送 QC 之前、要工程師處理的(新任務/已指派/已暫停/失敗/追蹤中)，預設只算「本週五以前開始」的(後端待辦清單的預設範圍，設定 `todoThisWeekOnly` 可關)；**待審核**＝從送 QC 開始、尚未關閉的(品保中、已完成、成功)，但**工程師欄預設不含「成功」**(只看送 QC 與已完成，設定 `engineerReviewIncludeSuccess` 可打開)；專案欄仍含成功；**逾期**＝待處理且預定完成日已過。工程師範圍＝工程部在職人員，可設黑名單；專案＝專案查詢裡加星的，流程各階段分開算。
- 左側清單：「已完成」(品保通過)的單還要工程師回覆並設為成功，後端待辦清單不回傳，所以另外用進階搜尋查出來，列在清單最後並用「✔ 已完成・待回覆成功」圖示標示，**不計入**「待處理」後面的數字(該處另外顯示 ✔N)。
- 注意：「已完成/成功」後端 `/tickets` 視為已結束不回傳，待審核數要另外用進階搜尋算(總表筆數)。目前後端 `reply` 對已完成(2)的單會回「已結束」，桌面工具還不能直接回覆這類單。
- 防火牆：Windows 第一次會問是否允許 Electron 監聽 1883 連接埠，要允許(只開私人網路即可)。

### 按鍵與分頁

| 按鍵 | 行為 |
|---|---|
| 綠鍵(右) | **睡眠中：喚醒並重新連線**(嗶一聲)。**醒著短按：翻到下一頁**，最後一頁再按回第一頁(只有一頁就是重畫；畫面被清除時是恢復顯示)。**按住 5 秒：清除畫面**(收納前用，嗶兩聲，清成白色並停放，按綠鍵或桌面工具「恢復顯示」才回來) |
| 兩顆白鍵 | **同時長按 2 秒：進設定模式**(睡眠中也行，不用先喚醒；偵測到兩顆都按下嗶一聲，按滿 2 秒嗶兩聲進入，離開嗶一聲長音)。單按白鍵 = 之後用來切換頁面種類(工作儀表板/個人工作台/照片展示)，目前沒有功能，睡眠中單按會快速確認後接著睡完原本的時間，不連網 |

- 分頁：專案/工程師太多一頁放不下就自動分頁(工程師每頁 14 位、專案依各自高度裝滿一頁，工程師欄每頁都保留)，右上角顯示「第 1/2 頁・共 12 個」，底部顯示「短按綠鍵翻頁 1/2」。**每翻一頁是一次整頁刷新，約 35 秒**(這種螢幕沒有局部刷新)。頁碼存在 NVS，資料變了會限制在新的頁數內。
- **不做**「最短重畫間隔」：使用者明確否決(資料更新頻率本來就不高，延遲只會傷害體驗)。資料一變、桌面工具一推就立刻重畫。
- 資料更新時機：EIP 不會主動通知，桌面工具每隔「向 EIP 取數據間隔」(預設 10 分鐘，最短 1 分鐘)查一次，發現內容有變才推給屏幕；插 USB 時屏幕一直連著 MQTT，收到就畫。

### 電源模式(桌面工具設定，推送給屏幕)

**插 USB 充電時永遠不休眠**(`usbAlwaysOn`)，不管哪種模式。USB 偵測：這塊板子沒有可讀的充電狀態腳位，改看 USB 轉序列晶片 CH340 的 TX 線(GPIO44)：有電時固定高電位，沒電時浮空，用內部下拉電阻判斷(`boardUsbPresent()`，會暫停 Serial 約 30ms)。

| 模式 | 行為 |
|---|---|
| 智慧 smart(預設) | 電量夠、上班時段內、連得上 MQTT → 保持連線(WiFi 省電+降頻 80MHz，即時收推送)。下班時段/連不上 → 深度睡眠，每 `offWakeMin`(預設30，0=睡到上班時段)分鐘醒來連一次，有新數據才刷新，沒數據或連不上繼續睡。電量低於 `lowBatteryPct` 一律睡眠 |
| 定時 periodic | 每 `wakeMin` 分鐘醒來抓一次，平時深度睡眠；可限定只在上班時段 |
| 一律連線 always_on | 永遠保持連線 |

- 「輕度睡眠」：Arduino-ESP32 3.1.1 預編譯函式庫沒開 `CONFIG_PM_ENABLE`，**沒有自動輕度睡眠**，保持連線只能用 WiFi modem 省電+降頻(估計 20~25mA，2000mAh 約 3 天，**未實測**)。要降到幾 mA 得自編 ESP-IDF 函式庫，目前 `lightSleep` 欄位保留但未實作。
- 任一按鍵隨時喚醒；按鍵喚醒後 90 秒內開 HTTP 設定視窗(不需認證)方便桌面工具寫設定。
- 斷線清除畫面：桌面工具設定「斷線超過幾**分鐘**清除畫面」(0=不清除，預設 1440=24 小時；舊版的小時設定自動換算)。
- 底部狀態列：左邊 電量／溫度／濕度；中間 狀態(USB 供電．即時連線／即時連線／省電模式／定時同步)＋翻頁提示；右邊 保持連線時顯示屏幕 IP(桌面工具填「屏幕 IP」用)，睡眠模式顯示下次同步時間。
- 狀態列的 USB/連線狀態是「上次畫圖當下」的，所以狀態變了(拔插 USB、改睡眠)會自動重畫一次(連續兩次、約 1 分鐘都不同才重畫，避免偵測閃一下就刷 33 秒)；睡著前也會先把「USB 供電」更新掉。
- 時間：連上 WiFi 用 NTP 校時並寫進板上 PCF8563 時鐘晶片，睡眠醒來先讀晶片。公司網路擋外部 NTP 時在桌面工具改 NTP 伺服器。

### 換環境/第一次設定(兩顆白鍵同時按住 2 秒)

1. 屏幕進**設定模式**：開 WiFi 熱點 `NSST-Screen-XXXX`(開放)，螢幕顯示說明。
2. 手機連上熱點，會自動彈出設定頁(沒彈就開 192.168.4.1)，列出附近 WiFi，選一個輸入密碼。
3. 連上後螢幕顯示**屏幕 IP**，熱點關閉，HTTP 設定介面再開 10 分鐘。
4. 桌面工具輸入屏幕 IP →「測試連線」(只讀) →「連接屏幕並寫入設定」：MQTT 位置(自動選跟屏幕同網段的電腦 IP)、帳密、電源模式、時鐘都寫進去，屏幕自動重開機並連上。
- 屏幕可存多組 WiFi，開機掃描附近有哪組就連哪組，換環境不用重設。
- 認證：屏幕設過 MQTT 密碼後，寫入類 HTTP 接口要帶標頭 `X-Auth: <MQTT密碼>`；全新屏幕、設定模式、按鍵喚醒的 90 秒視窗不用。`GET /info` 一律不用認證。

### 固件結構 firmware/screen

| 檔案 | 用途 |
|---|---|
| `screen.ino` | 主流程：開機一輪(連線→收訊息→有變才畫→回報)→依電源規則保持連線或睡眠；按鍵 |
| `appconfig.*` | 設定檔 `/config.json`(LittleFS)：多組 WiFi、MQTT、電源、時鐘；沒檔時用 `secrets.h` 開發預設值 |
| `power.*` | 電源規則 `powerPlan()`、上班時段、深度睡眠(按鍵+定時喚醒，要用 RTC 上拉) |
| `netmqtt.*` | WiFi 多組連線、WiFi 省電、MQTT 客戶端(PubSubClient) |
| `clock.*` | NTP + PCF8563 |
| `setup.*` `pages.*` | 設定模式(熱點、DNS、手機網頁)與螢幕說明頁 |
| `devserver.*` | HTTP：`/info` `/config` `/reboot` `/ls` `/fetch` `/md5` `/rm` `/render` `/preview.bmp`，除 `/info` 外需認證 |
| `board.*` `display.*` `fonts.*` `dashboard.*` | 腳位與 TF 卡、螢幕、中文字型、儀表板版面 |
| `partitions.csv` | 32MB Flash：app0/app1 各 4MB、約 24MB LittleFS(字型、設定、資料庫) |

編譯與燒錄(32MB 版)：板子預設只認 8MB，腳本已加 build-property；`arduino-cli upload` 不支援，所以腳本改用 esptool 直接燒(電腦要接著 USB、電源開關在 ON、沒有程式佔用序列埠)：

```powershell
.\firmware\screen\flash.ps1                  # 只燒程式(用現有的 build，最常用)
.\firmware\screen\flash.ps1 -Compile         # 先編譯再燒程式
.\firmware\screen\flash.ps1 -Compile -Full   # 整套燒(bootloader+分區表+程式)，改了 partitions.csv 才需要
.\firmware\screen\flash.ps1 -Port COM5       # 換序列埠(預設 COM23)
```

需要的函式庫：Seeed_GFX、OpenFontRender(GitHub takkaO/OpenFontRender)、ArduinoJson 7、PubSubClient。字型用 `firmware/fonts/make_fonts.py` 產生，再用腳本經屏幕的 `/fetch` 讓屏幕自己從這台電腦下載到 `flash:/fonts/`(屏幕與電腦要在同一個區網；腳本會暫時開 8765 埠的 HTTP 伺服器，傳完自動關閉)：

```powershell
python firmware\fonts\make_fonts.py     # 產生字型(只需要做一次)
.\firmware\upload-fonts.ps1 -ScreenIp <屏幕IP> -Password <MQTT密碼>   # 傳到屏幕並比對 MD5
```

調版面不要一直刷實體螢幕：`POST /render?dry=1` 只畫到記憶體，`GET /preview.bmp` 下載預覽(顏色是近似值)。

### 踩過的坑(都已處理，改程式前要知道)

1. **TF 卡的 CS 一定要先拉高**(見第二節)；字型**不能放 TF 卡**：跟螢幕共用 SPI，FreeType 隨機讀取會讀到一半出錯，整張卡就讀不到。字型放內建 Flash(5MB 檔案校驗 1.7 秒，TF 卡要 11 秒且不穩)。
2. TF 卡開檔數上限要拉高(`SD.begin(..., "/sd", 16)`)，速度用 4MHz。
3. **字型缺字**：Google 版 Noto Sans TC 缺 2392 個日文專用漢字與簡體字(例如「粋」)，顯示成方框；屏幕的 FreeType 只編譯了 TrueType，**不支援 CFF 格式的完整 CJK 字型**。解法在桌面端：`firmware/fonts/make_fallback_map.py` 用 OpenCC 產生 `src/main/charFallback.json`(2075 個對應，粋→粹、简→簡)，`screenService.js` 的 `showable()` 在產生數據時把缺的字換成繁體。
4. **電子紙色號不是 RGB**：`TFT_WHITE=0x0、TFT_BLACK=0xF、TFT_RED=0x6、TFT_BLUE=0xD、TFT_GREEN=0x2、TFT_YELLOW=0xB`。傳給字型渲染器的顏色不能直接用，`fonts.cpp` 一律用白字疊黑底算覆蓋率再二值化，並且要同時攔截 `drawPixel` 和 `drawFastHLine`(否則不透明的粗體字變空心)。
5. ESP32 WebServer 解析大型 multipart 上傳不穩(會截斷)：改由屏幕主動 `/fetch` 下載。
5. 電子紙刷完要 `epaper.sleep()` 讓面板斷電(`displayFlush()` 已處理)；刷新約 33 秒，內容沒變不刷。
6. ESP32 Core 維持 3.1.1：升級 3.3.x 會下載 400MB 用不到的工具鏈。

### 目前驗證狀態(2026-10-03)

已實測：桌面端數據彙整邏輯(假資料)、MQTT 認證/保留訊息、測試連線與寫入設定(對真屏幕)、屏幕連線收數據並刷新、插 USB 時判斷為 USB、設定畫面的「先測再存」流程。
**尚未實測**：拔掉 USB 後的行為(USB 偵測是否變 false、深度睡眠與按鍵/定時喚醒、保持連線時的省電)、設定模式(熱點+手機網頁)、公司網路環境、真實 EIP 數據、電池續航。

---

## 四、出廠固件(SenseCraft HMI)備份與還原

### 備份

2026-10-03 在刷自製固件前，已用 esptool 把整顆 32MB Flash 讀出備份：

```
firmware/backup/e1002-factory-32MB.bin
SHA256 82667fd9a134d38fd3bfc5551e95d3604a4a86f31316666434a1f9185cc8c07c
```

(33,554,432 bytes；0x8000 分割表魔數 `aa50` 正常，有效資料約到 0x194d022；當時 SenseCraft 固件版本 1.2.2)

這份檔案含裝置的 Wi-Fi 密碼與 SenseCraft 綁定資料，**不進 git**(已列入 .gitignore)，請另外複製一份到安全的地方保存。

重新備份的指令：

```powershell
.\firmware\backup-factory.ps1        # 存成 firmware\backup\e1002-backup-<時間>.bin，不會蓋掉出廠備份
```

### 還原方法一：官方 Firmware Flasher(建議)

1. USB-C 接上電腦，電源開關切到 ON。
2. 用 Chrome 或 Edge 開 https://sensecraft.seeed.cc/hmi → Tools → Firmware Flasher。
3. Select 選裝置(COM23)，選最新版韌體，按 Flash。
4. 勾 **Full Flash** = 完全回到出廠狀態(Wi-Fi、設計畫面都清空，要重新配網綁定)；不勾則保留設定。

### 還原方法二：寫回自己的備份(官方工具失效時用)

整顆寫回，會連同當時的 Wi-Fi 與 SenseCraft 綁定一起還原：

```powershell
.\firmware\restore-factory.ps1       # 會先要求輸入 yes 確認
.\firmware\restore-factory.ps1 -File <其他備份.bin>
```

ESP32-S3 的燒錄模式在晶片 ROM 裡，自製固件覆蓋不到，就算自製固件當機、開不了機，也能用上面兩種方法刷回去。
唯一不可逆的是 eFuse(`espefuse` 燒寫、Flash 加密、Secure Boot)，自製固件不要碰這些。

---

## 參考資料

- [Getting Started with reTerminal E1002](https://wiki.seeedstudio.com/getting_started_with_reterminal_e1002/)
- [Arduino Cookbook: ePaper Display (reTerminal E Series)](https://wiki.seeedstudio.com/reterminal_e10xx_with_arduino/)
- [reTerminal E Series 總覽](https://wiki.seeedstudio.com/reterminal_e10xx_main_page/)
- [Seeed_GFX](https://github.com/Seeed-Studio/Seeed_GFX)
- [OSHW-reTerminal-Series-E-D(官方開源範例)](https://github.com/Seeed-Projects/OSHW-reTerminal-Series-E-D)
