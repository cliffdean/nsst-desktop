const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, clipboard, shell, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');

const { settingsStore, ticketMetaStore, todoStore, projectStarStore, SCREEN_DEFAULTS, SCREEN_TODO_LIMIT } = require('./store');
const eipApi = require('./eipApi');
const timerService = require('./timerService');
const gitService = require('./gitService');
const llmService = require('./llmService');
const mailService = require('./mailService');
const calendarService = require('./calendarService');
const siteService = require('./siteService');
const syncService = require('./syncService');
const screenService = require('./screenService');

let mainWindow = null;
let tray = null;
let currentHotkey = null;
let notificationWindow = null;
let pendingNotification = null;
const todoReminderTimers = new Map();

function getTodos() {
  const stored = todoStore.get('items', null);
  if (Array.isArray(stored)) return stored;
  const legacy = Object.values(todoStore.store).filter((item) => item && typeof item === 'object' && item.title);
  todoStore.set('items', legacy);
  return legacy;
}

function scheduleTodoReminder(todo) {
  const oldTimer = todoReminderTimers.get(todo.id);
  if (oldTimer) clearTimeout(oldTimer);
  todoReminderTimers.delete(todo.id);
  if (!todo.reminderAt || todo.completed) return;
  const reminderTime = Date.parse(todo.reminderAt);
  if (Number.isNaN(reminderTime)) return;
  const timer = setTimeout(() => {
    todoReminderTimers.delete(todo.id);
    try {
      showSystemNotification('待辦提醒', todo.title);
    } catch (err) {
      console.warn('顯示待辦提醒失敗：', err.message);
    }
  }, Math.max(0, reminderTime - Date.now()));
  todoReminderTimers.set(todo.id, timer);
}

function showSystemNotification(title, body) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('notification:push', { title, body });
  }
  showPersistentNotification(title, body);
  return true;
}

function showPersistentNotification(title, body) {
  pendingNotification = { title, body };
  if (!notificationWindow || notificationWindow.isDestroyed()) {
    notificationWindow = new BrowserWindow({
      width: 380,
      height: 150,
      frame: false,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    notificationWindow.setAlwaysOnTop(true, 'floating');
    notificationWindow.on('closed', () => {
      notificationWindow = null;
      pendingNotification = null;
    });
    notificationWindow.loadFile(path.join(__dirname, '..', 'renderer', 'notification.html'));
    notificationWindow.webContents.once('did-finish-load', () => updatePersistentNotification());
  } else {
    updatePersistentNotification();
  }
}

function updatePersistentNotification() {
  if (!notificationWindow || notificationWindow.isDestroyed() || !pendingNotification) return;
  notificationWindow.webContents.send('notification:update', pendingNotification);
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const bounds = notificationWindow.getBounds();
  notificationWindow.setPosition(area.x + area.width - bounds.width - 16, area.y + area.height - bounds.height - 16);
  notificationWindow.show();
  notificationWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    show: false,
    frame: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 關閉視窗只是隱藏到系統匣，不真的結束程式(常駐用)
  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

// 獨立的工單詳情視窗：同一張工單重複點只把原本的視窗叫到前面，不重複開
const ticketWindows = new Map();

function openTicketWindow(ticketId) {
  const key = String(ticketId);
  const existing = ticketWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return true;
  }
  const win = new BrowserWindow({
    width: 760,
    height: 820,
    minWidth: 480,
    minHeight: 360,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  ticketWindows.set(key, win);
  win.on('closed', () => ticketWindows.delete(key));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'ticket.html'), { query: { id: key } });
  return true;
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function createTray() {
  tray = new Tray(path.join(__dirname, '..', '..', 'assets', 'tray-icon.png'));
  refreshTrayMenu();
  tray.on('click', toggleWindow);
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setToolTip('EIP工單小工具');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `顯示/隱藏 (${currentHotkey || '未設定快捷鍵'})`, click: toggleWindow },
      { type: 'separator' },
      {
        label: '結束',
        click: () => {
          app.isQuiting = true;
          app.quit();
        },
      },
    ])
  );
}

// 設定裡的快捷鍵可能被使用者改掉，這裡統一處理「換一個快捷鍵重新註冊」
function registerHotkey(accelerator) {
  if (currentHotkey) {
    globalShortcut.unregister(currentHotkey);
  }
  currentHotkey = null;
  if (!accelerator) return true;

  const ok = globalShortcut.register(accelerator, toggleWindow);
  if (ok) {
    currentHotkey = accelerator;
  }
  refreshTrayMenu();
  return ok;
}

