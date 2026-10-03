// 個人資料同步：待辦、計時、工單類型標記、加星專案、回覆範本存到EIP後端(跟著帳號走，多台電腦共用)
// 本機的electron-store仍是快取，離線照常讀寫；有變動就延遲推上去，啟動/登入後/定時再從後端拉回來
// 每種資料整包覆蓋，後寫的贏；每台電腦不同的設定(專案Git路徑、快捷鍵、EIP網址)不同步
const { settingsStore, timersStore, ticketMetaStore, todoStore, projectStarStore } = require('./store');
const eipApi = require('./eipApi');

const PUSH_DELAY_MS = 1000;

// 整個store當一份資料的種類
const storeEntries = {
  todos: todoStore,
  timers: timersStore,
  ticket_meta: ticketMetaStore,
  project_stars: projectStarStore,
};

const DEFAULT_REPLY_TEMPLATES = { bug: '', feature: '', optimize: '', inquiry: '', other: '' };

const entries = {};
Object.entries(storeEntries).forEach(([key, store]) => {
  entries[key] = {
    get: () => store.store,
    // 後端PHP把空物件存成[]，這裡一律轉回物件
    set: (value) => { store.store = value && !Array.isArray(value) ? value : {}; },
    clear: () => store.clear(),
    onChange: (cb) => store.onDidAnyChange(cb),
  };
});
entries.reply_templates = {
  get: () => settingsStore.get('replyTemplates'),
  set: (value) => settingsStore.set('replyTemplates', { ...DEFAULT_REPLY_TEMPLATES, ...(value && !Array.isArray(value) ? value : {}) }),
  clear: () => settingsStore.set('replyTemplates', { ...DEFAULT_REPLY_TEMPLATES }),
  onChange: (cb) => settingsStore.onDidChange('replyTemplates', cb),
};

const dirty = new Set(); // 本機改過、還沒成功推上去的種類；拉取時不會被後端的舊資料蓋掉
const pushTimers = new Map();
let applying = false; // 正在套用後端資料/清除本機資料時，store變動不要再推回去
let onRemoteApplied = null; // 拉回來的資料套用到本機後通知(主程序重排待辦提醒、通知畫面重繪)

function isLoggedIn() {
  return !!settingsStore.get('apiToken');
}

function withoutPush(fn) {
  applying = true;
  try {
    fn();
  } finally {
    applying = false;
  }
}

async function push(key) {
  pushTimers.delete(key);
  if (!isLoggedIn()) return false;
  try {
    await eipApi.saveDesktopData(key, entries[key].get());
    dirty.delete(key);
    return true;
  } catch (err) {
    console.warn(`同步${key}到後端失敗，稍後再試：`, err.message);
    return false;
  }
}

function schedulePush(key) {
  if (applying) return;
  dirty.add(key);
  clearTimeout(pushTimers.get(key));
  pushTimers.set(key, setTimeout(() => push(key), PUSH_DELAY_MS));
}

// 這台電腦第一次跟這個帳號同步時，本機原有的資料跟後端合併，不直接被後端蓋掉(例如兩台電腦各自用過一陣子)
function mergeFirstSync(key, remote, local) {
  const remoteObj = remote && !Array.isArray(remote) ? remote : {};
  const localObj = local && !Array.isArray(local) ? local : {};
  if (key === 'todos') {
    // 待辦用id合併，同一筆取updatedAt較新的
    const byId = new Map();
    [...(remoteObj.items || []), ...(localObj.items || [])].forEach((todo) => {
      const existing = byId.get(todo.id);
      if (!existing || String(todo.updatedAt || '') > String(existing.updatedAt || '')) byId.set(todo.id, todo);
    });
    return { ...remoteObj, items: [...byId.values()] };
  }
  if (key === 'reply_templates') {
    // 範本以後端為主，後端空白的欄位才用本機的
    const merged = { ...localObj };
    Object.entries(remoteObj).forEach(([k, v]) => { if (v) merged[k] = v; });
    return merged;
  }
  return { ...remoteObj, ...localObj }; // 計時/類型標記/加星：以ticket/專案id為key，聯集即可
}

// 有本機改動還沒推上去的先推；後端有的覆蓋本機，後端沒有而本機有資料的把本機推上去
// userId：目前登入的EIP使用者，用來判斷這台電腦是不是第一次跟這個帳號同步、或換了帳號
async function pull(userId) {
  if (!isLoggedIn() || !userId) return { ok: false, reason: 'not-logged-in' };
  const syncedUserId = settingsStore.get('syncedUserId', null);
  if (syncedUserId != null && String(syncedUserId) !== String(userId)) {
    clearLocal(); // 換了帳號：上一個人的資料已經在後端，本機清掉，不要混進這個帳號
  }
  const firstSync = syncedUserId == null || String(syncedUserId) !== String(userId);

  for (const key of [...dirty]) {
    clearTimeout(pushTimers.get(key));
    await push(key);
  }
  const { data } = await eipApi.getDesktopData();
  const applied = [];
  for (const key of Object.keys(entries)) {
    if (dirty.has(key)) continue; // 補推又失敗了，保留本機版本，下次再試
    const hasRemote = Object.prototype.hasOwnProperty.call(data, key);
    const local = entries[key].get();
    if (hasRemote && firstSync && hasContent(local)) {
      withoutPush(() => entries[key].set(mergeFirstSync(key, data[key], local)));
      applied.push(key);
      await push(key);
    } else if (hasRemote) {
      withoutPush(() => entries[key].set(data[key]));
      applied.push(key);
    } else if (hasContent(local)) {
      await push(key);
    }
  }
  settingsStore.set('syncedUserId', userId);
  if (applied.length && onRemoteApplied) onRemoteApplied(applied);
  return { ok: true, applied };
}

function hasContent(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some((v) => (Array.isArray(v) ? v.length : typeof v === 'object' ? v && Object.keys(v).length : !!v));
}

// 退出前把還沒推上去的資料推完；回傳推不上去的種類，讓畫面決定要不要強制退出
async function flush() {
  for (const key of Object.keys(entries)) {
    if (!dirty.has(key)) continue;
    clearTimeout(pushTimers.get(key));
    await push(key);
  }
  return [...dirty];
}

// 清除本機全部個人資料(不推到後端，後端的資料保留給下次登入)
function clearLocal() {
  pushTimers.forEach((t) => clearTimeout(t));
  pushTimers.clear();
  dirty.clear();
  withoutPush(() => Object.values(entries).forEach((entry) => entry.clear()));
  settingsStore.delete('syncedUserId');
}

function init(onApplied) {
  onRemoteApplied = onApplied;
  Object.keys(entries).forEach((key) => entries[key].onChange(() => schedulePush(key)));
}

module.exports = { init, pull, flush, clearLocal };
