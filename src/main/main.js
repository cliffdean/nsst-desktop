const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, clipboard, shell, screen } = require('electron');
const path = require('path');

const { settingsStore, ticketMetaStore, todoStore } = require('./store');
const eipApi = require('./eipApi');
const timerService = require('./timerService');
const gitService = require('./gitService');
const llmService = require('./llmService');
const mailService = require('./mailService');
const calendarService = require('./calendarService');
const siteService = require('./siteService');

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
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // 這是工具程式不是網頁瀏覽器，不需要File/Edit/View那排選單
  createWindow();
  createTray();
  registerHotkey(settingsStore.get('hotkey'));
  getTodos().forEach(scheduleTodoReminder);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
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

handle('settings:get', () => settingsStore.store);
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

handle('ticket-meta:get-type', (ticketId) => ticketMetaStore.get(String(ticketId), ''));
handle('ticket-meta:set-type', (ticketId, type) => {
  if (type) {
    ticketMetaStore.set(String(ticketId), type);
  } else {
    ticketMetaStore.delete(String(ticketId));
  }
  return type;
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
    completed,
    completedAt,
    updatedAt: new Date().toISOString(),
  };
  if (!normalized.title) throw new Error('待辦事項內容不可為空');
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

handle('eip:whoami', () => eipApi.whoami());
handle('eip:login', (username, password) => eipApi.login(username, password));
handle('eip:search-install-lists', (q) => eipApi.searchInstallLists(q));
handle('eip:get-install-list-by-project', (projectId) => eipApi.getInstallListByProject(projectId));
handle('eip:get-install-list', (id, ticketsBeforeId) => eipApi.getInstallList(id, ticketsBeforeId));
handle('eip:list-engineers', () => eipApi.listEngineers());
handle('eip:list-tickets', (before, userId) => eipApi.listTickets(before, null, userId));
handle('eip:search-tickets', (q) => eipApi.searchTickets(q));
handle('eip:advanced-search-tickets', (filters) => eipApi.advancedSearchTickets(filters));
handle('eip:get-ticket-search-options', () => eipApi.getTicketSearchOptions());
handle('eip:get-ticket', (id) => eipApi.getTicket(id));
handle('eip:reply-ticket', (id, payload) => eipApi.replyTicket(id, payload));
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

handle('mail:list-recent', (limit) => mailService.listRecent(limit));
handle('mail:get-message', (uid) => mailService.getMessage(uid));

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

handle('dialog:pick-file', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});