// Electron預設沒有右鍵選單：所有視窗(主視窗、獨立工單視窗)統一加上，
// 圖片(預覽視窗、工單說明/回覆裡的圖)可以複製圖片或網址，選取的文字可以複製
app.on('web-contents-created', (_event, contents) => {
  contents.on('context-menu', (_e, params) => {
    const template = [];
    if (params.mediaType === 'image') {
      template.push(
        { label: '複製圖片', click: () => contents.copyImageAt(params.x, params.y) },
        { label: '複製圖片網址', click: () => clipboard.writeText(params.srcURL) }
      );
    }
    if (params.selectionText && params.editFlags.canCopy) {
      if (template.length) template.push({ type: 'separator' });
      template.push({ label: '複製', role: 'copy' });
    }
    if (!template.length) return;
    Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(contents) || undefined });
  });

  // 信件iframe裡的連結(會議連結等)一律交給系統瀏覽器開，不在App裡開新視窗或在iframe內跳轉
  const isExternalUrl = (url) => /^(https?|mailto):/i.test(url);
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame || !isExternalUrl(e.url)) return;
    e.preventDefault();
    shell.openExternal(e.url);
  });
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // 這是工具程式不是網頁瀏覽器，不需要File/Edit/View那排選單
  createWindow();
  createTray();
  registerHotkey(settingsStore.get('hotkey'));
  getTodos().forEach(scheduleTodoReminder);
  syncService.init(onSyncApplied);
  syncNow();
  setInterval(syncNow, SYNC_INTERVAL_MS);
  // 登入取得新Token(或手動貼上Token)後馬上同步一次，把這個帳號的資料拉回來
  settingsStore.onDidChange('apiToken', (token) => {
    if (token) syncNow();
    screenService.apply();
  });
  // 電子紙看板(擴展功能)：沒開啟時什麼都不做；狀態變化通知所有視窗更新畫面
  screenService.init(() => {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.webContents.send('screen:changed');
    });
  });
});

// ---- 個人資料同步(待辦/計時/工單類型標記/加星/回覆範本存到EIP後端，多台電腦共用) ----
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
let syncing = null;

async function syncNow() {
  if (!settingsStore.get('apiToken')) return { ok: false, reason: 'not-logged-in' };
  if (syncing) return syncing; // 同一時間只跑一次，重複呼叫共用同一個結果
  syncing = (async () => {
    try {
      const me = await eipApi.whoami();
      return await syncService.pull(me.id);
    } catch (err) {
      console.warn('同步個人資料失敗：', err.message);
      return { ok: false, reason: err.message };
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

function clearTodoReminders() {
  todoReminderTimers.forEach((t) => clearTimeout(t));
  todoReminderTimers.clear();
}

// 後端拉回來的資料套用到本機後：待辦提醒照新資料重排，通知所有視窗重新讀取
function onSyncApplied(keys) {
  if (keys.includes('todos')) {
    clearTodoReminders();
    getTodos().forEach(scheduleTodoReminder);
  }
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send('sync:applied', keys);
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  screenService.shutdown();
});

app.on('window-all-closed', () => {
  // 常駐工具，即使全部視窗關閉也不結束(依tray結束)
});

// ---- IPC：包一層try/catch，統一把錯誤訊息傳回renderer，不要讓main process整個炸掉 ----
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const data = await fn(...args);
      return { ok: true, data };
    } catch (err) {
      const message = (err.response && err.response.data && err.response.data.error) || err.message || String(err);
      return { ok: false, error: message };
    }
  });
}

// screen 欄位跟預設值合併(舊版設定檔可能缺新欄位)，畫面才不會讀到 undefined
handle('settings:get', () => ({ ...settingsStore.store, screen: { ...SCREEN_DEFAULTS, ...settingsStore.get('screen') } }));
handle('settings:save', (patch) => {
  // 快捷鍵要先確認真的能註冊成功才寫入設定檔，避免存了一個註冊失敗的值，
  // 導致下次開機時舊的、原本能用的快捷鍵也一起消失(變成完全沒有快捷鍵可用)
  if (Object.prototype.hasOwnProperty.call(patch, 'hotkey')) {
    const previousHotkey = settingsStore.get('hotkey');
    const ok = registerHotkey(patch.hotkey);
    if (!ok && patch.hotkey) {
      registerHotkey(previousHotkey); // 註冊失敗就恢復原本的快捷鍵，不要留空
      throw new Error(`快捷鍵「${patch.hotkey}」註冊失敗，可能跟其他軟體或系統快捷鍵衝突，請換一組`);
    }
  }
  for (const key of Object.keys(patch)) {
    settingsStore.set(key, patch[key]);
  }
  return settingsStore.store;
});

