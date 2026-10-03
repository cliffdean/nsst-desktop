const Store = require('electron-store');

// 電子紙看板設定預設值：electron-store的defaults只補最上層，所以讀取時要自己跟這份合併(舊版設定檔缺新欄位)
const SCREEN_DEFAULTS = {
  enabled: false,
  mqttPort: 1883,
  mqttUser: 'nsst',
  mqttPassword: '', // 第一次啟用時自動產生
  deviceId: 'e1002', // MQTT主題的一段：nsst/screen/<deviceId>/...
  title: '工單看板',
  refreshMin: 10, // 桌面端多久向EIP取一次數據、有變化就推送給屏幕
  // 工單狀態分類(EIP狀態碼：0新任務 1已指派 2已完成 3已暫停 4成功 5失敗 7追蹤中 10品保中)
  todoStatuses: [0, 1, 3, 5, 7], // 需要工程師處理
  reviewStatuses: [2, 4, 10], // 不需工程師處理、等審核(已轉品保的單一律算待審核)
  engineerBlacklist: [], // 不追蹤的工程師user id
  showProjects: true,
  // 待處理只算「本週五以前開始」的(跟桌面工具左側清單的「待處理」數字完全一致，後端待辦清單預設就是這個範圍)；
  // 關掉的話會把開始日在更之後的未結案工單也算進來
  todoRange: 'week', // 工程師「待處理」算到哪一天以前開始的：'week'=本週五(跟左側清單預設一致)、'next'=下週五、'all'=不限(舊版 todoThisWeekOnly=false)
  // 工程師的「待審核」是否把「成功」(4)也算進去。預設不算：工程師欄的待審核只看送QC(品保中)與已完成，
  // 成功的單已經不需要工程師再動作。(專案欄的待審核仍依下面的狀態分類)
  engineerReviewIncludeSuccess: false,
  // 屏幕配置(推送給屏幕，屏幕下次連線時套用)。插USB充電時屏幕一律不休眠，不管哪種模式
  //   smart     上班時段內連得上MQTT就保持連線(WiFi省電、即時收推送)；下班時段/連不上就深度睡眠，每offWakeMin分鐘醒來抓一次
  //   periodic  每wakeMin分鐘醒來抓一次，平時深度睡眠
  //   always_on 一律保持連線
  powerMode: 'smart',
  wakeMin: 30, // periodic：醒來間隔(分鐘)
  offWakeMin: 30, // smart：下班時段/連不上時的醒來間隔(分鐘)，0=不定時醒來(睡到下個上班時段開始)
  activeStart: '08:00', // 上班時段，空字串=全天都算上班
  activeEnd: '19:00',
  weekendsOff: true, // 週末算下班時段
  periodicInWindowOnly: false, // periodic：只在上班時段內醒來
  usbAlwaysOn: true, // 插USB時不休眠
  lowBatteryPct: 15, // 電量低於這個值，屏幕不再保持連線(保命)
  clearOfflineMin: 1440, // 斷線超過幾「分鐘」就把螢幕清成白色(電子紙長時間顯示同一張圖會殘影、縮短壽命)，連線恢復自動重畫；0=不清除
  ntpServer: 'pool.ntp.org', // 屏幕校時用；公司網路擋外部NTP時改成內部的
  tzHours: 8,
  hostOverride: '', // 屏幕連線用的桌面工具IP；空=自動偵測
  screenIp: '', // 屏幕的IP(屏幕連上WiFi後顯示在螢幕上)，用來把連線設定寫進屏幕
};

// 使用者設定：EIP連線資訊、LLM供應商設定、本地git專案路徑
const settingsStore = new Store({
  name: 'settings',
  defaults: {
    eipBaseUrl: 'http://localhost/api/v1',
    apiToken: '',
    gitRepoPath: '', // 找不到對應專案路徑時的預設值
    hotkey: 'CommandOrControl+Alt+T',
    // 每個專案自己的本地git路徑：{ [project_id]: 'D:\\path\\to\\repo' }，因為一個工單只對應一個專案
    projectPaths: {},
    llm: {
      provider: 'ollama', // 'ollama' | 'deepseek'
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'qwen2.5-coder',
    },
    // 公司信箱帳密：IMAP收信 + CalDAV行事曆(行事曆之後再實作)共用同一組帳密
    mail: {
      username: '',
      password: '',
      calendarUrl: '',
      imapHost: '',
      imapPort: 993,
      imapSecure: true,
      // 預設仍驗證憑證；只有使用者在設定裡明確勾選「信任自簽憑證」才會放寬，避免密碼在中間人攻擊下外洩
      imapAllowInsecureTLS: false,
    },
    // 電子紙看板(reTerminal E1002)：擴展功能，enabled=false時整個功能不啟動、畫面上也看不到
    // 桌面工具內建MQTT伺服器，把儀表板數據推給屏幕；屏幕的休眠等配置也在這裡設定，推送給屏幕
    screen: SCREEN_DEFAULTS,
    // 回覆範本：依工單類型分開存，只是給AI產生回覆/手動套用時參考的文字架構，不會直接送到EIP
    replyTemplates: {
      bug: '',
      feature: '',
      optimize: '',
      inquiry: '',
      other: '',
    },
  },
});

// 計時器狀態：每張工單一筆，segments紀錄多段 start/end，因為工單可以暫停
// { [ticketId]: { status: 'idle'|'running'|'paused'|'stopped', segments: [{start, end}] } }
const timersStore = new Store({ name: 'timers', defaults: {} });

// 工單類型標記：純本地判斷用，不回寫EIP。開單人分類常常不準，這裡讓工程師自己在本機修正，
// 只是用來決定AI產生回覆時套用哪一種範本/寫法，不影響工單本身在EIP上的任何欄位
// { [ticketId]: 'bug'|'feature'|'optimize'|'inquiry'|'other' }
const ticketMetaStore = new Store({ name: 'ticket-meta', defaults: {} });

const todoStore = new Store({ name: 'todos', defaults: { items: [] } });

// 加星關注的專案：純本地功能，不回寫EIP，只是方便自己在專案查詢列表裡快速認出要盯的專案
// { [project_id]: true }
const projectStarStore = new Store({ name: 'project-stars', defaults: {} });

// 電子紙看板的執行狀態(不同步到後端)：最後一份儀表板數據(MQTT保留訊息重啟後要還原)、屏幕最後回報的狀態
const screenStore = new Store({ name: 'screen-state', defaults: {} });

module.exports = { settingsStore, timersStore, ticketMetaStore, todoStore, projectStarStore, screenStore, SCREEN_DEFAULTS };
