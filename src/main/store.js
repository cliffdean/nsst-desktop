const Store = require('electron-store');

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

module.exports = { settingsStore, timersStore, ticketMetaStore, todoStore, projectStarStore };