handle('settings:get-active-hotkey', () => currentHotkey);

// ---- 電子紙看板(擴展功能) ----
// 設定只存「有給的欄位」並套用：不跟一般設定一起整包存，避免蓋掉其他欄位；密碼不能由畫面改成空字串
handle('screen:save-config', async (patch) => {
  const cur = { ...SCREEN_DEFAULTS, ...settingsStore.get('screen') };
  const next = { ...cur, ...patch };
  next.mqttPort = Math.min(65535, Math.max(1024, parseInt(next.mqttPort, 10) || 1883));
  next.refreshMin = Math.max(1, parseInt(next.refreshMin, 10) || 10);
  next.wakeMin = Math.max(1, parseInt(next.wakeMin, 10) || 30);
  next.offWakeMin = Math.max(0, parseInt(next.offWakeMin, 10) || 0);
  next.lowBatteryPct = Math.min(90, Math.max(0, parseInt(next.lowBatteryPct, 10) || 0));
  next.clearOfflineMin = Math.max(0, parseInt(next.clearOfflineMin, 10) || 0);
  delete next.clearOfflineHours; // 舊版單位是小時，已改成分鐘
  next.todoRange = ['week', 'next', 'all'].includes(next.todoRange) ? next.todoRange : 'week';
  delete next.todoThisWeekOnly; // 舊版的勾選，已改成 todoRange
  next.engineerReviewIncludeSuccess = !!next.engineerReviewIncludeSuccess;
  next.tzHours = parseInt(next.tzHours, 10) || 0;
  if (!['smart', 'periodic', 'always_on'].includes(next.powerMode)) next.powerMode = 'smart';
  next.deviceId = String(next.deviceId || 'e1002').replace(/[^A-Za-z0-9_-]/g, '') || 'e1002';
  if (!next.mqttPassword) next.mqttPassword = cur.mqttPassword;
  settingsStore.set('screen', next);
  await screenService.apply();
  return screenService.status();
});
handle('screen:status', () => screenService.status());
handle('screen:refresh', (override) => screenService.refresh({ force: true, override }));
handle('screen:preview', (override) => screenService.preview(override));
handle('screen:command', (name) => screenService.sendCommand(name));
handle('screen:probe', (ip) => screenService.probe(ip));
handle('screen:provision', (ip, override) => screenService.provision(ip, override));

handle('ticket-meta:get-type', (ticketId) => ticketMetaStore.get(String(ticketId), ''));
handle('ticket-meta:set-type', (ticketId, type) => {
  if (type) {
    ticketMetaStore.set(String(ticketId), type);
  } else {
    ticketMetaStore.delete(String(ticketId));
  }
  return type;
});

// 加星關注的專案：純本地功能，回傳目前所有已加星的project id(字串陣列)
handle('project-star:list', () => Object.keys(projectStarStore.store));
handle('project-star:toggle', (projectId) => {
  const key = String(projectId);
  const starred = !projectStarStore.get(key, false);
  if (starred) {
    projectStarStore.set(key, true);
  } else {
    projectStarStore.delete(key);
  }
  return starred;
});

handle('todo:list', () => getTodos());
handle('todo:save', (todo) => {
  const todos = getTodos();
  const id = todo.id || `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const existing = todos.find((item) => item.id === id);
  const completed = !!todo.completed;
  // completedAt只在「剛勾選完成」的那一刻寫入，之後編輯內容不會跟著往後延；取消完成則清空，
  // 用來判斷完成後隔天要不要繼續顯示在待辦清單(renderer.js的isTodoVisibleToday)
  let completedAt = existing ? existing.completedAt || '' : '';
  if (completed && !(existing && existing.completed)) {
    completedAt = new Date().toISOString();
  } else if (!completed) {
    completedAt = '';
  }
  const normalized = {
    id,
    title: String(todo.title || '').trim(),
    reminderAt: todo.reminderAt || '',
    pinned: !!todo.pinned,
    // 沒帶onScreen(例如編輯表單)就沿用原值，不要被編輯動作清掉
    onScreen: todo.onScreen === undefined ? !!(existing && existing.onScreen) : !!todo.onScreen,
    completed,
    completedAt,
    updatedAt: new Date().toISOString(),
  };
  if (!normalized.title) throw new Error('待辦事項內容不可為空');
  if (normalized.onScreen && !normalized.completed && !(existing && existing.onScreen && !existing.completed)) {
    const used = todos.filter((item) => item.id !== id && item.onScreen && !item.completed).length;
    if (used >= SCREEN_TODO_LIMIT) throw new Error(`最多只能有 ${SCREEN_TODO_LIMIT} 筆待辦顯示在屏幕上，請先取消其他筆的勾選`);
  }
  const index = todos.findIndex((item) => item.id === normalized.id);
  if (index >= 0) todos[index] = normalized;
  else todos.push(normalized);
  todoStore.set('items', todos);
  try {
    scheduleTodoReminder(normalized);
  } catch (err) {
    console.warn('待辦提醒排程失敗，待辦仍已保存：', err.message);
  }
  return normalized;
});
handle('todo:delete', (id) => {
  const timer = todoReminderTimers.get(id);
  if (timer) clearTimeout(timer);
  todoReminderTimers.delete(id);
  todoStore.set('items', getTodos().filter((todo) => todo.id !== id));
  return true;
});
handle('notification:show', ({ title, body }) => showSystemNotification(title, body));
handle('notification:close-window', () => {
  if (notificationWindow && !notificationWindow.isDestroyed()) notificationWindow.close();
  return true;
});

handle('settings:set-project-path', (projectId, localPath) => {
  const projectPaths = settingsStore.get('projectPaths') || {};
  if (localPath) {
    projectPaths[String(projectId)] = localPath;
  } else {
    delete projectPaths[String(projectId)];
  }
  settingsStore.set('projectPaths', projectPaths);
  return projectPaths;
});

handle('eip:whoami', (override) => eipApi.whoami(override));
handle('sync:now', () => syncNow());

// 一鍵退出(共用電腦用)：先把還沒同步的個人資料推到後端，再清掉本機的帳密與個人資料、瀏覽器快取
// force=false時若有資料推不上去(例如離線)，先回報給畫面讓使用者決定要不要放棄這些資料強制退出
handle('auth:logout', async (force) => {
  const unsynced = await syncService.flush();
  if (unsynced.length && !force) return { ok: false, unsynced };

  syncService.clearLocal();
  clearTodoReminders();
  const mail = settingsStore.get('mail') || {};
  const llm = settingsStore.get('llm') || {};
  settingsStore.set('apiToken', '');
  settingsStore.set('mail', { ...mail, username: '', password: '' });
  // LLM：本機Ollama不需要真的金鑰(預設就是'ollama')，其他供應商的API Key清掉
  settingsStore.set('llm', { ...llm, apiKey: llm.provider === 'ollama' ? 'ollama' : '' });

  ticketWindows.forEach((win) => { if (!win.isDestroyed()) win.close(); });
  await session.defaultSession.clearStorageData();
  await session.defaultSession.clearCache();
  return { ok: true };
});
handle('eip:login', (username, password, override) => eipApi.login(username, password, override));
handle('eip:search-install-lists', (q) => eipApi.searchInstallLists(q));
handle('eip:get-install-list-by-project', (projectId) => eipApi.getInstallListByProject(projectId));
handle('eip:get-install-list', (id, ticketsBeforeId) => eipApi.getInstallList(id, ticketsBeforeId));
handle('eip:list-engineers', () => eipApi.listEngineers());
handle('eip:list-projects', (q, status, dept) => eipApi.listProjects(q, status, dept));
handle('eip:project-dept-transfer', (projectId, dept) => eipApi.projectDeptTransfer(projectId, dept));
handle('eip:project-payment-update', (projectId, period, status) => eipApi.projectPaymentUpdate(projectId, period, status));
handle('eip:project-payment-percent-save', (projectId, percents) => eipApi.projectPaymentPercentSave(projectId, percents));
handle('eip:list-tickets', (before, userId) => eipApi.listTickets(before, null, userId));
handle('eip:search-tickets', (q) => eipApi.searchTickets(q));
handle('eip:advanced-search-tickets', (filters) => eipApi.advancedSearchTickets(filters));
handle('eip:get-ticket-search-options', () => eipApi.getTicketSearchOptions());
handle('eip:get-ticket', (id) => eipApi.getTicket(id));
handle('eip:reply-ticket', (id, payload) => eipApi.replyTicket(id, payload));
handle('eip:transfer-ticket', (id, info, chgUserId, endTime) => eipApi.transferTicket(id, info, chgUserId, endTime));
handle('eip:update-ticket-version', (id, version) => eipApi.updateTicketVersion(id, version));
handle('eip:delete-ticket', (id, reason) => eipApi.deleteTicket(id, reason));
handle('eip:add-ticket-version', (name) => eipApi.addTicketVersion(name));
handle('eip:upload-file', (filePath) => eipApi.uploadFile(filePath));
handle('eip:attach-file', (id, fileId) => eipApi.attachFile(id, fileId));

function timerWithLive(ticketId) {
  const timer = timerService.getTimer(ticketId);
  return { ...timer, liveSeconds: timerService.liveSecondsOf(timer) };
}

handle('timer:get', (ticketId) => timerWithLive(ticketId));
// 一次拿全部工單的計時狀態，因為清單上可能同時有好幾張工單在跑，不用一張一張問
handle('timer:get-all', () => {
  const all = timerService.getAllTimers();
  const result = {};
  for (const ticketId of Object.keys(all)) {
    result[ticketId] = { ...all[ticketId], liveSeconds: timerService.liveSecondsOf(all[ticketId]) };
  }
  return result;
});
handle('timer:start', (ticketId) => {
  timerService.start(ticketId);
  return timerWithLive(ticketId);
});
handle('timer:pause', (ticketId) => {
  timerService.pause(ticketId);
  return timerWithLive(ticketId);
});
handle('timer:stop', (ticketId) => timerService.stop(ticketId));
handle('timer:reset', (ticketId) => timerService.reset(ticketId));
handle('timer:set-manual', (ticketId, params) => {
  timerService.setManual(ticketId, params);
  return timerWithLive(ticketId);
});
handle('timer:clear-manual', (ticketId) => {
  timerService.clearManual(ticketId);
  return timerWithLive(ticketId);
});

handle('git:collect-changes', (sinceIso, projectId) => gitService.collectChanges(sinceIso, projectId));
handle('git:resolve-path', (projectId) => gitService.resolveRepoPath(projectId));
handle('git:list-commits', (projectId, limit) => gitService.listCommits(projectId, limit));
handle('git:get-commits-detail', (projectId, hashes) => gitService.getCommitsDetail(projectId, hashes));
handle('git:get-commit-files', (projectId, hash) => gitService.getCommitFiles(projectId, hash));
handle('git:get-commit-file-diff', (projectId, hash, filePath) => gitService.getCommitFileDiff(projectId, hash, filePath));
handle('git:commit',(projectId, message) => gitService.commitAll(projectId, message));

handle('llm:generate-reply', (params) => llmService.generateTicketReply(params));
handle('llm:generate-batch-reply', (params) => llmService.generateBatchReply(params));

handle('mail:list-recent', (limit, override) => mailService.listRecent(limit, override));
handle('mail:get-message', (uid) => mailService.getMessage(uid));
handle('mail:save-attachment', async (uid, index) => {
  const { dialog } = require('electron');
  const att = await mailService.getAttachment(uid, index);
  // 檔名來自寄件者，去掉路徑與Windows不允許的字元，避免存到非預期的位置
  const safeName = path.basename(att.filename).replace(/[\\/:*?"<>|]/g, '_');
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('downloads'), safeName),
  });
  if (result.canceled || !result.filePath) return null;
  await fs.promises.writeFile(result.filePath, att.content);
  shell.showItemInFolder(result.filePath);
  return result.filePath;
});

handle('calendar:list-range', (startIso, endIso) => calendarService.listEventsInRange(startIso, endIso));
handle('calendar:create-event', (params) => calendarService.createEvent(params));
handle('calendar:update-event', (params) => calendarService.updateEvent(params));
handle('calendar:delete-event', (params) => calendarService.deleteEvent(params));

handle('site:ping', (host) => siteService.pingHost(host));

handle('clipboard:copy', (text) => {
  clipboard.writeText(String(text));
  return true;
});

handle('shell:open-external', (url) => shell.openExternal(url));

handle('window:open-ticket', (ticketId) => openTicketWindow(ticketId));
// 獨立工單視窗按「查看案場/專案/回覆」：把主視窗叫到前面，交給主視窗切換畫面
// target: 'site' | 'project'(id=專案id) | 'reply'(id=工單id，在左側開工單詳情回覆)
handle('window:jump-in-main', (target, id) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('window:jump', { target, id });
  return true;
});

handle('dialog:pick-file', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});
