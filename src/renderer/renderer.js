const state = {
  settings: null,
  currentUserId: null,
  canTransferTicket: false, // 身份是「專管」才會是true，決定要不要顯示轉單按鈕
  canEditAnyTicket: false, // 專管：可以回覆/附檔不是指派給自己的工單
  canDeleteTicket: false, // 專管：可以刪除工單
  tickets: [],
  currentTicket: null,
  currentTicketSearchDetail: null, // 右側工單查詢目前顯示的那張工單，給複製工單號／跳去裝機單查詢用
  timers: {}, // { [ticketId]: { status, segments } }，本地算秒數用，不用每秒都問main process
  tickInterval: null,
  selectedIds: new Set(), // 批次提交用的多選狀態
  searchQuery: '',
  ticketRange: 'week', // 左側清單的時間範圍：'week'=本週五以前(後端預設)，'next'=下週五以前(週六日派單時用)，'all'=全部未結案(不限開始日期)
  projectView: null, // 專案工單檢視模式：{ project, filters, label }；左側清單暫時改列某專案的工單(給專管分配用)
  activeTab: 'normal', // 'normal'=待處理(assigned等) / 'qc'=品保中，分開避免QC單淹沒真正要處理的工單
  viewUserId: null, // 左側清單目前在看哪位工程師的工單；null=自己(每次開App都從自己開始，不記憶)
  engineers: [],
  pendingFileIds: [], // 詳情頁「上傳並附加到工單」暫存的file id，等送出回覆時一起帶上去
  todos: [],
  starredProjects: new Set(), // 加星關注的專案id(字串)，純本地功能，不回寫EIP
  advSearch: {
    formVisible: false, // 進階搜尋「表單」是否展開；純UI狀態，收合表單不影響目前是否套用了進階條件
    active: false, // 是否已套用進階條件(搜尋走advanced-search API、上面的簡易搜尋框停用、顯示條件標籤)；收合表單不會動到這個值
    optionsLoaded: false,
    site: null, // { id, name } 或 null
    fields: ['summary', 'description', 'keyword', 'reply', 'project_name', 'user_name', 'customer', 'dealer'],
    page: 1,
    perPage: 20,
    lastMeta: null,
  },
  refreshSnapshot: {
    initialized: false,
    mailIds: new Set(),
    ticketIds: new Set(),
    calendarIds: new Set(),
  },
  calendar: {
    year: new Date().getFullYear(),
    month: new Date().getMonth(), // 0-based
    events: [],
    calendars: [],
    dataSignature: '',
    selectedDayEvents: [],
    editingEvent: null, // 有值代表目前表單是「編輯這一筆」，null代表「新增」
    selectedDate: dateKey(new Date()),
  },
};

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

initMediaPreview();


function showAppNotification(data) {
  $('app-notification-title').textContent = data.title || '通知';
  $('app-notification-body').textContent = data.body || '';
  $('app-notification').classList.remove('hidden');
}

// 跟main process的timerService.liveSecondsOf邏輯一致：已完成區段加總，運行中的那段即時累加，暫停的時間不算
function liveSecondsOf(timer) {
  if (!timer || !timer.segments) return 0;
  let total = timer.manual ? timer.manual.seconds : 0;
  for (const seg of timer.segments) {
    if (seg.end) {
      total += Math.max(0, (new Date(seg.end).getTime() - new Date(seg.start).getTime()) / 1000);
    }
  }
  if (timer.status === 'running') {
    const openSeg = timer.segments[timer.segments.length - 1];
    if (openSeg && !openSeg.end) {
      total += Math.max(0, (Date.now() - new Date(openSeg.start).getTime()) / 1000);
    }
  }
  return total;
}

// ---------------- 設定 ----------------

async function loadSettingsIntoForm() {
  const settings = await call(window.api.settings.get());
  if (!settings) return;
  state.settings = settings;
  $('set-eip-url').value = settings.eipBaseUrl || '';
  $('set-api-token').value = settings.apiToken || '';
  $('set-git-path').value = settings.gitRepoPath || '';
  $('set-hotkey').value = settings.hotkey || '';
  $('set-llm-provider').value = settings.llm.provider || 'ollama';
  $('set-llm-baseurl').value = settings.llm.baseURL || '';
  $('set-llm-apikey').value = settings.llm.apiKey || '';
  $('set-llm-model').value = settings.llm.model || '';
  $('set-mail-username').value = settings.mail.username || '';
  $('set-mail-password').value = settings.mail.password || '';
  $('set-mail-imap-host').value = settings.mail.imapHost || '';
  $('set-mail-imap-port').value = settings.mail.imapPort || 993;
  $('set-mail-imap-insecure').checked = !!settings.mail.imapAllowInsecureTLS;
  $('set-mail-calendar-url').value = settings.mail.calendarUrl || '';

  const templates = settings.replyTemplates || {};
  $('tpl-bug').value = templates.bug || '';
  $('tpl-feature').value = templates.feature || '';
  $('tpl-optimize').value = templates.optimize || '';
  $('tpl-inquiry').value = templates.inquiry || '';
  $('tpl-other').value = templates.other || '';

  renderProjectPathsList(settings.projectPaths || {});

  const activeHotkey = await call(window.api.settings.getActiveHotkey());
  $('hotkey-active-hint').textContent = activeHotkey
    ? `目前實際生效中：${activeHotkey}`
    : '目前沒有任何快捷鍵生效';
}

function renderProjectPathsList(projectPaths) {
  const entries = Object.entries(projectPaths);
  if (!entries.length) {
    $('project-paths-list').innerHTML = '<p style="color:#888;font-size:12px;">目前還沒有設定任何專案路徑</p>';
    return;
  }
  $('project-paths-list').innerHTML = entries
    .map(
      ([projectId, path]) => `
      <div class="project-path-row" data-project-id="${projectId}">
        <span class="project-path-id">專案#${projectId}</span>
        <input type="text" class="project-path-input" value="${escapeHtml(path)}" />
        <button class="btn-save-path-row">儲存</button>
        <button class="btn-remove-path-row">刪除</button>
      </div>`
    )
    .join('');

  $('project-paths-list').querySelectorAll('.btn-save-path-row').forEach((el) => {
    el.addEventListener('click', async () => {
      const row = el.closest('.project-path-row');
      const projectId = row.dataset.projectId;
      const newPath = row.querySelector('.project-path-input').value.trim();
      await call(window.api.settings.setProjectPath(projectId, newPath));
      state.settings = await call(window.api.settings.get());
    });
  });
  $('project-paths-list').querySelectorAll('.btn-remove-path-row').forEach((el) => {
    el.addEventListener('click', async () => {
      const row = el.closest('.project-path-row');
      const projectId = row.dataset.projectId;
      if (!confirm(`確定要刪除專案#${projectId}的路徑設定嗎？`)) return;
      await call(window.api.settings.setProjectPath(projectId, ''));
      state.settings = await call(window.api.settings.get());
      renderProjectPathsList(state.settings.projectPaths || {});
    });
  });
}

// 把瀏覽器的KeyboardEvent轉成Electron的accelerator字串格式(例如 CommandOrControl+Alt+T)
function keyEventToAccelerator(e) {
  const specialKeyNames = {
    ' ': 'Space',
    Escape: 'Esc',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Enter: 'Return',
    Delete: 'Delete',
    Backspace: 'Backspace',
    Tab: 'Tab',
    '+': 'Plus',
  };
  const modifierKeys = ['Control', 'Alt', 'Shift', 'Meta'];
  if (modifierKeys.includes(e.key)) {
    return null; // 只按了修飾鍵，還沒按到主要按鍵，先不處理
  }

  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  let mainKey = specialKeyNames[e.key];
  if (!mainKey) {
    mainKey = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  }
  parts.push(mainKey);

  return parts.join('+');
}

function onHotkeyCapture(e) {
  e.preventDefault();
  const accelerator = keyEventToAccelerator(e);
  if (accelerator) {
    $('set-hotkey').value = accelerator;
  }
}

async function saveSettings() {
  const patch = {
    eipBaseUrl: $('set-eip-url').value.trim(),
    apiToken: $('set-api-token').value.trim(),
    gitRepoPath: $('set-git-path').value.trim(),
    hotkey: $('set-hotkey').value.trim(),
    llm: {
      provider: $('set-llm-provider').value,
      baseURL: $('set-llm-baseurl').value.trim(),
      apiKey: $('set-llm-apikey').value.trim(),
      model: $('set-llm-model').value.trim(),
    },
    mail: {
      username: $('set-mail-username').value.trim(),
      password: $('set-mail-password').value,
      calendarUrl: $('set-mail-calendar-url').value.trim(),
      imapHost: $('set-mail-imap-host').value.trim(),
      imapPort: parseInt($('set-mail-imap-port').value, 10) || 993,
      imapSecure: true,
      imapAllowInsecureTLS: $('set-mail-imap-insecure').checked,
    },
    replyTemplates: {
      bug: $('tpl-bug').value,
      feature: $('tpl-feature').value,
      optimize: $('tpl-optimize').value,
      inquiry: $('tpl-inquiry').value,
      other: $('tpl-other').value,
    },
  };
  const settings = await call(window.api.settings.save(patch), async (err) => {
    $('settings-message').textContent = '儲存失敗：' + err;
    // 快捷鍵註冊失敗時main process會恢復成原本的值，這裡把畫面同步回真正生效的狀態，避免顯示跟實際不一致
    const activeHotkey = await call(window.api.settings.getActiveHotkey());
    $('set-hotkey').value = activeHotkey || '';
  });
  if (settings) {
    state.settings = settings;
    const activeHotkey = await call(window.api.settings.getActiveHotkey());
    $('settings-message').textContent = activeHotkey
      ? `已儲存，目前生效的快捷鍵：${activeHotkey}`
      : '已儲存(目前沒有設定快捷鍵)';
  }
}

async function doLogin() {
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  if (!username || !password) {
    $('login-message').textContent = '請輸入帳號密碼';
    return;
  }
  const baseUrl = $('set-eip-url').value.trim();
  if (!baseUrl) {
    $('login-message').textContent = '請先填EIP API網址';
    return;
  }
  $('login-message').textContent = '登入中...';
  // 用畫面上填的網址登入，成功才一起儲存(登入失敗不會把錯的網址存進設定)
  const result = await call(window.api.eip.login(username, password, { baseUrl }), (err) => {
    $('login-message').textContent = `登入失敗(連線網址：${baseUrl})：${err}`;
  });
  if (!result) return;

  $('set-api-token').value = result.token;
  $('login-password').value = '';
  await saveSettings();
  $('login-message').textContent = `登入成功，已取得新Token(使用者：${result.user.name})`;
}

// 一鍵退出(共用電腦用)：主程序會先把待辦/加星等個人資料推到EIP後端，再清掉本機帳密與個人資料，下次登入自動拿回來
async function doLogout() {
  if (!confirm('確定要退出嗎？\n\n會清除這台電腦上的EIP Token、信箱帳密、LLM API Key，以及待辦、加星專案、計時等個人資料(已同步到EIP，下次登入會自動拿回來)。')) return;
  $('settings-message').textContent = '同步並退出中...';
  let result = await call(window.api.auth.logout(false), (err) => {
    $('settings-message').textContent = '退出失敗：' + err;
  });
  if (!result) return;
  if (!result.ok) {
    const keys = result.unsynced.join('、');
    if (!confirm(`有資料還沒同步到EIP後端(${keys})，可能是目前連不到伺服器。
強制退出的話，這些沒同步的變動會遺失，確定要強制退出嗎？`)) {
      $('settings-message').textContent = '已取消退出';
      return;
    }
    result = await call(window.api.auth.logout(true), (err) => {
      $('settings-message').textContent = '退出失敗：' + err;
    });
    if (!result) return;
  }
  location.reload(); // 整個畫面重新載入，回到未登入狀態，不留任何前一個人的畫面資料
}

// 設定畫面的原則：測試一律用「畫面上現在填的值」，測試成功再儲存，不用先存才能測
function eipFormValues() {
  return { baseUrl: $('set-eip-url').value.trim(), token: $('set-api-token').value.trim() };
}

function settingsDiffer(keys) {
  const saved = state.settings || {};
  return keys.some((k) => String(saved[k] || '') !== String(({ eipBaseUrl: $('set-eip-url').value.trim(), apiToken: $('set-api-token').value.trim() })[k] || ''));
}

async function testConnection() {
  $('settings-message').textContent = '測試中...';
  const form = eipFormValues();
  const data = await call(window.api.eip.whoami(form), (err) => {
    $('settings-message').textContent = `連線失敗(網址：${form.baseUrl})：${err}`;
  });
  if (data) {
    const unsaved = settingsDiffer(['eipBaseUrl', 'apiToken']);
    $('settings-message').textContent = `連線成功，登入身分：${data.name} (id=${data.id})${unsaved ? '　→ 確認無誤請按「儲存設定」套用' : ''}`;
  }
}

function mailFormValues() {
  return {
    username: $('set-mail-username').value.trim(),
    password: $('set-mail-password').value,
    imapHost: $('set-mail-imap-host').value.trim(),
    imapPort: parseInt($('set-mail-imap-port').value, 10) || 993,
    imapAllowInsecureTLS: $('set-mail-imap-insecure').checked,
  };
}

async function testMailConnection() {
  $('settings-message').textContent = '測試信箱連線中...';
  const result = await call(window.api.mail.listRecent(5, mailFormValues()), (err) => {
    $('settings-message').textContent = '信箱連線失敗：' + err;
  });
  if (result) {
    const saved = (state.settings && state.settings.mail) || {};
    const form = mailFormValues();
    const unsaved = ['username', 'password', 'imapHost', 'imapPort', 'imapAllowInsecureTLS'].some((k) => String(saved[k] || '') !== String(form[k] || ''));
    $('settings-message').textContent = `信箱連線成功，共${result.messages.length}封(未讀${result.unseenCount}封)${unsaved ? '　→ 確認無誤請按「儲存設定」套用' : ''}`;
  }
}

// ---------------- 信箱 ----------------

function renderMailList(result) {
  const badge = $('mail-unread-badge');
  if (result.unseenCount > 0) {
    badge.textContent = result.unseenCount;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  if (!result.messages.length) {
    $('mail-list').innerHTML = '<p style="color:#888;">目前沒有信件</p>';
    return;
  }
  $('mail-list').innerHTML = result.messages
    .map((m) => {
      const date = m.date ? new Date(m.date).toLocaleString('zh-Hant') : '';
      return `<div class="mail-item ${m.seen ? '' : 'unread'}" data-uid="${m.uid}">
        <span class="mail-date">${date}</span>
        <span class="mail-from">${escapeHtml(m.from)}</span>${escapeHtml(m.subject)}
      </div>`;
    })
    .join('');

  $('mail-list').querySelectorAll('.mail-item').forEach((el) => {
    el.addEventListener('click', () => openMailDetail(el.dataset.uid));
  });
}

// 已完成的待辦，只在勾選完成當天繼續顯示；隔天(日期不同)就從主清單消失，但資料還在，可以到歷史紀錄找
function isTodoVisibleToday(todo) {
  if (!todo.completed) return true;
  if (!todo.completedAt) return true; // 舊資料沒有completedAt，保守顯示，避免突然憑空消失
  const completedDate = new Date(todo.completedAt);
  const now = new Date();
  return (
    completedDate.getFullYear() === now.getFullYear() &&
    completedDate.getMonth() === now.getMonth() &&
    completedDate.getDate() === now.getDate()
  );
}

// 同 store.js 的 SCREEN_TODO_LIMIT：最多幾筆待辦可以顯示在電子紙上
const SCREEN_TODO_LIMIT = 4;

function renderTodoList() {
  const list = $('todo-list');
  const todos = [...state.todos]
    .filter(isTodoVisibleToday)
    .sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (a.reminderAt || '').localeCompare(b.reminderAt || '');
    });
  const screenFull = state.todos.filter((t) => t.onScreen && !t.completed).length >= SCREEN_TODO_LIMIT;
  list.innerHTML = todos.length ? todos.map((todo) => `
    <div class="todo-item ${todo.completed ? 'completed' : ''} ${todo.pinned ? 'pinned' : ''}" data-todo-id="${escapeHtml(todo.id)}">
      <input type="checkbox" class="todo-check" ${todo.completed ? 'checked' : ''} />
      <span class="todo-title">${escapeHtml(todo.title)}</span>
      ${todo.reminderAt ? `<span class="todo-due">提醒 ${escapeHtml(new Date(todo.reminderAt).toLocaleString('zh-Hant'))}</span>` : ''}
      ${todo.completed ? '' : `<label class="todo-screen-input" title="勾選後顯示在電子紙看板(最多${SCREEN_TODO_LIMIT}筆)"><input type="checkbox" class="todo-screen-check" ${todo.onScreen ? 'checked' : ''} ${!todo.onScreen && screenFull ? 'disabled' : ''} /> 屏幕</label>`}
      <span class="todo-actions"><button class="btn-edit-todo">編輯</button><button class="btn-delete-todo">刪除</button></span>
    </div>`).join('') : '<p style="color:#888;">目前沒有待辦事項</p>';
}

async function loadTodos() {
  const todos = await call(window.api.todo.list());
  if (todos) {
    state.todos = todos;
    renderTodoList();
  }
}

function resetTodoForm() {
  $('todo-edit-id').value = '';
  $('todo-title').value = '';
  $('todo-reminder').value = '';
  $('todo-pinned').checked = false;
  $('todo-message').textContent = '';
  $('todo-form').classList.add('hidden');
}

function reminderInputValue(reminderAt) {
  if (!reminderAt) return '';
  const date = new Date(reminderAt);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function openTodoForm(todo) {
  $('todo-edit-id').value = todo ? todo.id : '';
  $('todo-title').value = todo ? todo.title : '';
  $('todo-reminder').value = todo ? reminderInputValue(todo.reminderAt) : '';
  $('todo-pinned').checked = !!todo?.pinned;
  $('todo-form').classList.remove('hidden');
  $('todo-title').focus();
}

async function saveTodo(completedOverride) {
  const button = $('btn-save-todo');
  const message = $('todo-message');
  const id = $('todo-edit-id').value;
  const existing = state.todos.find((todo) => todo.id === id);
  button.disabled = true;
  button.textContent = '儲存中...';
  message.textContent = '';
  try {
    const saved = await call(window.api.todo.save({
      id: id || undefined,
      title: $('todo-title').value,
      reminderAt: $('todo-reminder').value,
      pinned: $('todo-pinned').checked,
      completed: completedOverride === undefined ? !!existing?.completed : completedOverride,
    }), (err) => {
      message.textContent = `儲存失敗：${err}`;
    });
    if (!saved) return;
    const index = state.todos.findIndex((todo) => todo.id === saved.id);
    if (index >= 0) state.todos[index] = saved;
    else state.todos.push(saved);
    renderTodoList();
    resetTodoForm();
  } catch (err) {
    message.textContent = `儲存失敗：${err.message || err}`;
  } finally {
    button.disabled = false;
    button.textContent = '儲存';
  }
}

async function deleteTodo(id) {
  if (!confirm('確定要刪除這筆待辦事項嗎？')) return;
  const deleted = await call(window.api.todo.delete(id), (err) => alert('刪除待辦失敗：' + err));
  if (!deleted) return;
  state.todos = state.todos.filter((todo) => todo.id !== id);
  renderTodoList();
}

// ---------------- 待辦歷史查詢(已完成的待辦，含隔天後從主清單消失的那些) ----------------

function openTodoHistory() {
  $('todo-history-search').value = '';
  renderTodoHistory('');
  $('todo-history-backdrop').classList.remove('hidden');
  $('todo-history-search').focus();
}

function closeTodoHistory() {
  $('todo-history-backdrop').classList.add('hidden');
}

function renderTodoHistory(keyword) {
  const kw = (keyword || '').trim().toLowerCase();
  const items = state.todos
    .filter((todo) => todo.completed)
    .filter((todo) => !kw || todo.title.toLowerCase().includes(kw))
    .sort((a, b) => (b.completedAt || b.updatedAt || '').localeCompare(a.completedAt || a.updatedAt || ''));
  $('todo-history-list').innerHTML = items.length
    ? items
        .map(
          (todo) => `<div class="todo-item completed">
            <span class="todo-title">${escapeHtml(todo.title)}</span>
            <span class="todo-due">完成於 ${todo.completedAt ? escapeHtml(new Date(todo.completedAt).toLocaleString('zh-Hant')) : '-'}</span>
          </div>`
        )
        .join('')
    : '<p style="color:#888;">沒有符合的歷史待辦</p>';
}

// ---------------- 裝機單(案場)查詢 ----------------

let installSearchTimer = null;

// 裝機單查詢顯示在右側欄，跟信箱/行事曆/工單查詢互斥切換，左邊工單清單不受影響、隨時看得到
function openInstallPanel() {
  // 工單詳情跟裝機單現在分別在左右兩欄，互不影響，可以同時對照著看
  $('sidebar-default-view').classList.add('hidden');
  // 工單查詢/裝機單查詢/專案查詢共用右側欄位置，畫面互斥，開其中一個要先關掉其他的，不然會疊在一起打架
  $('ticket-search-panel').classList.add('hidden');
  $('project-panel').classList.add('hidden');
  $('install-panel').classList.remove('hidden');
  $('install-panel').classList.remove('has-detail');
  $('install-search').value = '';
  $('install-search-results').innerHTML = '<p style="color:#888;">輸入關鍵字搜尋案場，或直接看下面全部</p>';
  $('install-detail').classList.add('hidden');
  $('install-search').focus();
  runInstallSearch('');
}

function closeInstallPanel() {
  $('install-panel').classList.add('hidden');
  $('sidebar-default-view').classList.remove('hidden');
}

// 只收起下面的案場詳情，列表與搜尋條件維持原樣，列表區還原成整頁高度
function closeInstallDetail() {
  $('install-panel').classList.remove('has-detail');
  $('install-detail').classList.add('hidden');
}

async function runInstallSearch(q) {
  const results = await call(window.api.eip.searchInstallLists(q), (err) => {
    $('install-search-results').innerHTML = `<p style="color:#d84f4f;">搜尋失敗：${err}</p>`;
  });
  if (!results) return;
  if (!results.length) {
    $('install-search-results').innerHTML = '<p style="color:#888;">沒有符合的案場</p>';
    return;
  }
  $('install-search-results').innerHTML = results
    .map(
      (r) => `<div class="install-card" data-id="${r.id}">
        <div class="install-name">${r.name || '(無名稱)'} <span style="color:#888;font-weight:normal;">${r.code || ''}</span></div>
        <div style="color:#555;">${r.address || ''}</div>
        <div style="color:#888;font-size:12px;">聯絡人：${r.contact || '-'}　電話：${r.phone || '-'}　專案：${r.project_name || '-'}</div>
      </div>`
    )
    .join('');
  $('install-search-results').querySelectorAll('.install-card').forEach((el) => {
    el.addEventListener('click', () => openInstallDetail(el.dataset.id));
  });
}

async function openInstallDetail(id) {
  $('install-panel').classList.add('has-detail'); // 選了案場後，搜尋結果縮小、把空間讓給詳細內容
  $('install-detail').classList.remove('hidden');
  $('install-detail-name').textContent = '讀取中...';
  const data = await call(window.api.eip.getInstallList(id), (err) => alert('讀取案場資料失敗：' + err));
  if (!data) return;

  state.currentInstallList = data;
  $('install-detail-name').textContent = `${data.name || ''} (${data.code || ''})`;
  $('btn-install-jump-to-project').classList.toggle('hidden', !data.project_id);
  const basicRows = [
    ['地址', data.address],
    ['聯絡人', data.contact],
    ['電話', data.phone],
    ['業主', data.owner],
    ['所屬專案', data.project_name],
  ];
  $('install-detail-basic').innerHTML = basicRows
    .map(([label, value]) => `<span class="info-label">${label}</span><span class="info-value">${value || '-'}</span>`)
    .join('');

  const c = data.connection;
  if (!c) {
    $('install-detail-connection').innerHTML = '<p style="color:#888;">這個案場沒有填寫連線設定</p>';
  } else {
    // 點一下儲存格直接複製到剪貼簿；密碼也直接顯示(EIP網頁本來就看得到，遮蔽會分不出是空的還是有值)，公網/連結類的多留一個開啟按鈕
    const copyCell = (value) =>
      `<td class="copy-cell" data-value="${encodeURIComponent(value || '')}">${value ? escapeHtml(value) : '-'}</td>`;

    $('install-detail-connection').innerHTML = `
      <table class="conn-table">
        <tr><th>項目</th><th>內容</th><th></th></tr>
        <tr><td>內網IP</td>${copyCell(c.ip_address_in)}<td><button class="btn-ping" data-target="ip_address_in">測試連線</button></td></tr>
        <tr><td>外網IP</td>${copyCell(c.ip_address_out)}<td><button class="btn-ping" data-target="ip_address_out">測試連線</button></td></tr>
        <tr><td>現場連結</td>${copyCell(c.url)}<td>${c.url ? '<button class="btn-open-link" data-url="' + encodeURIComponent(c.url) + '">開啟</button>' : ''}</td></tr>
      </table>
      <table class="conn-table">
        <tr><th>項目</th><th>帳號</th><th>密碼</th></tr>
        <tr><td>SSH</td>${copyCell(c.ssh_un)}${copyCell(c.ssh_pw)}</tr>
        <tr><td>DB</td>${copyCell(c.db_un)}${copyCell(c.db_pw)}</tr>
        <tr><td>TeamViewer</td>${copyCell(c.tv_un)}${copyCell(c.tv_pw)}</tr>
        <tr><td>AnyDesk</td>${copyCell(c.ad_un)}${copyCell(c.ad_pw)}</tr>
        <tr><td>Windows</td>${copyCell(c.wd_un)}${copyCell(c.wd_pw)}</tr>
        <tr><td>物業</td>${copyCell(c.username)}${copyCell(c.password)}</tr>
      </table>
      ${c.memo ? `<p><strong>備註：</strong><br>${escapeHtmlPreserveNewlines(c.memo)}</p>` : ''}
      <p style="color:#888;font-size:11px;">點一下欄位內容即可複製到剪貼簿；連線測試是用你自己這台電腦去ping，通常要接公司VPN才測得到</p>
    `;
    $('install-detail-connection').querySelectorAll('.copy-cell').forEach((el) => {
      el.addEventListener('click', () => {
        const value = decodeURIComponent(el.dataset.value);
        if (!value) return;
        window.api.clipboard.copy(value);
        const original = el.textContent;
        el.textContent = '已複製';
        setTimeout(() => {
          el.textContent = original;
        }, 800);
      });
    });
    $('install-detail-connection').querySelectorAll('.btn-ping').forEach((el) => {
      el.addEventListener('click', () => pingSite(c[el.dataset.target], el));
    });
    $('install-detail-connection').querySelectorAll('.btn-open-link').forEach((el) => {
      el.addEventListener('click', () => window.api.shell.openExternal(decodeURIComponent(el.dataset.url)));
    });
  }

  renderInstallDetailTickets(data.recent_tickets || [], data.recent_tickets_has_more);
}

// 相關工單一列一筆，帶上負責人員(=一般認知的「這張工單是誰完成的」)，並依recent_tickets_has_more決定要不要顯示「載入更早的工單」
function renderInstallDetailTickets(tickets, hasMore) {
  $('install-detail-tickets').innerHTML = tickets.length
    ? tickets
        .map(
          (t) => `<div class="mini-ticket-row mini-ticket-link" data-id="${t.id}">#${t.id} ${escapeHtml(t.summary || '')}${
            t.p_user_name ? `　<span class="meta">完成人：${escapeHtml(t.p_user_name)}</span>` : ''
          }${t.version_text ? `　<span class="meta">版本：${escapeHtml(t.version_text)}</span>` : ''}</div>`
        )
        .join('')
    : '<p style="color:#888;">沒有找到相關工單</p>';
  // 點了另開一個獨立視窗顯示該工單完整詳情，不佔用左側正在處理的工單，可以同時開好幾張對照
  $('install-detail-tickets').querySelectorAll('.mini-ticket-link').forEach((el) => {
    el.addEventListener('click', () => call(window.api.window.openTicket(el.dataset.id)));
  });
  $('btn-install-tickets-more').classList.toggle('hidden', !tickets.length || !hasMore);
}

// 用目前列表最後一筆工單的id當游標，往回抓更舊的一批，接在後面(累加，不是重置)
async function loadMoreInstallTickets() {
  const data = state.currentInstallList;
  const tickets = data && data.recent_tickets;
  if (!data || !tickets || !tickets.length) return;

  const btn = $('btn-install-tickets-more');
  btn.disabled = true;
  btn.textContent = '載入中...';
  const more = await call(window.api.eip.getInstallList(data.id, tickets[tickets.length - 1].id), (err) =>
    alert('載入更多工單失敗：' + err)
  );
  btn.disabled = false;
  btn.textContent = '載入更早的工單';
  if (!more) return;

  data.recent_tickets = tickets.concat(more.recent_tickets || []);
  data.recent_tickets_has_more = more.recent_tickets_has_more;
  renderInstallDetailTickets(data.recent_tickets, data.recent_tickets_has_more);
}

async function pingSite(ip, btnEl) {
  $('install-ping-result').textContent = `測試連線中(${ip})...`;
  const result = await call(window.api.site.ping(ip));
  if (!result) return;
  $('install-ping-result').textContent = result.reachable
    ? `✅ ${ip} 連線正常 — ${result.detail}`
    : `❌ ${ip} 連不上 — ${result.detail}`;
}

// 左側工單詳情、右側工單查詢詳情共用：跳去看這個專案的裝機單(案場)資訊
async function jumpToInstallListByProject(projectId) {
  if (!projectId) return;
  const results = await call(window.api.eip.getInstallListByProject(projectId), (err) =>
    alert('查詢失敗：' + err)
  );
  if (!results) return;
  if (!results.length) {
    alert('這個專案目前沒有對應的裝機單資料');
    return;
  }
  openInstallPanel();
  openInstallDetail(results[0].id);
}

async function jumpToSiteFromTicket() {
  if (!state.currentTicket) return;
  jumpToInstallListByProject(state.currentTicket.project_id);
}

// ---------------- 專案查詢(對應EIP「建立專案」頁的專案清單與流程進度) ----------------

let projectSearchTimer = null;
let projectSearchSeq = 0; // 連續打字會發出好幾次搜尋，只採用最後一次的結果，避免晚回來的舊結果蓋掉新的
let projectTicketsSeq = 0;
// selected = { projectId, stage }，stage為null代表全部階段；ticketStatusFilter是目前勾選的工單狀態代碼集合(可複選，空集合=不篩選)
// dept：目前所在部門篩選，''=全部、engineering(含退回工程部)、finance
// starOnly：只看加星的專案(依加星清單逐一用專案編號查詢，不受「最新300筆」限制，狀態/所在部門/關鍵字篩選仍然有效)
const projectPanel = { status: '1', dept: '', starOnly: false, projects: [], selected: null, ticketStatusFilter: new Set() };

// 工單狀態篩選按鈕，對照EIP網頁manage/internal/InternalController的$h_status/$h_colors(不含9已刪除，這個列表本來就排除已刪除)
const TICKET_STATUS_OPTIONS = [
  [0, '新任務', 'status-danger'],
  [1, '已指派', 'status-warning'],
  [2, '已完成', 'status-success'],
  [3, '已暫停', 'status-info'],
  [4, '成功', 'status-success'],
  [5, '失敗', 'status-info'],
  [6, '未定義', 'status-info'],
  [7, '追蹤中', 'status-danger'],
  [8, '已關閉', 'status-default'],
  [10, '品保中', 'status-qc'],
];

// 專案狀態配色沿用EIP網頁：未進行灰、進行中橘、已完成綠、取消/終止紅
const PROJECT_STATUS_CLASS = { default: 'status-default', warning: 'status-warning', success: 'status-success', danger: 'status-danger' };

// skipInitialSearch=true時不要先撈一次預設清單，讓呼叫端(jumpToProject)自己帶條件查
async function openProjectPanel(skipInitialSearch = false) {
  $('sidebar-default-view').classList.add('hidden');
  $('install-panel').classList.add('hidden');
  $('ticket-search-panel').classList.add('hidden');
  $('project-panel').classList.remove('hidden');
  closeProjectTickets();
  $('project-search').focus();
  await loadStarredProjects();
  if (!skipInitialSearch) runProjectSearch();
}

// 工單詳情／工單查詢詳情／裝機單共用：跳去專案查詢看這個專案。專案可能已完成或取消，所以狀態切成「全部」，
// 用專案編號搜尋後框起並捲到那張卡片(關鍵字是模糊比對，同時搜到其他專案也沒關係)
async function jumpToProject(projectId) {
  if (!projectId) return;
  await openProjectPanel(true);
  projectPanel.status = '';
  projectPanel.dept = '';
  document.querySelectorAll('.project-status-btn').forEach((el) => el.classList.toggle('active', el.dataset.status === ''));
  document.querySelectorAll('.project-dept-btn').forEach((el) => el.classList.toggle('active', el.dataset.dept === ''));
  $('project-search').value = String(projectId);
  await runProjectSearch();
  const card = $('project-results').querySelector(`.project-card[data-id="${projectId}"]`);
  if (!card) {
    alert(`在專案查詢裡找不到專案#${projectId}`);
    return;
  }
  card.classList.add('selected');
  card.scrollIntoView({ block: 'center' });
}

// 加星關注的專案：純本地功能，不回寫EIP，只是方便在列表裡快速認出要盯的專案(背景會上色)
async function loadStarredProjects() {
  const ids = await call(window.api.projectStar.list());
  if (ids) state.starredProjects = new Set(ids.map(String));
  updateProjectStarCount();
}

function updateProjectStarCount() {
  const el = $('project-star-count');
  if (el) el.textContent = state.starredProjects.size ? `(${state.starredProjects.size})` : '';
}

function toggleProjectStar(projectId) {
  const key = String(projectId);
  call(window.api.projectStar.toggle(key), (err) => alert('加星失敗：' + err)).then((starred) => {
    if (starred === undefined) return;
    if (starred) state.starredProjects.add(key);
    else state.starredProjects.delete(key);
    updateProjectStarCount();
    const card = document.querySelector(`.project-card[data-id="${key}"]`);
    if (card && projectPanel.starOnly && !starred) { // 只看加星時取消星號：這張從清單移除
      projectPanel.projects = projectPanel.projects.filter((p) => String(p.id) !== key);
      if (projectPanel.selected && String(projectPanel.selected.projectId) === key) closeProjectTickets();
      card.remove();
      if (!projectPanel.projects.length) $('project-results').innerHTML = '<p style="color:#888;">已經沒有加星的專案了</p>';
      return;
    }
    if (card) {
      card.classList.toggle('starred', starred);
      const starBtn = card.querySelector('.btn-project-star');
      if (starBtn) {
        starBtn.textContent = starred ? '★' : '☆';
        starBtn.title = starred ? '取消關注' : '加星關注';
      }
    }
  });
}

function closeProjectPanel() {
  $('project-panel').classList.add('hidden');
  $('sidebar-default-view').classList.remove('hidden');
}

function closeProjectTickets() {
  projectPanel.selected = null;
  projectTicketsSeq++; // 關掉後還在路上的工單查詢結果直接作廢
  $('project-panel').classList.remove('has-detail');
  $('project-tickets').classList.add('hidden');
  renderProjectSelection();
}

// 只看加星：加星清單逐一用「#專案編號」查(後端搜尋接受)，狀態/所在部門照目前的篩選，關鍵字在本地比對
async function fetchStarredProjects(q, seq) {
  const ids = [...state.starredProjects];
  let failed = 0;
  const found = [];
  for (let i = 0; i < ids.length; i += 4) { // 每批4個，不一次把後端灌爆
    const batch = await Promise.all(ids.slice(i, i + 4).map(async (id) => {
      const list = await call(window.api.eip.listProjects(`#${id}`, projectPanel.status, projectPanel.dept), () => { failed++; });
      return (list || []).find((p) => String(p.id) === id) || null;
    }));
    if (seq !== projectSearchSeq) return null; // 途中又有新的搜尋，這次作廢
    found.push(...batch.filter(Boolean));
  }
  if (failed && !found.length) throw new Error('讀取加星專案失敗，請稍後再試');
  const kw = q.toLowerCase();
  const matches = !kw ? found : found.filter((p) => [String(p.id), p.name, p.code, p.customer_name, p.dealer_name].some((v) => String(v || '').toLowerCase().includes(kw)));
  return matches.sort((a, b) => b.id - a.id);
}

async function runProjectSearch() {
  const seq = ++projectSearchSeq;
  const q = $('project-search').value.trim();
  $('project-results').innerHTML = '<p style="color:#888;">讀取中...</p>';
  let projects;
  if (projectPanel.starOnly) {
    if (!state.starredProjects.size) {
      $('project-results').innerHTML = '<p style="color:#888;">還沒有加星的專案。點專案卡片左邊的 ☆ 就能加星關注。</p>';
      projectPanel.projects = [];
      return;
    }
    try {
      projects = await fetchStarredProjects(q, seq);
    } catch (err) {
      if (seq === projectSearchSeq) $('project-results').innerHTML = `<p style="color:#d84f4f;">查詢失敗：${escapeHtml(err.message)}</p>`;
      return;
    }
  } else {
    projects = await call(window.api.eip.listProjects(q, projectPanel.status, projectPanel.dept), (err) => {
      if (seq === projectSearchSeq) $('project-results').innerHTML = `<p style="color:#d84f4f;">查詢失敗：${escapeHtml(err)}</p>`;
    });
  }
  if (!projects || seq !== projectSearchSeq) return;
  projectPanel.projects = projects;
  if (!projects.length) {
    $('project-results').innerHTML = projectPanel.starOnly
      ? `<p style="color:#888;">加星的 ${state.starredProjects.size} 個專案裡，沒有符合目前條件(狀態/所在部門/關鍵字)的。可以把「狀態」改成「全部」看看。</p>`
      : '<p style="color:#888;">沒有符合的專案</p>';
    return;
  }
  $('project-results').innerHTML =
    projects.map(projectCardHtml).join('') +
    (projects.length >= 300 ? '<p class="meta">只顯示最新300筆，請用關鍵字或狀態縮小範圍</p>' : '');
  renderProjectSelection();
}

// 跟後端ProjectPayment::$statusText/EIP網頁配色一致
const PAYMENT_STATUS_TEXT = { not_due: '未到期', pending: '待請款', paid: '已收款', rejected: '請款被退回' };
const PAYMENT_STATUS_CLASS = { not_due: 'status-default', pending: 'status-warning', paid: 'status-success', rejected: 'status-danger' };
const DEPT_THEME_ICON = { engineering: '⚙️', finance: '💰', 'finance-done': '💰', returned: '🔁' };

function projectCardHtml(p) {
  const metaItem = (label, value) => (value ? `<span><span class="ts-k">${label}</span> ${escapeHtml(value)}</span>` : '');
  const stages = (p.stages || [])
    .map((s, i) => {
      const tip = s.state === 0 ? `${s.name}：尚未開單` : `${s.name}：共${s.total}張工單，已關閉${s.closed}張`;
      return `${i ? '<span class="stage-arrow">›</span>' : ''}<button type="button" class="stage-chip stage-s${s.state}" data-pid="${p.id}" data-stage="${s.index}" title="${escapeHtml(tip)}" ${s.state === 0 ? 'disabled' : ''}>${escapeHtml(s.name)}</button>`;
    })
    .join('');
  const starred = state.starredProjects.has(String(p.id));
  return `<div class="install-card project-card${starred ? ' starred' : ''}${p.ended_with_open_docs ? ' ended-open-docs' : ''}" data-id="${p.id}">
    <div class="project-card-top">
      <div class="project-card-main">
        <div class="install-name">
          <button type="button" class="btn-project-star" data-pid="${p.id}" title="${starred ? '取消關注' : '加星關注'}">${starred ? '★' : '☆'}</button>
          #${p.id} ${escapeHtml(p.name || '(無名稱)')}<span class="status-badge ${PROJECT_STATUS_CLASS[p.status_color] || 'status-default'}">${escapeHtml(p.status_text || '')}</span>${p.ended_with_open_docs ? '<span class="project-open-docs-note">仍有未完成工單</span>' : ''}
        </div>
        ${p.parent_name ? `<div class="project-parent">追加專案（主專案：${escapeHtml(p.parent_name)}）</div>` : ''}
        <div class="ts-card-meta">
          ${metaItem('代碼', p.code)}
          ${metaItem('客戶', p.customer_name)}
          ${metaItem('經銷商', p.dealer_name)}
          ${metaItem('業務', p.sales_name)}
          ${metaItem('類型', p.prj_type)}
        </div>
        <div class="stage-flow">${stages}</div>
        <div class="project-card-actions">
          <button type="button" class="btn-project-all-tickets" data-pid="${p.id}">全部工單</button>
          ${p.install_list_id ? `<button type="button" class="btn-project-site" data-site="${p.install_list_id}">案場資訊</button>` : ''}
        </div>
      </div>
      <div class="project-dept-box" data-pid="${p.id}">${projectDeptCardHtml(p)}</div>
      <div class="project-payment-box" data-pid="${p.id}">${projectPaymentGridHtml(p)}</div>
    </div>
  </div>`;
}

// 工程部/財務部切換卡片，放在專案卡片右側窄欄
function projectDeptCardHtml(p) {
  const dv = p.dept_view;
  if (!dv) return '<p class="meta">無部門資料</p>';
  const deptIcon = DEPT_THEME_ICON[dv.theme] || '📁';
  return `
    <div class="dept-card dept-theme-${dv.theme}">
      <div class="dept-card-top">
        <span class="dept-icon">${deptIcon}</span>
        <div class="dept-card-titles">
          <div class="dept-card-title">${escapeHtml(dv.title)}</div>
          <div class="dept-card-sub">${escapeHtml(dv.sub)}</div>
        </div>
      </div>
      <div class="dept-card-days">已停留 ${dv.days} 天${dv.since ? `<br>自 ${escapeHtml(dv.since)}` : ''}</div>
      <button type="button" class="btn-dept-transfer" data-pid="${p.id}" data-target="${dv.target}">➜ ${escapeHtml(dv.btn_text)}</button>
    </div>
  `;
}

// 四期收款排成2x2四格，放在部門卡片右側；比橫向一整排4欄省寬度，比直向四行省高度
function projectPaymentGridHtml(p) {
  const payments = p.payments || {};
  const periods = Object.keys(payments).sort((a, b) => Number(a) - Number(b));
  if (!periods.length) return '';

  let totalPercent = 0;
  let paidPercent = 0;
  periods.forEach((period) => {
    const percent = Number(payments[period].percent) || 0;
    totalPercent += percent;
    if (payments[period].status === 'paid') paidPercent += percent;
  });
  const totalWarn = totalPercent !== 100 ? ' <span class="payment-warn">⚠</span>' : '';

  const cells = periods
    .map((period) => {
      const info = payments[period];
      const options = Object.keys(PAYMENT_STATUS_TEXT)
        .map((key) => `<option value="${key}" ${info.status === key ? 'selected' : ''}>${PAYMENT_STATUS_TEXT[key]}</option>`)
        .join('');
      return `<div class="payment-cell">
        <span class="payment-cell-name">${escapeHtml(info.name)}<span class="meta">${info.percent}%</span></span>
        <select class="payment-status-select ${PAYMENT_STATUS_CLASS[info.status] || ''}" data-pid="${p.id}" data-period="${period}">${options}</select>
      </div>`;
    })
    .join('');

  const percentInputs = periods
    .map((period) => `<label class="payment-percent-input">${escapeHtml(payments[period].name)}
      <input type="number" min="0" max="100" data-period="${period}" value="${payments[period].percent}" />%</label>`)
    .join('');

  return `
    <div class="payment-summary-row">
      <span class="payment-summary">已收${paidPercent}%／${totalPercent}%${totalWarn}</span>
      <button type="button" class="btn-payment-percent-toggle" data-pid="${p.id}" title="編輯收款比例">✎</button>
    </div>
    <div class="payment-grid">${cells}</div>
    <div class="payment-percent-form hidden" data-pid="${p.id}">
      ${percentInputs}
      <button type="button" class="btn-payment-percent-save" data-pid="${p.id}">✓ 儲存比例</button>
    </div>
  `;
}

// 專案的部門/收款資料有異動(轉部門、改收款狀態、改比例)後，更新本地快取並只重繪該張卡片的部門卡片跟收款格，不用整個重新搜尋
function applyProjectDeptUpdate(projectId, data) {
  const project = projectPanel.projects.find((p) => String(p.id) === String(projectId));
  if (!project) return;
  project.current_dept = data.current_dept;
  project.dept_view = data.dept_view;
  project.payments = data.payments;
  const deptBox = document.querySelector(`.project-dept-box[data-pid="${projectId}"]`);
  if (deptBox) deptBox.innerHTML = projectDeptCardHtml(project);
  const paymentBox = document.querySelector(`.project-payment-box[data-pid="${projectId}"]`);
  if (paymentBox) paymentBox.innerHTML = projectPaymentGridHtml(project);
}

// 目前選中的專案卡片框起來、選中的階段加外框，讓下方工單列表對得上是哪個專案的哪個階段
function renderProjectSelection() {
  const sel = projectPanel.selected;
  $('project-results').querySelectorAll('.project-card').forEach((card) => {
    card.classList.toggle('selected', !!sel && card.dataset.id === String(sel.projectId));
  });
  $('project-results').querySelectorAll('.stage-chip').forEach((chip) => {
    chip.classList.toggle('active', !!sel && sel.stage != null && chip.dataset.pid === String(sel.projectId) && chip.dataset.stage === String(sel.stage));
  });
}

// 點流程階段(或「全部工單」)：下方列出該專案該階段的工單；排除已刪除的單，跟流程顏色的計算基準一致
async function openProjectTickets(projectId, stage) {
  const project = projectPanel.projects.find((p) => String(p.id) === String(projectId));
  if (!project) return;
  const stageInfo = stage != null ? project.stages.find((s) => s.index === stage) : null;
  projectPanel.selected = { projectId: project.id, stage };
  projectPanel.ticketStatusFilter = new Set(); // 每次重新點流程階段/全部工單，狀態篩選重置
  renderProjectSelection();

  $('project-panel').classList.add('has-detail');
  $('project-tickets').classList.remove('hidden');
  $('project-tickets-title').textContent = `▾ ${project.name}　${stageInfo ? stageInfo.name : '全部階段'}`;
  renderTicketStatusFilterBar();
  await loadProjectTickets();
}

// 工單狀態篩選按鈕列：可複選，對照EIP網頁manage/internal/index的狀態勾選按鈕
// 「待處理」快捷：一次勾選 新任務、已指派、已暫停、未定義、追蹤中(還沒送品保、也沒結束的狀態)
const PENDING_STATUS_PRESET = [0, 1, 3, 6, 7];

function isPendingPresetActive() {
  const f = projectPanel.ticketStatusFilter;
  return f.size === PENDING_STATUS_PRESET.length && PENDING_STATUS_PRESET.every((c) => f.has(c));
}

function togglePendingPreset() {
  projectPanel.ticketStatusFilter = isPendingPresetActive() ? new Set() : new Set(PENDING_STATUS_PRESET);
  renderTicketStatusFilterBar();
  loadProjectTickets();
}

function renderTicketStatusFilterBar() {
  const presetActive = isPendingPresetActive();
  const presetBtn = `<button type="button" class="ticket-status-chip status-preset${presetActive ? ' active' : ''}" data-preset="pending" title="一次勾選：新任務、已指派、已暫停、未定義、追蹤中；再點一次取消">待處理${presetActive ? ' ✓' : ''}</button>`;
  $('project-tickets-status-bar').innerHTML = presetBtn + TICKET_STATUS_OPTIONS.map(([code, text, cls]) => {
    const active = projectPanel.ticketStatusFilter.has(code);
    return `<button type="button" class="ticket-status-chip ${cls}${active ? ' active' : ''}" data-status="${code}">${text}${active ? ' ✓' : ''}</button>`;
  }).join('');
}

function toggleTicketStatusFilter(code) {
  if (projectPanel.ticketStatusFilter.has(code)) projectPanel.ticketStatusFilter.delete(code);
  else projectPanel.ticketStatusFilter.add(code);
  renderTicketStatusFilterBar();
  loadProjectTickets();
}

// 目前右側專案工單列表用的查詢條件(「放到左側」也用同一份，所見即所得)
function currentProjectTicketFilters(project, sel) {
  const statuses = projectPanel.ticketStatusFilter.size
    ? Array.from(projectPanel.ticketStatusFilter).join(',')
    : '0,1,2,3,4,5,6,7,8,10';
  const filters = { project_id: project.id, status: statuses, order_by: 'id', order_dir: 'desc', per_page: 100 };
  if (sel.stage != null) filters.task_stage = sel.stage;
  return filters;
}

// 依目前選定的專案/階段/狀態篩選重新查詢工單列表；不帶狀態篩選時維持原本「排除已刪除」的範圍
async function loadProjectTickets() {
  const sel = projectPanel.selected;
  if (!sel) return;
  const project = projectPanel.projects.find((p) => String(p.id) === String(sel.projectId));
  if (!project) return;

  $('project-tickets-list').innerHTML = '<p style="color:#888;">讀取中...</p>';

  const seq = ++projectTicketsSeq;
  const filters = currentProjectTicketFilters(project, sel);
  const res = await call(window.api.eip.advancedSearchTickets(filters), (err) => {
    if (seq === projectTicketsSeq) $('project-tickets-list').innerHTML = `<p style="color:#d84f4f;">讀取工單失敗：${escapeHtml(err)}</p>`;
  });
  if (!res || seq !== projectTicketsSeq) return;

  const { items, meta } = res;
  if (!items.length) {
    $('project-tickets-list').innerHTML = '<p style="color:#888;">沒有工單</p>';
    return;
  }
  const total = meta ? meta.total : items.length;
  $('project-tickets-list').innerHTML =
    `<p class="meta">共 ${total} 張${total > items.length ? `，只顯示最新 ${items.length} 張` : ''}，點工單另開視窗查看詳情</p>` +
    items.map(ticketSearchCardHtml).join('');
  // 跟裝機單的相關工單一樣另開視窗，不打斷右側正在看的專案列表
  $('project-tickets-list').querySelectorAll('.ticket-search-card').forEach((el) => {
    el.addEventListener('click', () => call(window.api.window.openTicket(el.dataset.id)));
  });
}

// ---------------- 專案工單檢視(把專案的工單放到左側清單，方便勾選後批次轉單分配) ----------------

async function sendProjectTicketsToLeft() {
  const sel = projectPanel.selected;
  if (!sel) return;
  const project = projectPanel.projects.find((p) => String(p.id) === String(sel.projectId));
  if (!project) return;
  const stageInfo = sel.stage != null ? project.stages.find((s) => s.index === sel.stage) : null;
  const alreadyInView = !!state.projectView;
  state.projectView = {
    project,
    filters: currentProjectTicketFilters(project, sel),
    label: `${project.name}　${stageInfo ? stageInfo.name : '全部階段'}`,
    engineerId: null, // 工程師選單的篩選：null=全部；選了人就只看這個人的單(分配後的單會從原本的人身上消失)
    prevSelect: alreadyInView ? state.projectView.prevSelect : $('engineer-select').value, // 離開時要選回去的人
  };
  enterProjectViewEngineerSelect();
  if (state.currentTicket) backToList();
  state.selectedIds.clear();
  state.searchQuery = '';
  $('ticket-search').value = '';
  $('ticket-list').innerHTML = '<p style="color:#888;">讀取中...</p>';
  updateProjectViewUi();
  updateBatchBar();
  await loadProjectViewTickets();
}

// 逐頁讀完(一頁最多100張)，不像右側列表只顯示最新100張，分配時要看得到全部
async function loadProjectViewTickets() {
  const view = state.projectView;
  if (!view) return;
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const res = await call(window.api.eip.advancedSearchTickets({ ...view.filters, page }), (err) => {
      if (state.projectView === view) $('ticket-list').innerHTML = `<p style="color:#d84f4f;">讀取專案工單失敗：${escapeHtml(err)}</p>`;
    });
    if (!res) return;
    items.push(...res.items);
    const total = res.meta ? Number(res.meta.total) : items.length;
    if (!res.items.length || items.length >= total) break;
  }
  if (state.projectView !== view) return;
  state.tickets = items;
  updateProjectViewEngineerCounts();
  const alive = new Set(items.map((t) => String(t.id)));
  [...state.selectedIds].forEach((id) => { if (!alive.has(id)) state.selectedIds.delete(id); });
  renderTicketList();
  updateBatchBar();
}

// 工程師選單在專案檢視中的樣子：最前面多一個「全部」，每個人後面標這個專案目前有幾張單
function enterProjectViewEngineerSelect() {
  const sel = $('engineer-select');
  if (!sel.querySelector('option[data-all]')) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.dataset.all = '1';
    sel.insertBefore(opt, sel.firstChild);
  }
  sel.value = '';
  updateProjectViewEngineerCounts();
}

function updateProjectViewEngineerCounts() {
  const view = state.projectView;
  if (!view) return;
  const counts = {};
  state.tickets.forEach((t) => { counts[String(t.p_user_id)] = (counts[String(t.p_user_id)] || 0) + 1; });
  const sel = $('engineer-select');
  sel.querySelectorAll('option').forEach((o) => {
    if (o.dataset.base === undefined) o.dataset.base = o.textContent;
    o.textContent = o.dataset.all ? `全部(${state.tickets.length})` : `${o.dataset.base}(${counts[o.value] || 0})`;
  });
  sel.value = view.engineerId == null ? '' : String(view.engineerId);
}

// 離開專案檢視：拿掉「全部」與張數，選回原本看的人
function leaveProjectViewEngineerSelect(prevValue) {
  const sel = $('engineer-select');
  const all = sel.querySelector('option[data-all]');
  if (all) all.remove();
  sel.querySelectorAll('option').forEach((o) => {
    if (o.dataset.base !== undefined) {
      o.textContent = o.dataset.base;
      delete o.dataset.base;
    }
  });
  if (prevValue != null && prevValue !== '') sel.value = prevValue;
}

function updateProjectViewUi() {
  const view = state.projectView;
  $('project-view-bar').classList.toggle('hidden', !view);
  $('ticket-tabs').classList.toggle('hidden', !!view);
  $('ticket-range').classList.toggle('hidden', !!view);
  $('engineer-readonly-hint').classList.toggle('hidden', !!view || !isViewingOtherEngineer());
  if (view) $('project-view-text').textContent = `專案工單：${view.label}`;
}

function exitProjectView() {
  if (!state.projectView) return;
  leaveProjectViewEngineerSelect(state.projectView.prevSelect);
  state.projectView = null;
  state.tickets = [];
  state.selectedIds.clear();
  updateProjectViewUi();
  updateBatchBar();
  $('ticket-list').innerHTML = '<p style="color:#888;">讀取中...</p>';
  refreshTicketList();
}

function onProjectResultsClick(e) {
  const starBtn = e.target.closest('.btn-project-star');
  if (starBtn) {
    toggleProjectStar(starBtn.dataset.pid);
    return;
  }
  const chip = e.target.closest('.stage-chip');
  if (chip && !chip.disabled) {
    openProjectTickets(chip.dataset.pid, Number(chip.dataset.stage));
    return;
  }
  const allBtn = e.target.closest('.btn-project-all-tickets');
  if (allBtn) {
    openProjectTickets(allBtn.dataset.pid, null);
    return;
  }
  const siteBtn = e.target.closest('.btn-project-site');
  if (siteBtn) {
    openInstallPanel();
    openInstallDetail(siteBtn.dataset.site);
    return;
  }

  const deptBtn = e.target.closest('.btn-dept-transfer');
  if (deptBtn) {
    deptBtn.disabled = true;
    call(window.api.eip.projectDeptTransfer(deptBtn.dataset.pid, deptBtn.dataset.target), (err) => {
      alert('轉部門失敗：' + err);
      deptBtn.disabled = false;
    }).then((data) => {
      if (data) applyProjectDeptUpdate(deptBtn.dataset.pid, data);
    });
    return;
  }

  const percentToggleBtn = e.target.closest('.btn-payment-percent-toggle');
  if (percentToggleBtn) {
    const box = percentToggleBtn.closest('.project-payment-box');
    box.querySelector('.payment-percent-form').classList.toggle('hidden');
    return;
  }

  const percentSaveBtn = e.target.closest('.btn-payment-percent-save');
  if (percentSaveBtn) {
    const form = percentSaveBtn.closest('.payment-percent-form');
    const percents = {};
    form.querySelectorAll('input[data-period]').forEach((input) => {
      percents[input.dataset.period] = Number(input.value) || 0;
    });
    percentSaveBtn.disabled = true;
    call(window.api.eip.projectPaymentPercentSave(percentSaveBtn.dataset.pid, percents), (err) => {
      alert('儲存收款比例失敗：' + err);
      percentSaveBtn.disabled = false;
    }).then((data) => {
      if (data) applyProjectDeptUpdate(percentSaveBtn.dataset.pid, data);
    });
  }
}

// select下拉選單要用change事件，不是click
function onProjectResultsChange(e) {
  const select = e.target.closest('.payment-status-select');
  if (!select) return;
  select.disabled = true;
  call(window.api.eip.projectPaymentUpdate(select.dataset.pid, select.dataset.period, select.value), (err) => {
    alert('更新收款狀態失敗：' + err);
    runProjectSearch(); // 失敗時select的值已經被瀏覽器改成使用者選的新值，重新整個查一次恢復成伺服器的真實狀態
  }).then((data) => {
    if (data) applyProjectDeptUpdate(select.dataset.pid, data); // 重繪會重建select，disabled狀態自然解除
  });
}

function switchProjectDept(dept) {
  projectPanel.dept = dept;
  document.querySelectorAll('.project-dept-btn').forEach((el) => el.classList.toggle('active', el.dataset.dept === dept));
  closeProjectTickets();
  runProjectSearch();
}

function switchProjectStarOnly() {
  projectPanel.starOnly = !projectPanel.starOnly;
  $('btn-project-star-only').classList.toggle('active', projectPanel.starOnly);
  closeProjectTickets();
  runProjectSearch();
}

function switchProjectStatus(status) {
  projectPanel.status = status;
  document.querySelectorAll('.project-status-btn').forEach((el) => el.classList.toggle('active', el.dataset.status === status));
  closeProjectTickets();
  runProjectSearch();
}

// ---------------- 工單查詢(全站搜尋所有工單，不限自己) ----------------

let ticketSearchTimer = null;

// 工單查詢顯示在右側欄，跟信箱/行事曆/裝機單互斥切換，左邊工單清單不受影響、隨時看得到
// skipInitialSearch=true時不要先撈一次全部工單，讓呼叫端(viewCurrentTicketFull)接著用openTicketSearchDetail
// 帶出的單一結果來決定列表內容，避免兩個非同步搜尋互相competing、全部工單的結果晚到蓋掉單一工單的結果
function openTicketSearchPanel(focusSearch = true, skipInitialSearch = false) {
  $('sidebar-default-view').classList.add('hidden');
  $('install-panel').classList.add('hidden');
  $('project-panel').classList.add('hidden');
  $('ticket-search-panel').classList.remove('hidden');
  $('ticket-search-panel').classList.remove('has-detail');
  $('ticket-search-detail').classList.add('hidden');
  if (skipInitialSearch) return;
  $('ticket-search-query').value = '';
  resetAdvSearchState(true); // 順便會觸發一次runTicketSearch('')，不用再另外呼叫
  $('ticket-search-results').innerHTML = '<p style="color:#888;">輸入關鍵字搜尋全部工單</p>';
  if (focusSearch) $('ticket-search-query').focus();
}

// 左側自己的工單詳情專注在回覆，要看完整資訊時借用右側工單查詢的詳情面板顯示同一張單
// 這時把上面的搜尋列表也帶成只有這一張單，畫面才不會「上面顯示一堆別的工單、下面卻是這張的詳情」，看起來對不起來
function viewCurrentTicketFull() {
  if (!state.currentTicket) return;
  viewTicketFullInSidebar(state.currentTicket.id);
}

// 在右側欄打開某張工單的完整詳情(欄位、描述、附件、全部回覆)，左側清單/詳情維持不動，方便對照
function viewTicketFullInSidebar(ticketId) {
  openTicketSearchPanel(false, true);
  openTicketSearchDetail(ticketId, true);
}

function closeTicketSearchPanel() {
  $('ticket-search-panel').classList.add('hidden');
  $('sidebar-default-view').classList.remove('hidden');
}

// 關閉下面的工單詳情，回到上面完整的清單(清掉搜尋條件，重新列出全部工單)
function closeTicketSearchDetail() {
  // 只收起詳情、把列表區還原成整頁高度，搜尋框內容跟已篩選出的結果都維持原樣不動，
  // 使用者就是想留著篩選條件看清楚列表，不是要重新搜尋一次全部
  $('ticket-search-panel').classList.remove('has-detail');
  $('ticket-search-detail').classList.add('hidden');
}

// 詳情頁改了系統功能版本後，左側工單清單裡同一張單也跟著更新，不用等下次重新整理
function syncTicketTimes(ticketId, data) {
  const t = state.tickets.find((x) => String(x.id) === String(ticketId));
  if (!t) return;
  t.start_time = data.start_time;
  t.end_time = data.end_time;
  renderTicketList();
}

function syncTicketVersion(ticketId, data) {
  const t = state.tickets.find((x) => String(x.id) === String(ticketId));
  if (!t) return;
  t.version = data.version;
  t.version_text = data.version_text;
  renderTicketList();
}

// 欄位對齊EIP總表；空值的欄位直接不顯示，避免卡片塞滿「-」
function ticketSearchCardHtml(t) {
  const metaItem = (label, value) =>
    value ? `<span><span class="ts-k">${label}</span> ${escapeHtml(value)}</span>` : '';
  return `<div class="install-card ticket-search-card" data-id="${t.id}">
        <div class="install-name">${formatTicketNo(t.id)} ${escapeHtml(t.summary || '(無摘要)')} ${statusBadge(t)}</div>
        <div style="color:#555;margin-top:4px;">${escapeHtml(t.project_name || '(無專案)')}</div>
        <div class="ts-card-meta">
          ${metaItem('任務類型', t.kind_name)}
          ${metaItem('類型', t.type_label)}
          ${metaItem('分類', t.classification)}
          ${t.severity_text ? `<span><span class="ts-k">嚴重程度</span> <span class="ts-severity-${t.severity}">${escapeHtml(t.severity_text)}</span></span>` : ''}
        </div>
        <div class="ts-card-meta">
          ${metaItem('負責人員', t.p_user_name)}
          ${metaItem('反應人', t.c_user_name)}
          ${metaItem('客戶', t.customer_name)}
          ${metaItem('經銷商', t.dealer_name)}
          ${metaItem('系統功能版本', t.version_text)}
        </div>
        <div class="ts-card-meta">
          ${metaItem('建單', t.created_at ? String(t.created_at).slice(0, 10) : '')}
          ${metaItem('開始', t.start_time)}
          ${metaItem('結束', t.end_time)}
          ${t.progress_text ? `<span class="ts-progress ${progressClass(t.progress_text)}">${escapeHtml(t.progress_text)}</span>` : ''}
        </div>
      </div>`;
}

function bindTicketSearchCards() {
  $('ticket-search-results').querySelectorAll('.ticket-search-card').forEach((el) => {
    el.addEventListener('click', () => openTicketSearchDetail(el.dataset.id));
  });
}

async function runTicketSearch(q) {
  $('ticket-search-pagination').classList.add('hidden');
  const results = await call(window.api.eip.searchTickets(q), (err) => {
    $('ticket-search-results').innerHTML = `<p style="color:#d84f4f;">搜尋失敗：${escapeHtml(err)}</p>`;
  });
  if (!results) return;
  if (!results.length) {
    $('ticket-search-results').innerHTML = '<p style="color:#888;">沒有符合的工單</p>';
    return;
  }
  $('ticket-search-results').innerHTML = results.map(ticketSearchCardHtml).join('');
  bindTicketSearchCards();
}

// ---------------- 工單進階搜尋 ----------------

// 狀態/種類/任務類型/嚴重程度等下拉選項只在第一次展開進階搜尋時跟後端要一次，同一次開啟App期間重複使用
async function ensureAdvSearchOptionsLoaded() {
  if (state.advSearch.optionsLoaded) return;
  const options = await call(window.api.eip.getTicketSearchOptions(), (err) => {
    alert('讀取進階搜尋選項失敗：' + err);
  });
  if (!options) return;
  state.advSearch.optionsLoaded = true;

  const fieldLabels = {
    summary: '標題／摘要', description: '說明', keyword: '關鍵字欄位', reply: '回覆內容',
    project_name: '專案名稱', user_name: '人員姓名', customer: '客戶', dealer: '經銷商',
  };
  renderAdvCheckboxGroup('adv-fields', Object.keys(fieldLabels).map((v) => ({ value: v, text: fieldLabels[v] })), state.advSearch.fields);
  renderAdvCheckboxGroup('adv-statuses', options.statuses, []);
  renderAdvCheckboxGroup('adv-categories', options.categories, []);

  const dateFieldSelect = $('adv-date-field');
  dateFieldSelect.innerHTML = (options.date_fields || [])
    .map((f) => `<option value="${escapeHtml(f.value)}">${escapeHtml(f.text)}</option>`)
    .join('');
}

// 畫一組「勾選chip」；checkedValues非空時預設勾選那幾個(目前只有搜尋範圍用得到，狀態/種類預設全不勾=不篩選)
function renderAdvCheckboxGroup(containerId, items, checkedValues) {
  const checkedSet = new Set((checkedValues || []).map(String));
  const container = $(containerId);
  container.innerHTML = (items || [])
    .map((item) => {
      const checked = checkedSet.has(String(item.value));
      return `<label class="adv-check-item${checked ? ' checked' : ''}">
        <input type="checkbox" value="${escapeHtml(item.value)}" ${checked ? 'checked' : ''} />${escapeHtml(item.text)}
      </label>`;
    })
    .join('');
  container.querySelectorAll('.adv-check-item').forEach((label) => {
    const input = label.querySelector('input');
    input.addEventListener('change', () => label.classList.toggle('checked', input.checked));
  });
}

function getCheckedValues(containerId) {
  return Array.from($(containerId).querySelectorAll('input:checked')).map((el) => el.value);
}

// 只負責展開/收合表單本身(純UI)，不碰目前是否已套用進階條件、也不觸發任何搜尋，
// 使用者習慣收合表單是為了讓列表/詳情有更大空間看，不代表要放棄已經套用的搜尋條件
async function toggleAdvSearchPanel() {
  state.advSearch.formVisible = !state.advSearch.formVisible;
  $('ticket-adv-filters').classList.toggle('hidden', !state.advSearch.formVisible);
  $('btn-toggle-adv-search').textContent = state.advSearch.formVisible ? '進階搜尋 ▴' : '進階搜尋 ▾';
  if (state.advSearch.formVisible) {
    await ensureAdvSearchOptionsLoaded();
  }
}

function closeAdvFormPanel() {
  state.advSearch.formVisible = false;
  $('ticket-adv-filters').classList.add('hidden');
  $('btn-toggle-adv-search').textContent = '進階搜尋 ▾';
}

// 簡易搜尋框跟進階條件是互斥的兩套搜尋方式：進階條件套用後，關鍵字改由表單內的「關鍵字」欄位負責，
// 上面的搜尋框停用避免使用者誤以為打字也會生效、卻其實沒有真的在用
function setSimpleSearchBoxEnabled(enabled) {
  const box = $('ticket-search-query');
  box.disabled = !enabled;
  if (enabled) {
    box.placeholder = '搜尋工單編號／摘要／專案名稱...';
  } else {
    box.value = '';
    box.placeholder = '進階搜尋中，條件請見右側標籤';
  }
}

// 表單上任一欄位只要有值就算「有進階條件」；用來判斷清到最後一個條件時要不要整個退出進階模式
function hasActiveAdvFilters() {
  return Boolean(
    $('adv-keyword').value.trim() ||
    state.advSearch.site ||
    $('adv-id-from').value.trim() ||
    $('adv-id-to').value.trim() ||
    $('adv-date-from').value ||
    $('adv-date-to').value ||
    getCheckedValues('adv-statuses').length ||
    getCheckedValues('adv-categories').length ||
    $('adv-assignee-name').value.trim() ||
    $('adv-reporter-name').value.trim()
  );
}

// 點「套用篩選」：套用條件、收合表單讓出空間看結果，條件會變成標籤留在搜尋框旁邊
async function applyAdvSearch() {
  state.advSearch.active = true;
  closeAdvFormPanel();
  setSimpleSearchBoxEnabled(false);
  await runAdvancedTicketSearch(1);
  renderAdvChips();
}

// 整個退出進階搜尋模式(條件全部被拿掉、或按了「清除條件」)：恢復簡易搜尋框，改回原本的search API
function exitAdvSearchMode() {
  state.advSearch.active = false;
  state.advSearch.site = null;
  $('adv-site-selected').classList.add('hidden');
  $('adv-chips-row').classList.add('hidden');
  $('adv-chips-row').innerHTML = '';
  $('ticket-search-pagination').classList.add('hidden');
  setSimpleSearchBoxEnabled(true);
  runTicketSearch('');
}

// chip上的✕：清掉那一個條件，如果清完後表單已經沒有任何條件就直接退出進階模式，否則用剩下的條件重新查一次
function clearOneAdvFilterAndRerun() {
  if (hasActiveAdvFilters()) {
    runAdvancedTicketSearch(1).then(renderAdvChips);
  } else {
    exitAdvSearchMode();
  }
}

// 清除條件按鈕：重置表單所有欄位(含checkbox)，但表單維持展開讓使用者可以直接輸入新條件
function resetAdvSearchState(closeForm) {
  state.advSearch.site = null;
  state.advSearch.page = 1;
  state.advSearch.lastMeta = null;
  $('adv-keyword').value = '';
  $('adv-site-input').value = '';
  $('adv-site-selected').classList.add('hidden');
  $('adv-site-results').classList.add('hidden');
  $('adv-id-from').value = '';
  $('adv-id-to').value = '';
  $('adv-date-from').value = '';
  $('adv-date-to').value = '';
  $('adv-assignee-name').value = '';
  $('adv-reporter-name').value = '';
  $('adv-order-by').value = 'id';
  $('adv-order-dir').value = 'desc';
  if ($('adv-date-field').options.length) $('adv-date-field').selectedIndex = 0;
  if (state.advSearch.optionsLoaded) {
    renderAdvCheckboxGroup('adv-fields', getFieldCheckboxItems(), state.advSearch.fields);
    renderAdvCheckboxGroup('adv-statuses', getStatusCheckboxItemsFromDom(), []);
    renderAdvCheckboxGroup('adv-categories', getCategoryCheckboxItemsFromDom(), []);
  }
  if (closeForm) closeAdvFormPanel();
  exitAdvSearchMode();
}

// 把目前表單上的條件畫成標籤放在搜尋框右側；每個標籤都能單獨清掉那一項條件並重新查詢
function renderAdvChips() {
  const row = $('adv-chips-row');
  if (!state.advSearch.active) {
    row.classList.add('hidden');
    row.innerHTML = '';
    return;
  }

  const chips = [];
  const keyword = $('adv-keyword').value.trim();
  if (keyword) {
    chips.push({ label: `關鍵字：${keyword}`, onClear: () => { $('adv-keyword').value = ''; clearOneAdvFilterAndRerun(); } });
  }
  if (state.advSearch.site) {
    chips.push({ label: `案場：${state.advSearch.site.name}`, onClear: () => {
      state.advSearch.site = null;
      $('adv-site-selected').classList.add('hidden');
      clearOneAdvFilterAndRerun();
    } });
  }
  const idFrom = $('adv-id-from').value.trim();
  const idTo = $('adv-id-to').value.trim();
  if (idFrom || idTo) {
    chips.push({ label: `工單號：${idFrom || '不限'}～${idTo || '不限'}`, onClear: () => {
      $('adv-id-from').value = ''; $('adv-id-to').value = '';
      clearOneAdvFilterAndRerun();
    } });
  }
  const dateFrom = $('adv-date-from').value;
  const dateTo = $('adv-date-to').value;
  if (dateFrom || dateTo) {
    const sel = $('adv-date-field');
    const fieldLabel = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '時間';
    chips.push({ label: `${fieldLabel}：${dateFrom || '不限'}～${dateTo || '不限'}`, onClear: () => {
      $('adv-date-from').value = ''; $('adv-date-to').value = '';
      clearOneAdvFilterAndRerun();
    } });
  }
  const statusTexts = getCheckedTexts('adv-statuses');
  if (statusTexts.length) {
    chips.push({ label: `狀態：${statusTexts.join('、')}`, onClear: () => { uncheckAll('adv-statuses'); clearOneAdvFilterAndRerun(); } });
  }
  const categoryTexts = getCheckedTexts('adv-categories');
  if (categoryTexts.length) {
    chips.push({ label: `種類：${categoryTexts.join('、')}`, onClear: () => { uncheckAll('adv-categories'); clearOneAdvFilterAndRerun(); } });
  }
  const assigneeName = $('adv-assignee-name').value.trim();
  if (assigneeName) {
    chips.push({ label: `負責人員：${assigneeName}`, onClear: () => { $('adv-assignee-name').value = ''; clearOneAdvFilterAndRerun(); } });
  }
  const reporterName = $('adv-reporter-name').value.trim();
  if (reporterName) {
    chips.push({ label: `反應人：${reporterName}`, onClear: () => { $('adv-reporter-name').value = ''; clearOneAdvFilterAndRerun(); } });
  }

  if (!chips.length) {
    exitAdvSearchMode();
    return;
  }

  row.innerHTML = chips
    .map((c, i) => `<span class="adv-chip">${escapeHtml(c.label)} <span class="adv-chip-x" data-idx="${i}">✕</span></span>`)
    .join('');
  row.classList.remove('hidden');
  row.querySelectorAll('.adv-chip-x').forEach((el) => {
    el.addEventListener('click', () => chips[Number(el.dataset.idx)].onClear());
  });
}

function getCheckedTexts(containerId) {
  return Array.from($(containerId).querySelectorAll('.adv-check-item.checked')).map((label) => label.textContent.trim());
}

function uncheckAll(containerId) {
  $(containerId).querySelectorAll('input:checked').forEach((input) => {
    input.checked = false;
    input.closest('.adv-check-item').classList.remove('checked');
  });
}

// 清除條件後重繪checkbox時，直接拿目前DOM上已經存在的選項文字重建(不用再打一次API)
function getFieldCheckboxItems() {
  return Array.from($('adv-fields').querySelectorAll('.adv-check-item')).map((label) => ({
    value: label.querySelector('input').value,
    text: label.textContent.trim(),
  }));
}
function getStatusCheckboxItemsFromDom() {
  return Array.from($('adv-statuses').querySelectorAll('.adv-check-item')).map((label) => ({
    value: label.querySelector('input').value,
    text: label.textContent.trim(),
  }));
}
function getCategoryCheckboxItemsFromDom() {
  return Array.from($('adv-categories').querySelectorAll('.adv-check-item')).map((label) => ({
    value: label.querySelector('input').value,
    text: label.textContent.trim(),
  }));
}

let advSiteSearchTimer = null;

function bindAdvSiteInput() {
  $('adv-site-input').addEventListener('input', () => {
    clearTimeout(advSiteSearchTimer);
    const q = $('adv-site-input').value.trim();
    if (!q) {
      $('adv-site-results').classList.add('hidden');
      $('adv-site-results').innerHTML = '';
      return;
    }
    advSiteSearchTimer = setTimeout(() => runAdvSiteSearch(q), 300);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.adv-site-picker')) $('adv-site-results').classList.add('hidden');
  });
}

async function runAdvSiteSearch(q) {
  const results = await call(window.api.eip.searchInstallLists(q));
  const container = $('adv-site-results');
  if (!results || !results.length) {
    container.innerHTML = '<div class="adv-site-empty">沒有符合的案場</div>';
    container.classList.remove('hidden');
    return;
  }
  container.innerHTML = results
    .slice(0, 20)
    .map((s) => `<div class="adv-site-item" data-id="${s.id}" data-name="${escapeHtml(s.name)}">
      ${escapeHtml(s.name)}${s.code ? `<span class="site-sub">${escapeHtml(s.code)}</span>` : ''}
    </div>`)
    .join('');
  container.classList.remove('hidden');
  container.querySelectorAll('.adv-site-item').forEach((el) => {
    el.addEventListener('click', () => selectAdvSite(el.dataset.id, el.dataset.name));
  });
}

function selectAdvSite(id, name) {
  state.advSearch.site = { id, name };
  $('adv-site-input').value = '';
  $('adv-site-results').classList.add('hidden');
  const chip = $('adv-site-selected');
  chip.innerHTML = `${escapeHtml(name)} <span class="adv-chip-x" id="adv-site-clear">✕</span>`;
  chip.classList.remove('hidden');
  $('adv-site-clear').addEventListener('click', () => {
    state.advSearch.site = null;
    chip.classList.add('hidden');
  });
}

// 把表單上目前的所有進階條件組成後端advanced-search API要的query參數物件
function collectAdvFilters(page) {
  const filters = {};
  const keyword = $('adv-keyword').value.trim();
  if (keyword) filters.keyword = keyword;

  const fields = getCheckedValues('adv-fields');
  if (fields.length) filters.fields = fields.join(',');

  if (state.advSearch.site) filters.site_id = state.advSearch.site.id;

  const idFrom = $('adv-id-from').value.trim();
  if (idFrom) filters.id_from = idFrom;
  const idTo = $('adv-id-to').value.trim();
  if (idTo) filters.id_to = idTo;

  const dateField = $('adv-date-field').value;
  if (dateField) filters.date_field = dateField;
  const dateFrom = $('adv-date-from').value;
  if (dateFrom) filters.date_from = dateFrom;
  const dateTo = $('adv-date-to').value;
  if (dateTo) filters.date_to = dateTo;

  const statuses = getCheckedValues('adv-statuses');
  if (statuses.length) filters.status = statuses.join(',');

  const categories = getCheckedValues('adv-categories');
  if (categories.length) filters.category = categories.join(',');

  const assigneeName = $('adv-assignee-name').value.trim();
  if (assigneeName) filters.assignee_name = assigneeName;
  const reporterName = $('adv-reporter-name').value.trim();
  if (reporterName) filters.reporter_name = reporterName;

  filters.order_by = $('adv-order-by').value;
  filters.order_dir = $('adv-order-dir').value;
  filters.page = page || 1;
  filters.per_page = state.advSearch.perPage;

  return filters;
}

async function runAdvancedTicketSearch(page = 1) {
  state.advSearch.page = page;
  const filters = collectAdvFilters(page);
  const res = await call(window.api.eip.advancedSearchTickets(filters), (err) => {
    $('ticket-search-results').innerHTML = `<p style="color:#d84f4f;">搜尋失敗：${escapeHtml(err)}</p>`;
    $('ticket-search-pagination').classList.add('hidden');
  });
  if (!res) return;

  const { items, meta } = res;
  state.advSearch.lastMeta = meta;
  if (!items || !items.length) {
    $('ticket-search-results').innerHTML = '<p style="color:#888;">沒有符合的工單</p>';
  } else {
    $('ticket-search-results').innerHTML = items.map(ticketSearchCardHtml).join('');
    bindTicketSearchCards();
  }
  renderAdvSearchPagination(meta);
}

function renderAdvSearchPagination(meta) {
  const pager = $('ticket-search-pagination');
  if (!meta || meta.total <= 0) {
    pager.classList.add('hidden');
    return;
  }
  pager.classList.remove('hidden');
  $('ts-page-info').textContent = `共 ${meta.total} 筆，第 ${meta.current_page} / ${meta.last_page} 頁`;
  $('btn-ts-prev-page').disabled = meta.current_page <= 1;
  $('btn-ts-next-page').disabled = meta.current_page >= meta.last_page;
}

// 從左側工單帶進來查看詳情時，直接用已經抓到的完整工單資料組出唯一一張卡片，
// 不用另外呼叫搜尋API(欄位可能因搜尋條件而匹配到別的單，直接用手上這張最準)
function showTicketAloneInSearchList(ticket) {
  $('ticket-search-query').value = formatTicketNo(ticket.id);
  $('ticket-search-results').innerHTML = ticketSearchCardHtml(ticket);
  $('ticket-search-pagination').classList.add('hidden');
  bindTicketSearchCards();
}

// 左側工單詳情的回覆記錄：跟右側工單查詢共用同一份資料與排版，只是預設收合
function renderReplies(ticket) {
  const replies = ticket.replies || [];
  $('detail-reply-count').textContent = replies.length ? `（共 ${replies.length} 則，點擊展開）` : '';
  $('detail-replies-list').innerHTML = replies.length
    ? replies.map((r) => ticketReplyHtml(r, true)).join('')
    : '<span style="color:#888;font-size:12px;">目前沒有回覆記錄</span>';
  bindAttachmentLinks($('detail-replies-list'));
  bindReplyToggles($('detail-replies-list'));
}

// 右側詳情：欄位順序與名稱對齊EIP總表；所有代碼(狀態/類型/人員ID等)都已由後端轉成文字，這裡不顯示任何裸ID
// syncList=true時(從左側工單點「查看工單詳情」進來)，上面的搜尋列表會被換成只有這一張單，見showTicketAloneInSearchList
async function openTicketSearchDetail(id, syncList = false) {
  $('ticket-search-panel').classList.add('has-detail');
  $('ticket-search-detail').classList.remove('hidden');
  $('ticket-search-detail-title').textContent = '讀取中...';
  $('ticket-search-detail-basic').innerHTML = '';
  $('ticket-search-detail-desc').innerHTML = '';
  $('ticket-search-detail-attachments').innerHTML = '';
  $('ticket-search-detail-replies').innerHTML = '';
  $('ticket-search-reply-count').textContent = '';
  $('ticket-search-not-own').classList.add('hidden');

  const ticket = await call(window.api.eip.getTicket(id), (err) => alert('讀取工單失敗：' + err));
  if (!ticket) return;

  if (syncList) showTicketAloneInSearchList(ticket);

  // 不是自己負責的工單只能查看，標個提示字，避免誤會可以回覆/計時
  const isOwn = state.currentUserId == null || ticket.p_user_id === state.currentUserId;
  $('ticket-search-not-own').classList.toggle('hidden', isOwn);

  $('ticket-search-detail-title').textContent = ticket.summary || '(無摘要)';
  $('ticket-search-detail-id').textContent = formatTicketNo(ticket.id);
  $('btn-ts-jump-to-site').classList.toggle('hidden', !ticket.project_id);
  $('btn-ts-jump-to-project').classList.toggle('hidden', !ticket.project_id);
  // 轉單僅限「專管」身份，且只有「已指派」狀態的工單可以轉(跟後端transfer()的限制一致)
  $('btn-ts-transfer').classList.toggle('hidden', !state.canTransferTicket || ticket.status !== 1);
  // 專管可以回覆別人的工單：回覆表單在左側工單詳情，這裡給個按鈕直接開過去；已結束(成功/關閉/刪除)的單後端不收回覆
  const closed = [2, 4, 8, 9].includes(ticket.status);
  $('btn-ts-reply').classList.toggle('hidden', closed || (!isOwn && !state.canEditAnyTicket));
  $('btn-ts-delete').classList.toggle('hidden', !state.canDeleteTicket || ticket.status === 9);
  if (!isOwn && state.canEditAnyTicket) $('ticket-search-not-own').textContent = '這張工單不是指派給你的，你是專管，可以回覆、轉單或刪除';
  state.currentTicketSearchDetail = ticket; // 給複製工單號／跳去裝機單查詢／轉單的按鈕用

  $('ticket-search-detail-basic').innerHTML = ticketFullInfoRows(ticket);
  bindVersionEditor($('ticket-search-detail-basic'), ticket, (data) => syncTicketVersion(ticket.id, data));
  bindTimeEditors($('ticket-search-detail-basic'), ticket, (data) => syncTicketTimes(ticket.id, data));

  // 描述來自EIP富文本編輯器，本來就是HTML，直接用innerHTML才看得到正確排版
  $('ticket-search-detail-desc').innerHTML = ticket.description || '(無說明)';

  $('ticket-search-detail-attachments').innerHTML = attachmentsHtml(ticket.attachments);

  // API已依時間新到舊排序，跟EIP回覆頁一致，最新的回覆在最上面
  const replies = ticket.replies || [];
  $('ticket-search-reply-count').textContent = replies.length ? `（共 ${replies.length} 則）` : '';
  $('ticket-search-detail-replies').innerHTML = replies.length
    ? replies.map((r) => ticketReplyHtml(r)).join('')
    : '<span style="color:#888;font-size:12px;">目前沒有回覆記錄</span>';

  bindAttachmentLinks($('ticket-search-detail'));
}

async function refreshMail() {
  const result = await call(window.api.mail.listRecent(20), (err) => {
    if (!$('mail-list').children.length) $('mail-list').innerHTML = `<p style="color:#d84f4f;">讀取信箱失敗：${escapeHtml(err)}</p>`;
  });
  if (!result) return { label: '信件', count: 0 };
  const ids = new Set(result.messages.map((message) => String(message.uid)));
  const count = state.refreshSnapshot.initialized
    ? [...ids].filter((id) => !state.refreshSnapshot.mailIds.has(id)).length
    : 0;
  state.refreshSnapshot.mailIds = ids;
  renderMailList(result);
  return { label: '信件', count };
}

async function openMailDetail(uid) {
  $('mail-modal-subject').textContent = '讀取中...';
  $('mail-modal-meta').textContent = '';
  $('mail-modal-frame').srcdoc = '';
  renderMailAttachments(uid, []);
  $('mail-modal-backdrop').classList.remove('hidden');

  const msg = await call(window.api.mail.getMessage(uid), (err) => {
    $('mail-modal-subject').textContent = '讀取失敗';
    $('mail-modal-meta').textContent = err;
  });
  if (!msg) return;

  $('mail-modal-subject').textContent = msg.subject;
  $('mail-modal-meta').textContent = `${msg.from}　${msg.date ? new Date(msg.date).toLocaleString('zh-Hant') : ''}`;
  // 信件內容可能來自不明寄件者，一律丟進不能執行script的sandbox iframe呈現，避免影響到App本身；
  // 只開放popup讓連結可點，加<base target="_blank">讓連結都走新視窗，再由主程序轉給系統瀏覽器開
  if (msg.html) {
    $('mail-modal-frame').srcdoc = `<base target="_blank">${msg.html}`;
  } else {
    $('mail-modal-frame').srcdoc = `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(msg.text || '(無內容)')}</pre>`;
  }
  renderMailAttachments(uid, msg.attachments || []);

  // 後端已回寫伺服器標記已讀，畫面先立即更新這封信與角標，再重新整理一次跟伺服器對齊
  const item = $('mail-list').querySelector(`.mail-item[data-uid="${uid}"]`);
  if (item && item.classList.contains('unread')) {
    item.classList.remove('unread');
    const badge = $('mail-unread-badge');
    const remaining = Math.max(0, (Number(badge.textContent) || 0) - 1);
    badge.textContent = remaining;
    badge.classList.toggle('hidden', remaining === 0);
  }
  refreshMail();
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// 附件點了就跳另存新檔，存好後會在檔案總管裡選取該檔
function renderMailAttachments(uid, attachments) {
  const box = $('mail-modal-attachments');
  box.classList.toggle('hidden', !attachments.length);
  box.innerHTML = attachments
    .map((a) => `<button class="mail-attachment" data-index="${a.index}" title="另存新檔">📎 ${escapeHtml(a.filename)}<span class="size">${formatFileSize(a.size)}</span></button>`)
    .join('');
  box.querySelectorAll('.mail-attachment').forEach((el) => {
    el.addEventListener('click', () => call(window.api.mail.saveAttachment(uid, Number(el.dataset.index))));
  });
}

function closeMailModal() {
  $('mail-modal-backdrop').classList.add('hidden');
  $('mail-modal-frame').srcdoc = '';
}

// ---------------- 行事曆(月曆檢視，含所有分享行事曆) ----------------

function monthRangeForGrid(year, month) {
  // 找出這個月的月曆格子要顯示的完整範圍(含補上個月/下個月的空白格)：從那一週的週日到最後一週的週六
  const firstOfMonth = new Date(year, month, 1);
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());

  const lastOfMonth = new Date(year, month + 1, 0);
  const gridEnd = new Date(lastOfMonth);
  gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()) + 1); // +1讓時間區間是exclusive的上界

  return { gridStart, gridEnd };
}

// 圖例列出「這次抓到的全部行事曆」，不是只列出剛好這個月有事件的，
// 這樣即使某個行事曆這個月沒事，使用者也能確認它有被正確抓到
function renderCalendarLegend(calendars) {
  // 附上這段期間的事件數量，這樣一眼就能分辨「這個行事曆本來就沒事件」還是「抓取失敗」，
  // 不用再猜是不是漏掉了
  $('calendar-legend').innerHTML = calendars
    .map((c) => {
      if (c.error) {
        return `<span class="legend-item" title="抓取失敗：${c.error}">⚠ ${c.name}</span>`;
      }
      return `<span class="legend-item"><span class="legend-dot" style="background:${c.color}"></span>${c.name}(${c.eventCount})</span>`;
    })
    .join('');
}

function renderDayEventsList(dateStr) {
  const events = state.calendar.events.filter((e) => e.start && dateKey(e.start) === dateStr);
  state.calendar.selectedDayEvents = events; // 記下來，點擊事件時用index去查，不用重新篩選
  if (!events.length) {
    $('calendar-day-events').innerHTML = `<p style="color:#888;">${dateStr} 沒有排程</p>`;
    return;
  }
  $('calendar-day-events').innerHTML =
    `<p style="font-weight:600;">${dateStr}</p>` +
    events
      .map((e, i) => {
        const time = e.allDay
          ? '全天'
          : e.start.toLocaleTimeString('zh-Hant', { hour: '2-digit', minute: '2-digit' });
        return `<div class="day-event-item day-event-link" data-index="${i}"><span class="legend-dot" style="background:${e.color}"></span>${time}　${e.summary}　<span style="color:#999;">[${e.calendarName}]</span></div>`;
      })
      .join('');
  $('calendar-day-events').querySelectorAll('.day-event-link').forEach((el) => {
    el.addEventListener('click', () => openEventForEdit(state.calendar.selectedDayEvents[Number(el.dataset.index)]));
  });
}

function renderCalendarGrid() {
  const { year, month } = state.calendar;
  $('calendar-month-label').textContent = `${year}年${month + 1}月`;

  const { gridStart } = monthRangeForGrid(year, month);
  const todayStr = dateKey(new Date());
  const weekdayNames = ['日', '一', '二', '三', '四', '五', '六'];

  const eventsByDay = new Map();
  for (const e of state.calendar.events) {
    if (!e.start) continue;
    const key = dateKey(e.start);
    if (!eventsByDay.has(key)) eventsByDay.set(key, []);
    eventsByDay.get(key).push(e);
  }

  let html = weekdayNames.map((w) => `<div class="calendar-weekday">${w}</div>`).join('');
  const cursor = new Date(gridStart);
  for (let i = 0; i < 42; i++) {
    const key = dateKey(cursor);
    const isOtherMonth = cursor.getMonth() !== month;
    const dayEvents = eventsByDay.get(key) || [];
    const shown = dayEvents.slice(0, 3);
    const more = dayEvents.length - shown.length;

    html += `<div class="calendar-day ${isOtherMonth ? 'other-month' : ''} ${key === todayStr ? 'today' : ''} ${key === state.calendar.selectedDate ? 'selected' : ''}" data-date="${key}">
      <div class="calendar-day-num">${cursor.getDate()}</div>
      ${shown.map((e) => `<div class="calendar-day-event" style="background:${e.color}">${e.summary}</div>`).join('')}
      ${more > 0 ? `<div class="calendar-day-more">+${more}</div>` : ''}
    </div>`;
    cursor.setDate(cursor.getDate() + 1);
  }
  $('calendar-grid').innerHTML = html;

  $('calendar-grid').querySelectorAll('.calendar-day').forEach((el) => {
    el.addEventListener('click', () => {
      state.calendar.selectedDate = el.dataset.date;
      renderCalendarGrid();
      renderDayEventsList(el.dataset.date);
    });
  });

  renderCalendarLegend(state.calendar.calendars || []);
  renderDayEventsList(state.calendar.selectedDate);
}

async function refreshCalendar() {
  const { gridStart, gridEnd } = monthRangeForGrid(state.calendar.year, state.calendar.month);
  const result = await call(window.api.calendar.listRange(gridStart.toISOString(), gridEnd.toISOString()), () => {
    // 保留目前日曆內容，避免背景刷新失敗時整個區塊閃爍或消失
  });
  if (result) {
    const events = result.events || [];
    const calendars = result.calendars || [];
    const ids = new Set(events.map((event) => String(event.uid || event.id || `${event.start}|${event.summary}|${event.calendarName}`)));
    const count = state.refreshSnapshot.initialized
      ? [...ids].filter((id) => !state.refreshSnapshot.calendarIds.has(id)).length
      : 0;
    state.refreshSnapshot.calendarIds = ids;
    const dataSignature = JSON.stringify({ year: state.calendar.year, month: state.calendar.month, events, calendars });
    if (dataSignature === state.calendar.dataSignature) return { label: '行事曆', count };
    state.calendar.events = events;
    state.calendar.calendars = calendars;
    state.calendar.dataSignature = dataSignature;
    renderCalendarGrid();
    return { label: '行事曆', count };
  }
  return { label: '行事曆', count: 0 };
}

function changeCalendarMonth(delta) {
  state.calendar.month += delta;
  if (state.calendar.month < 0) {
    state.calendar.month = 11;
    state.calendar.year -= 1;
  } else if (state.calendar.month > 11) {
    state.calendar.month = 0;
    state.calendar.year += 1;
  }
  refreshCalendar();
}

function goToCurrentMonth() {
  const now = new Date();
  state.calendar.year = now.getFullYear();
  state.calendar.month = now.getMonth();
  state.calendar.selectedDate = dateKey(now);
  refreshCalendar();
}

function openAddEventForm() {
  state.calendar.editingEvent = null;
  $('add-event-form').classList.remove('hidden');
  $('new-event-title').value = '';
  $('new-event-allday').checked = true;
  $('new-event-time').value = '09:00';
  $('btn-submit-new-event').textContent = '新增';
  $('btn-delete-event').classList.add('hidden');
  $('add-event-message').textContent = '';
}

function openEventForEdit(event) {
  if (!event) return;
  state.calendar.editingEvent = event;
  $('add-event-form').classList.remove('hidden');
  $('new-event-title').value = event.summary || '';
  $('new-event-allday').checked = !!event.allDay;
  $('new-event-time').value = event.allDay
    ? '09:00'
    : `${String(event.start.getHours()).padStart(2, '0')}:${String(event.start.getMinutes()).padStart(2, '0')}`;
  // 編輯時沿用原本事件所在那一天，日期本身不提供修改(避免表單過於複雜)，要換日期就刪掉重建
  state.calendar.selectedDate = dateKey(event.start);
  $('btn-submit-new-event').textContent = '更新';
  $('btn-delete-event').classList.remove('hidden');
  $('add-event-message').textContent = '';
}

function cancelEventForm() {
  state.calendar.editingEvent = null;
  $('add-event-form').classList.add('hidden');
  $('new-event-title').value = '';
  $('add-event-message').textContent = '';
}

function buildEventTimeFromForm() {
  const allDay = $('new-event-allday').checked;
  const dateStr = state.calendar.selectedDate;
  if (allDay) {
    return { start: `${dateStr}T00:00:00`, allDay };
  }
  const time = $('new-event-time').value || '09:00';
  return { start: `${dateStr}T${time}:00`, allDay };
}

async function submitNewEvent() {
  const title = $('new-event-title').value.trim();
  if (!title) {
    $('add-event-message').textContent = '請輸入標題';
    return;
  }
  const { start, allDay } = buildEventTimeFromForm();
  const editing = state.calendar.editingEvent;

  const action = editing
    ? window.api.calendar.updateEvent({ url: editing.url, uid: editing.uid, summary: title, start, allDay })
    : window.api.calendar.createEvent({ summary: title, start, allDay });

  $('add-event-message').textContent = editing ? '更新中...' : '新增中...';
  const result = await call(action, (err) => {
    $('add-event-message').textContent = (editing ? '更新失敗：' : '新增失敗：') + err;
  });
  if (!result) return;

  $('add-event-message').textContent = editing ? '已更新' : '已新增';
  cancelEventForm();
  refreshCalendar();
}

async function deleteCurrentEvent() {
  const editing = state.calendar.editingEvent;
  if (!editing) return;
  if (!confirm(`確定要刪除「${editing.summary}」這筆事件嗎？`)) return;

  $('add-event-message').textContent = '刪除中...';
  const result = await call(window.api.calendar.deleteEvent({ url: editing.url }), (err) => {
    $('add-event-message').textContent = '刪除失敗：' + err;
  });
  if (!result) return;

  $('add-event-message').textContent = '已刪除';
  cancelEventForm();
  refreshCalendar();
}

// ---------------- 工單清單(含inline計時器，因為多張工單可能同時在跑) ----------------

function timerControlsHtml(ticket) {
  if (ticket.pending_reply) {
    return '<div class="card-timer-note">已完成，等待工程師回覆並設為成功，不需要計時</div>';
  }
  if (ticket.is_qc_stage) {
    return '<div class="card-timer-note">品保審核中，不需要計時</div>';
  }
  const timer = state.timers[ticket.id] || { status: 'idle', segments: [] };
  const seconds = liveSecondsOf(timer);
  const isRunning = timer.status === 'running';
  const isPaused = timer.status === 'paused';
  return `
    <div class="card-timer" data-timer-for="${ticket.id}">
      <span class="card-timer-display">${formatSeconds(seconds)}</span>
      <button class="btn-card-start" data-id="${ticket.id}" ${isRunning ? 'disabled' : ''}>開始</button>
      <button class="btn-card-pause" data-id="${ticket.id}" ${isRunning ? '' : 'disabled'}>暫停</button>
      <button class="btn-card-stop" data-id="${ticket.id}" ${isRunning || isPaused ? '' : 'disabled'}>停止</button>
    </div>`;
}

function filteredTickets() {
  const byTab = state.projectView
    ? (state.projectView.engineerId == null ? state.tickets : state.tickets.filter((t) => String(t.p_user_id) === String(state.projectView.engineerId)))
    : state.tickets.filter((t) => (state.activeTab === 'qc' ? t.is_qc_stage : !t.is_qc_stage));
  const q = state.searchQuery.trim().toLowerCase();
  const filtered = !q ? byTab : byTab.filter((t) => {
    return (
      String(t.id).includes(q) ||
      (t.summary || '').toLowerCase().includes(q) ||
      (t.project_name || '').toLowerCase().includes(q)
    );
  });
  return filtered.sort((a, b) => {
    if (!!a.pending_reply !== !!b.pending_reply) return a.pending_reply ? 1 : -1;
    const aTime = Date.parse(ticketDueValue(a));
    const bTime = Date.parse(ticketDueValue(b));
    if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
    if (Number.isNaN(aTime)) return 1;
    if (Number.isNaN(bTime)) return -1;
    return aTime - bTime;
  });
}

function ticketDueValue(ticket) {
  return ticket.end_time || ticket.due_time || ticket.deadline || ticket.expected_end_time || ticket.planned_end_time || '';
}

function ticketDueClass(ticket) {
  const dueTime = Date.parse(ticketDueValue(ticket));
  if (Number.isNaN(dueTime)) return '';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekEnd = new Date(today);
  weekEnd.setDate(today.getDate() + (7 - today.getDay()));
  weekEnd.setHours(23, 59, 59, 999);
  if (dueTime < today.getTime()) return 'ticket-due-overdue';
  if (dueTime <= weekEnd.getTime()) return 'ticket-due-soon';
  return '';
}

function updateTabCounts() {
  // 「待處理」後面的數字只算送QC之前(新任務/已指派/已暫停/追蹤中…)；已完成(待回覆成功)的會列在清單裡但不計入，另外用 ✔ 標示張數
  const normalCount = state.tickets.filter((t) => !t.is_qc_stage && !t.pending_reply).length;
  const finishedCount = state.tickets.filter((t) => t.pending_reply).length;
  const qcCount = state.tickets.filter((t) => t.is_qc_stage).length;
  $('tab-count-normal').textContent = `(${normalCount})${finishedCount ? ` ✔${finishedCount}` : ''}`;
  $('tab-count-normal').title = finishedCount ? `${normalCount} 張待處理；另有 ${finishedCount} 張已完成，等待回覆並設為成功(列在清單最後，用 ✔ 標示)` : '';
  $('tab-count-qc').textContent = `(${qcCount})`;
}

function switchTab(tab) {
  state.activeTab = tab;
  state.selectedIds.clear();
  document.querySelectorAll('.tab-btn').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  updateBatchBar();
  renderTicketList();
}

function renderTicketList() {
  const container = $('ticket-list');
  if (!state.projectView) updateTabCounts();
  const tickets = filteredTickets();
  // 搜尋框旁顯示實際列出的張數
  $('ticket-shown-count').textContent = `${tickets.length} 張`;
  if (!tickets.length) {
    const emptyText = state.searchQuery
      ? '沒有符合搜尋的工單'
      : state.projectView
      ? '這個專案在目前的篩選下沒有工單'
      : state.activeTab === 'qc'
      ? '目前沒有品保審核中的工單'
      : state.ticketRange === 'next' ? '目前沒有下週五之前需要處理的工單' : state.ticketRange === 'all' ? '目前沒有未結案的工單' : '目前沒有本週五之前需要處理的工單';
    container.innerHTML = `<p>${emptyText}。</p>`;
    return;
  }
  // 檢視其他工程師的工單時只能看：不顯示批次勾選、計時、附加檔案(後端也只允許本人回覆/附檔)；專管例外，可以直接處理
  const readonlyAll = isViewingOtherEngineer() && !state.canEditAnyTicket;
  // 專案工單檢視：混著各工程師的單，逐張判斷是不是自己的(別人的單非專管只能看)
  const readonlyOf = (t) => (state.projectView
    ? !state.canEditAnyTicket && Number(t.p_user_id) !== Number(state.currentUserId)
    : readonlyAll);
  container.innerHTML = tickets
    .map((t) => {
      const readonly = readonlyOf(t);
      return `
      <div class="ticket-card ${t.pending_reply ? 'ticket-finished' : ticketDueClass(t)}" data-id="${t.id}">
        <div class="row1">
          ${readonly ? '' : `<label class="card-select"><input type="checkbox" class="chk-select" data-id="${t.id}" ${state.selectedIds.has(String(t.id)) ? 'checked' : ''} /></label>`}
          <span>#${t.id} ${t.project_name || t.name || ''}</span>${statusBadge(t)}
        </div>
        <div class="summary">${t.summary || ''}</div>
        <div class="meta">${state.projectView && t.p_user_name ? `負責：${escapeHtml(t.p_user_name)}　` : ''}${t.created_at ? `建單：${escapeHtml(String(t.created_at).slice(0, 10))}　` : ''}開始：${t.start_time || '-'}　預定完成：${ticketDueValue(t) || '-'}${t.version_text ? `　版本：${escapeHtml(t.version_text)}` : ''}</div>
        ${readonly && !t.pending_reply ? '' : timerControlsHtml(t)}
        <div class="card-actions-row">
          <button class="btn-card-view-full" data-id="${t.id}" title="在右側打開這張工單的完整詳情">查看工單</button>
          <button class="btn-card-copy-id" data-id="${t.id}" title="複製工單號到剪貼簿">複製單號</button>
          ${readonly ? '' : `<button class="btn-card-attach" data-id="${t.id}" title="不寫回覆，直接上傳檔案掛到這張工單">附加檔案</button>`}
        </div>
      </div>`;
    })
    .join('');

  // 整張卡片都能點開詳情，只有勾選框/計時按鈕/附加檔案這些「卡片上的其他操作」要排除，不然會被誤觸連帶打開詳情
  container.querySelectorAll('.ticket-card').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('button, input, label')) return;
      openTicketDetail(el.dataset.id);
    });
  });
  container.querySelectorAll('.btn-card-view-full').forEach((el) => {
    el.addEventListener('click', () => viewTicketFullInSidebar(el.dataset.id));
  });
  container.querySelectorAll('.btn-card-copy-id').forEach((el) => {
    el.addEventListener('click', () => copyWithFeedback(el, el.dataset.id));
  });
  container.querySelectorAll('.btn-card-attach').forEach((el) => {
    el.addEventListener('click', () => pickAndAttachForCard(el.dataset.id));
  });
  container.querySelectorAll('.btn-card-start').forEach((el) => {
    el.addEventListener('click', () => onCardTimerAction(el.dataset.id, 'start'));
  });
  container.querySelectorAll('.btn-card-pause').forEach((el) => {
    el.addEventListener('click', () => onCardTimerAction(el.dataset.id, 'pause'));
  });
  container.querySelectorAll('.btn-card-stop').forEach((el) => {
    el.addEventListener('click', () => onCardTimerAction(el.dataset.id, 'stop'));
  });
  container.querySelectorAll('.chk-select').forEach((el) => {
    el.addEventListener('change', () => {
      if (el.checked) state.selectedIds.add(el.dataset.id);
      else state.selectedIds.delete(el.dataset.id);
      updateBatchBar();
    });
  });
}

async function pickAndAttachForCard(ticketId) {
  const filePath = await call(window.api.dialog.pickFile());
  if (!filePath) return;
  const uploaded = await call(window.api.eip.uploadFile(filePath), (err) => alert('上傳失敗：' + err));
  if (!uploaded) return;
  await call(window.api.eip.attachFile(ticketId, uploaded.file_id), (err) => alert('附加到工單失敗：' + err));
  alert('已附加到工單');
}

// ---------------- 批次選取／提交(同一個專案的多張工單可以一起送出) ----------------

function selectedTickets() {
  return state.tickets.filter((t) => state.selectedIds.has(String(t.id)));
}

// 已完成(品保通過、等工程師回覆送品保)的工單：後端待辦清單不回傳，是桌面工具另外查出來標上 pending_reply 的
function isFinishedTicket(t) {
  return Number(t.status) === 2 && !t.is_qc_stage;
}

// 「完成並送品保」不能用的原因；空字串=可以
function finishBlockReason(selected) {
  if (!selected.length) return '';
  if (isViewingOtherEngineer()) return '只能處理自己負責的工單(目前在看別人的清單)';
  const notFinished = selected.filter((t) => !isFinishedTicket(t));
  if (notFinished.length) return `只有「已完成」狀態的工單可以送品保，所選有 ${notFinished.length} 張不是`;
  const notMine = selected.filter((t) => state.currentUserId != null && Number(t.p_user_id) !== Number(state.currentUserId));
  if (notMine.length) return `只能處理自己負責的工單，所選有 ${notMine.length} 張不是你的`;
  return '';
}

// 勾選1張以上就顯示批次操作列；各按鈕依所選工單是否符合條件啟用/停用，停用時把原因寫在按鈕的提示文字
function updateBatchBar() {
  const selected = selectedTickets();
  const bar = $('batch-bar');
  if (!selected.length) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');

  // 批次回覆：沿用原本限制，至少2張、同一專案、品保階段一致(回覆內容/Git commit是同一份)
  const projectIds = new Set(selected.map((t) => String(t.project_id || '')));
  const qcStages = new Set(selected.map((t) => !!t.is_qc_stage));
  let replyBlock = '';
  if (selected.length < 2) replyBlock = '批次回覆至少要選2張；單張請直接點開工單回覆';
  else if (projectIds.size > 1) replyBlock = '分屬不同專案，批次回覆只支援同一個專案';
  else if (qcStages.size > 1) replyBlock = '有的已轉品保有的還沒，批次回覆需要階段一致';
  // 已完成的單走「完成並送品保」，不能用一般的批次回覆(狀態選項不同)
  const finishedSelected = selected.filter(isFinishedTicket);
  if (finishedSelected.length) replyBlock = '所選包含「已完成」的工單，請改用「完成並送品保」(一般批次回覆不適用)';
  $('btn-batch-open').disabled = !!replyBlock;
  $('btn-batch-open').title = replyBlock || '同一段回覆送到所選的每一張工單';

  // 完成並送品保：只能用在「已完成」狀態、而且是自己負責的工單(跟後端reply()的限制一致)
  const finishBlock = finishBlockReason(selected);
  $('btn-batch-finish').disabled = !!finishBlock;
  $('btn-batch-finish').title = finishBlock || '把所選已完成的工單回覆「完成專案」並轉品保(第二次送QC)';

  // 批次轉單：僅限專管，且全部都要是「已指派」(跟後端transfer()的限制一致)
  $('btn-batch-transfer').classList.toggle('hidden', !state.canTransferTicket);
  const notAssigned = selected.filter((t) => t.status !== 1);
  $('btn-batch-transfer').disabled = notAssigned.length > 0;
  $('btn-batch-transfer').title = notAssigned.length
    ? `只有「已指派」狀態的工單可以轉單，所選有 ${notAssigned.length} 張不是`
    : '把所選工單轉給同一位工程師(僅限專管)';

  $('btn-batch-delete').classList.toggle('hidden', !state.canDeleteTicket);

  $('batch-bar-text').textContent = `已選 ${selected.length} 張工單${projectIds.size === 1 ? '(同一專案)' : `(${projectIds.size} 個專案)`}${replyBlock ? `　※${replyBlock}` : ''}`;
}

// 全選目前畫面上(目前頁籤＋搜尋條件篩選後)的工單
function selectAllVisibleTickets() {
  filteredTickets().forEach((t) => state.selectedIds.add(String(t.id)));
  renderTicketList();
  updateBatchBar();
}

// 批次轉單/刪除完成後：清掉已處理的勾選、重新整理清單；左側正在看其中一張就重新讀取
function afterBatchTicketAction(doneIds) {
  doneIds.forEach((id) => state.selectedIds.delete(String(id)));
  if (state.currentTicket && doneIds.map(String).includes(String(state.currentTicket.id))) backToList();
  updateBatchBar();
  refreshTicketList();
}

function clearSelection() {
  state.selectedIds.clear();
  updateBatchBar();
  renderTicketList();
}

// mode='finish'：已完成的工單批次「完成專案並轉品保」(1張也可以)；預設是一般批次回覆(至少2張)
async function openBatchPanel(mode) {
  const finishMode = mode === 'finish';
  const selected = selectedTickets();
  if (finishMode ? !selected.length || finishBlockReason(selected) : selected.length < 2) return;

  $('ticket-list-view').classList.add('hidden');
  $('batch-bar').classList.add('hidden');
  $('batch-panel').classList.remove('hidden');
  $('batch-panel-list').textContent = selected.map((t) => `#${t.id} ${t.summary || ''}`).join('、');
  $('batch-panel-title').textContent = finishMode ? '批次提交：完成專案並轉品保' : '批次提交';
  // 完成專案送品保的回覆內容仍然必填(網頁版也要寫回覆)，先帶一句可修改的預設文字
  $('batch-reply-info').value = finishMode ? '已完成確認，送品保。' : '';
  $('batch-reply-commit-message').value = '';
  const isQcStage = !!selected[0].is_qc_stage;
  $('batch-reply-status').innerHTML = buildStatusOptionsHtml(isQcStage, selected[0].status);
  $('batch-reply-status').disabled = finishMode; // 完成專案只有一個選項(4)，固定
  $('batch-transfer-to-label').classList.add('hidden');
  $('batch-message').textContent = '';

  // 批次的回覆範本類型預設帶第一張工單已設定的本地類型(沒設定過就照EIP類型猜)，使用者仍可自行改
  const savedType = await call(window.api.ticketMeta.getType(selected[0].id));
  $('batch-reply-type').value = savedType || defaultLocalTypeFor(selected[0]);

  $('batch-git-mode-uncommitted').checked = true;
  $('batch-git-commits-box').classList.add('hidden');
  $('batch-git-commits-list').innerHTML = '';
  $('batch-git-extra-note').value = '';
  $('batch-ai-status').textContent = '';

  renderBatchTimeList(selected);
}

function backFromBatch() {
  $('batch-reply-status').disabled = false;
  $('batch-panel').classList.add('hidden');
  $('ticket-list-view').classList.remove('hidden');
  refreshTicketList();
}

async function submitBatch() {
  const selected = selectedTickets();
  const info = $('batch-reply-info').value.trim();
  const status = $('batch-reply-status').value;
  // 10=完成並轉品保(可選轉品保/客服)；4=已完成的單「完成專案」，後端自動轉品保
  const transferTo = status === '10' ? $('batch-reply-transfer-to').value : status === '4' ? 'quality_assurance' : '';
  if (!info) {
    $('batch-message').textContent = '請先填寫共用回覆內容';
    return;
  }

  let okCount = 0;
  const errors = [];
  for (const ticket of selected) {
    $('batch-message').textContent = `送出中... (${okCount + errors.length + 1}/${selected.length})`;
    const stopped = await call(window.api.timer.stop(ticket.id));
    const payload = {
      info,
      status,
      transfer_to: transferTo,
      work_start_time: stopped ? stopped.firstStart : undefined,
      work_end_time: stopped ? stopped.lastEnd : undefined,
      actual_duration_seconds: stopped ? stopped.totalSeconds : undefined,
    };
    const result = await call(window.api.eip.replyTicket(ticket.id, payload), (err) => {
      errors.push(`#${ticket.id}: ${err}`);
    });
    if (result) {
      okCount++;
      await window.api.timer.reset(ticket.id);
      delete state.timers[ticket.id];
    }
  }

  state.selectedIds.clear();
  if (errors.length === 0) {
    $('batch-message').textContent = `全部送出成功(${okCount}張)，回到清單...`;
    setTimeout(backFromBatch, 1000);
  } else {
    $('batch-message').textContent = `完成${okCount}張，失敗${errors.length}張：${errors.join('；')}`;
  }
}

// 批次的AI產生回覆：跟單張工單詳情共用同一套git來源選擇邏輯(未commit變更／已commit的commit)，
// 差別在這裡的來源是「選取的多張工單共用同一個專案」，回覆內容也是產生「一份」共用文字
function onBatchGitSourceModeChange() {
  const mode = document.querySelector('input[name="batch-git-source-mode"]:checked').value;
  $('batch-git-commits-box').classList.toggle('hidden', mode !== 'commits');
}

async function loadBatchCommitsList() {
  const selected = selectedTickets();
  if (selected.length < 2) return;
  $('batch-git-commits-list').innerHTML = '<p class="meta">讀取中...</p>';
  const commits = await call(
    window.api.git.listCommits(selected[0].project_id, 30),
    (err) => {
      $('batch-git-commits-list').innerHTML = `<p style="color:#c0392b;">${escapeHtml(err)}</p>`;
    }
  );
  if (!commits) return;
  if (!commits.length) {
    $('batch-git-commits-list').innerHTML = '<p class="meta">這個專案的git路徑裡沒有提交紀錄</p>';
    return;
  }
  $('batch-git-commits-list').innerHTML = commitListHtml(commits);
  bindCommitList($('batch-git-commits-list'), selected[0].project_id);
}

async function generateBatchAiReply() {
  const selected = selectedTickets();
  if (selected.length < 2) return;
  $('batch-ai-status').textContent = 'AI產生中，請稍候...(git讀取+LLM，可能需要幾秒到數十秒)';

  const mode = document.querySelector('input[name="batch-git-source-mode"]:checked').value;
  const projectId = selected[0].project_id;
  let source;

  if (mode === 'commits') {
    const checked = Array.from($('batch-git-commits-list').querySelectorAll('input[type="checkbox"]:checked')).map(
      (el) => el.value
    );
    if (!checked.length) {
      $('batch-ai-status').textContent = '請先載入並勾選至少一筆commit';
      return;
    }
    const detail = await call(window.api.git.getCommitsDetail(projectId, checked), (err) => {
      $('batch-ai-status').textContent = '讀取Git commit失敗：' + err;
    });
    if (!detail) return;
    source = { mode: 'commits', commits: detail.commits };
  } else {
    const gitChanges = await call(window.api.git.collectChanges(null, projectId), (err) => {
      $('batch-ai-status').textContent = '讀取Git失敗：' + err;
    });
    if (!gitChanges) return;
    source = { mode: 'uncommitted', ...gitChanges };
  }

  // 批次列表(state.tickets)本身沒有description，AI要寫回覆需要每張單真正的需求說明，逐張補抓完整資料
  const tickets = [];
  for (const t of selected) {
    const full = await call(window.api.eip.getTicket(t.id), (err) => {
      $('batch-ai-status').textContent = `讀取工單#${t.id}失敗：${err}`;
    });
    if (!full) return;
    tickets.push(full);
  }

  const type = $('batch-reply-type').value;
  const templateText = (type && state.settings.replyTemplates && state.settings.replyTemplates[type]) || '';
  const typeLabel = TICKET_TYPE_LABELS[type] || '';
  const durationSeconds = selected.reduce((sum, t) => sum + liveSecondsOf(state.timers[t.id]), 0);

  const result = await call(
    window.api.llm.generateBatchReply({
      tickets,
      source,
      durationSeconds,
      userNote: $('batch-git-extra-note').value.trim(),
      templateText,
      typeLabel,
    }),
    (err) => {
      $('batch-ai-status').textContent = 'AI產生失敗：' + err;
    }
  );
  if (!result) return;

  $('batch-reply-info').value = result.reply || '';
  $('batch-reply-commit-message').value = result.commitMessage || '';
  $('batch-ai-status').textContent = '已產生，請自行確認/編輯後再送出(批次不會自動執行git commit，commit訊息請自行複製手動提交)。';
}

async function onCardTimerAction(ticketId, action) {
  const result = await call(window.api.timer[action](ticketId));
  if (!result) return;
  if (action === 'stop') {
    // stop回傳的是統計摘要，不是{status,segments}，重新問一次目前狀態
    state.timers[ticketId] = await call(window.api.timer.get(ticketId));
  } else {
    state.timers[ticketId] = result;
  }
  renderTicketList();
  if (state.currentTicket && String(state.currentTicket.id) === String(ticketId)) {
    updateDetailTimerDisplay();
  }
  if (!$('batch-panel').classList.contains('hidden')) {
    renderBatchTimeList(selectedTickets());
  }
}

// ---------------- 批次提交：各工單時間(逐張列出，可個別手動調整，套用後submitBatch會照各自的設定結算) ----------------

function batchTimeRow(ticketId) {
  return document.querySelector(`.batch-time-row[data-id="${ticketId}"]`);
}

function renderBatchTimeList(selected) {
  $('batch-time-list').innerHTML = selected
    .map((t) => {
      const timer = state.timers[t.id];
      const manual = timer && timer.manual;
      const manualSummary = manual ? manualSummaryText(manual) : '';
      return `
      <div class="batch-time-row" data-id="${t.id}">
        <div class="batch-time-head">
          <strong>#${t.id}</strong> <span>${escapeHtml(t.summary || '')}</span>
        </div>
        ${timerControlsHtml(t)}
        ${manual ? `<p class="batch-time-manual-summary meta">${escapeHtml(manualSummary)}</p>` : ''}
        <div class="actions">
          <button type="button" class="btn-batch-time-manual-toggle" data-id="${t.id}">手動設定時間</button>
          ${manual ? `<button type="button" class="btn-batch-manual-clear-outer" data-id="${t.id}">清除手動設定</button>` : ''}
        </div>
        <div class="batch-time-manual-form hidden">
          <div class="manual-grid">
            <label>開始時間 <input type="datetime-local" class="batch-manual-start" /></label>
            <label>結束時間 <input type="datetime-local" class="batch-manual-end" /></label>
            <label>用時
              <span class="manual-duration"><input type="number" class="batch-manual-hours" min="0" step="1" /> 小時 <input type="number" class="batch-manual-minutes" min="0" max="59" step="1" /> 分</span>
            </label>
          </div>
          <div class="actions">
            <button type="button" class="btn-batch-manual-apply" data-id="${t.id}">套用</button>
            <button type="button" class="btn-batch-manual-cancel" data-id="${t.id}">收起</button>
          </div>
          <p class="batch-manual-message meta"></p>
        </div>
      </div>`;
    })
    .join('');
  bindBatchTimeListEvents();
}

function bindBatchTimeListEvents() {
  const container = $('batch-time-list');
  container.querySelectorAll('.btn-card-start').forEach((el) => el.addEventListener('click', () => onCardTimerAction(el.dataset.id, 'start')));
  container.querySelectorAll('.btn-card-pause').forEach((el) => el.addEventListener('click', () => onCardTimerAction(el.dataset.id, 'pause')));
  container.querySelectorAll('.btn-card-stop').forEach((el) => el.addEventListener('click', () => onCardTimerAction(el.dataset.id, 'stop')));
  container.querySelectorAll('.btn-batch-time-manual-toggle').forEach((el) => el.addEventListener('click', () => openBatchManualForm(el.dataset.id)));
  container.querySelectorAll('.btn-batch-manual-clear-outer').forEach((el) => el.addEventListener('click', () => clearBatchManualTime(el.dataset.id)));
  container.querySelectorAll('.btn-batch-manual-apply').forEach((el) => el.addEventListener('click', () => applyBatchManualTime(el.dataset.id)));
  container.querySelectorAll('.btn-batch-manual-cancel').forEach((el) => el.addEventListener('click', () => closeBatchManualForm(el.dataset.id)));
  container.querySelectorAll('.batch-manual-start, .batch-manual-end').forEach((el) => {
    el.addEventListener('change', () => autoFillBatchManualDuration(el.closest('.batch-time-row')));
  });
}

// 開啟某一張工單的手動設定表單：帶入邏輯跟單張工單詳情的openManualForm一致(已手動設定過就帶原值，
// 否則有計時紀錄就帶入方便微調)，只是這裡改成操作該行自己的欄位，不影響其他工單
function openBatchManualForm(ticketId) {
  const row = batchTimeRow(ticketId);
  if (!row) return;
  const prefill = manualFormPrefill(state.timers[ticketId]);
  const formEl = row.querySelector('.batch-time-manual-form');
  formEl.querySelector('.batch-manual-start').value = prefill ? prefill.start : '';
  formEl.querySelector('.batch-manual-end').value = prefill ? prefill.end : '';
  formEl.querySelector('.batch-manual-hours').value = prefill ? prefill.hours : '';
  formEl.querySelector('.batch-manual-minutes').value = prefill ? prefill.minutes : '';
  formEl.querySelector('.batch-manual-message').textContent = prefill ? prefill.message : '';
  formEl.classList.remove('hidden');
}

function closeBatchManualForm(ticketId) {
  const row = batchTimeRow(ticketId);
  if (row) row.querySelector('.batch-time-manual-form').classList.add('hidden');
}

// 起訖時間都填了就先用「結束−開始」帶入用時，使用者再依實際扣掉休息時間微調(跟單張詳情的autoFillManualDuration邏輯一致)
function autoFillBatchManualDuration(row) {
  if (!row) return;
  const s = row.querySelector('.batch-manual-start').value;
  const e = row.querySelector('.batch-manual-end').value;
  if (!s || !e) return;
  const diff = Math.round((new Date(e).getTime() - new Date(s).getTime()) / 1000);
  if (diff <= 0) return;
  row.querySelector('.batch-manual-hours').value = Math.floor(diff / 3600);
  row.querySelector('.batch-manual-minutes').value = Math.floor((diff % 3600) / 60);
}

async function applyBatchManualTime(ticketId) {
  const row = batchTimeRow(ticketId);
  if (!row) return;
  const formEl = row.querySelector('.batch-time-manual-form');
  const msgEl = formEl.querySelector('.batch-manual-message');
  const s = formEl.querySelector('.batch-manual-start').value;
  const e = formEl.querySelector('.batch-manual-end').value;
  if (!s || !e) {
    msgEl.textContent = '請填開始與結束時間';
    return;
  }
  const seconds =
    (Number(formEl.querySelector('.batch-manual-hours').value) || 0) * 3600 +
    (Number(formEl.querySelector('.batch-manual-minutes').value) || 0) * 60;
  const timer = await call(
    window.api.timer.setManual(ticketId, { start: new Date(s).toISOString(), end: new Date(e).toISOString(), seconds }),
    (err) => {
      msgEl.textContent = '設定失敗：' + err;
    }
  );
  if (!timer) return;
  state.timers[ticketId] = timer;
  renderTicketList();
  renderBatchTimeList(selectedTickets());
}

async function clearBatchManualTime(ticketId) {
  const timer = await call(window.api.timer.clearManual(ticketId));
  if (!timer) return;
  state.timers[ticketId] = timer;
  renderTicketList();
  renderBatchTimeList(selectedTickets());
}

// 每秒只更新畫面上的數字，不重新整理整個清單(避免閃爍、也不用一直問main process)
function tick() {
  document.querySelectorAll('[data-timer-for]').forEach((el) => {
    const ticketId = el.dataset.timerFor;
    const timer = state.timers[ticketId];
    if (!timer) return;
    const display = el.querySelector('.card-timer-display');
    if (display) display.textContent = formatSeconds(liveSecondsOf(timer));
  });
  updateDetailTimerDisplay();
}

// ---------------- 切換工程師(專案管理分配工作時查看每個人的工單) ----------------

function isViewingOtherEngineer() {
  return state.viewUserId != null && state.viewUserId !== Number(state.currentUserId);
}

// 工程部排最前面(後端已排好)，其他部門的人放到下面另一組；舊版後端沒有這支API就整個選單藏起來，不影響看自己的工單
async function loadEngineers() {
  const engineers = await call(window.api.eip.listEngineers(), () => {});
  if (!engineers || !engineers.length) {
    document.querySelector('.engineer-picker').classList.add('hidden');
    return;
  }
  state.engineers = engineers;
  const optionHtml = (u) =>
    `<option value="${u.id}">${escapeHtml(u.name)}${String(u.id) === String(state.currentUserId) ? '（我）' : ''}</option>`;
  const engineering = engineers.filter((u) => u.is_engineering);
  const others = engineers.filter((u) => !u.is_engineering);
  $('engineer-select').innerHTML =
    (engineering.length ? `<optgroup label="工程部">${engineering.map(optionHtml).join('')}</optgroup>` : '') +
    (others.length ? `<optgroup label="其他人員">${others.map(optionHtml).join('')}</optgroup>` : '');
  if (state.currentUserId != null) $('engineer-select').value = String(state.currentUserId);
}

function switchEngineer() {
  if (state.projectView) { // 專案工單檢視中：選工程師=只看這個人的單，不是切換成看他的待辦清單
    state.projectView.engineerId = $('engineer-select').value === '' ? null : Number($('engineer-select').value);
    state.selectedIds.clear(); // 換了篩選，之前勾選(可能已看不到)的先清掉，避免誤轉看不見的單
    renderTicketList();
    updateBatchBar();
    return;
  }
  const id = Number($('engineer-select').value);
  state.viewUserId = id && id !== Number(state.currentUserId) ? id : null;
  const viewing = isViewingOtherEngineer();
  const who = viewing ? (state.engineers.find((u) => Number(u.id) === id) || {}).name : '';
  $('topbar-title').textContent = viewing ? `${who} 的工單` : '我的工單';
  $('engineer-readonly-hint').textContent = state.canEditAnyTicket ? '檢視他人工單（專管可回覆）' : '檢視他人工單，僅供查看';
  $('engineer-readonly-hint').classList.toggle('hidden', !viewing);
  state.selectedIds.clear();
  updateBatchBar();
  state.tickets = [];
  $('ticket-list').innerHTML = '<p style="color:#888;">讀取中...</p>';
  updateTabCounts();
  refreshTicketList();
}

// 下週五的日期字串(YYYY-MM-DD)；算法跟後端 thisFridayEndOfDay 一致：本週五(週六日算已過去的那個週五)再加7天
function nextFridayDateStr() {
  const d = new Date();
  const dow = d.getDay() === 0 ? 7 : d.getDay(); // 1=週一 ... 7=週日
  d.setDate(d.getDate() + (5 - dow) + 7);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function updateRangeUi() {
  document.querySelectorAll('#ticket-range .range-btn').forEach((el) => el.classList.toggle('active', el.dataset.range === state.ticketRange));
  $('ticket-range-date').textContent = state.ticketRange === 'next' ? `(開始時間 ≤ ${nextFridayDateStr()})` : state.ticketRange === 'all' ? '(不限開始日期)' : '';
  $('ticket-range').classList.toggle('hidden', !!state.projectView);
}

function switchTicketRange(range) {
  if (state.ticketRange === range) return;
  state.ticketRange = range;
  state.selectedIds.clear();
  updateBatchBar();
  updateRangeUi();
  $('ticket-list').innerHTML = '<p style="color:#888;">讀取中...</p>';
  refreshTicketList();
}

async function refreshTicketList() {
  // 專案工單檢視中：重新讀的是該專案的工單，不能被工程師待辦清單蓋掉
  if (state.projectView) {
    await loadProjectViewTickets();
    return { label: '工單', count: 0 };
  }
  const viewUserId = state.viewUserId;
  const assigneeId = viewUserId || state.currentUserId;
  const [tickets, timers, finishedRes] = await Promise.all([
    call(window.api.eip.listTickets(state.ticketRange === 'next' ? nextFridayDateStr() : state.ticketRange === 'all' ? '2099-12-31' : null, viewUserId), (err) => {
      if (state.viewUserId === viewUserId) $('ticket-list').innerHTML = `<p>讀取工單失敗：${err}</p>`;
    }),
    call(window.api.timer.getAll()),
    // 「已完成」(品保通過)的工單後端的待辦清單不會回傳，但流程上還要工程師回覆並設為成功，所以另外查出來一起列
    assigneeId
      ? call(window.api.eip.advancedSearchTickets({ assignee_id: assigneeId, status: '2', per_page: 100, order_by: 'updated_at', order_dir: 'desc' }), () => {})
      : Promise.resolve(null),
  ]);
  if (timers) state.timers = timers;
  // 請求途中切換了工程師，這批結果已經不是畫面上要看的人，丟掉，等新的那次請求回來
  if (!tickets || state.viewUserId !== viewUserId) return { label: '工單', count: 0 };
  const knownIds = new Set(tickets.map((t) => String(t.id)));
  const finished = ((finishedRes && finishedRes.items) || [])
    .filter((t) => Number(t.status) === 2 && !knownIds.has(String(t.id)))
    .map((t) => ({ ...t, pending_reply: true }));
  state.tickets = tickets.concat(finished);
  // 「新工單」通知只看自己的工單；檢視別人時不動自己的快照，切回自己後下一次重整仍能正確比對出新增
  let count = 0;
  if (!isViewingOtherEngineer() && state.ticketRange === 'week') { // 看下週範圍時清單比較長，不拿來比對「新工單」
    const ids = new Set(tickets.map((ticket) => String(ticket.id)));
    count = state.refreshSnapshot.initialized
      ? [...ids].filter((id) => !state.refreshSnapshot.ticketIds.has(id)).length
      : 0;
    state.refreshSnapshot.ticketIds = ids;
  }
  renderTicketList();
  return { label: '工單', count };
}

// ---------------- 工單詳情 ----------------

// 尚未轉品保：6進行中/3暫停/7追蹤/10轉品保。已轉品保：2功能正常(或8=功能正常且關單，限status==4)/5功能異常
function buildStatusOptionsHtml(isQcStage, currentStatus) {
  // 已完成(品保第一次通過)：工程師要再回覆「完成專案」並轉品保(第二次送QC)，網頁版是 轉單=轉品保 + 任務狀態=完成專案
  if (!isQcStage && Number(currentStatus) === 2) {
    return '<option value="4">完成專案，轉品保(第二次送品保)</option>';
  }
  if (isQcStage) {
    const normalOption =
      Number(currentStatus) === 4
        ? '<option value="8">功能正常，任務關閉</option>'
        : '<option value="2">功能正常</option>';
    return normalOption + '<option value="5">功能異常</option>';
  }
  return `
    <option value="6">任務進行中(先回報進度，狀態維持指派中)</option>
    <option value="3">任務暫停</option>
    <option value="7">任務追蹤(列為追蹤單)</option>
    <option value="10">完成並轉品保(任務品保中，已轉單待安排後續)</option>
  `;
}

function renderAttachments(ticket) {
  $('detail-attachments-list').innerHTML = attachmentsHtml(ticket.attachments);
  bindAttachmentLinks($('detail-attachments-list'));
}

async function pickAndUploadForDetail() {
  const filePath = await call(window.api.dialog.pickFile());
  if (!filePath) return;
  $('pending-files-text').textContent = '上傳中...';
  const uploaded = await call(window.api.eip.uploadFile(filePath), (err) => {
    $('pending-files-text').textContent = '上傳失敗：' + err;
  });
  if (!uploaded) return;
  state.pendingFileIds.push(uploaded.file_id);
  $('pending-files-text').textContent = `已上傳待送出：${uploaded.files.map((f) => f.original_filename).join('、')}(送出回覆時會一起附加)`;
}

function updateDetailTimerDisplay() {
  if (!state.currentTicket) return;
  const timer = state.timers[state.currentTicket.id];
  $('timer-display').textContent = formatSeconds(liveSecondsOf(timer));

  // 已手動設定時：計時按鈕照常可用(以手動用時為基準往上累加)，另外顯示設定摘要
  const manual = timer && timer.manual;
  const running = timer && timer.status === 'running';
  $('btn-timer-start').disabled = !!running;
  $('btn-timer-pause').disabled = !running;
  $('timer-manual-summary').classList.toggle('hidden', !manual);
  $('btn-manual-clear').classList.toggle('hidden', !manual);
  if (manual) $('timer-manual-summary').textContent = manualSummaryText(manual);
}

function manualSummaryText(manual) {
  return `手動設定：${formatLocalDateTime(manual.start)} ~ ${formatLocalDateTime(manual.end)}，用時 ${formatSeconds(manual.seconds)}（之後計時會在此基礎上繼續累加）`;
}

// 打開手動設定表單時的預設值：已有手動設定或計時記錄就帶入「目前累計」(手動基準+之後計時)，讓套用後的時間銜接得上
function manualFormPrefill(timer) {
  const manual = timer && timer.manual;
  const segs = (timer && timer.segments) || [];
  if (!manual && !segs.length) return null;
  const running = timer.status === 'running';
  const last = segs[segs.length - 1];
  const start = manual ? manual.start : segs[0].start;
  const end = last ? last.end || new Date().toISOString() : manual.end;
  // 分鐘無條件捨去，避免用時超過(結束−開始)被擋下；不足一分鐘至少帶1分
  const totalMinutes = Math.max(1, Math.floor(liveSecondsOf(timer) / 60));
  let message = '';
  if (running) message = '已帶入目前累計(計時中，結束時間為現在)；套用後會以新的用時為基準繼續計時';
  else if (segs.length) message = '已帶入目前累計(暫停的時間已扣除)，可直接修改後套用';
  return { start: toInputValue(start), end: toInputValue(end), hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60, message };
}

function formatLocalDateTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// datetime-local 要的格式是 YYYY-MM-DDTHH:mm(本地時間)
function toInputValue(iso) {
  return formatLocalDateTime(iso).replace(' ', 'T');
}

function openManualForm() {
  const prefill = manualFormPrefill(state.timers[state.currentTicket.id]);
  if (prefill) {
    $('manual-start').value = prefill.start;
    $('manual-end').value = prefill.end;
    $('manual-hours').value = prefill.hours;
    $('manual-minutes').value = prefill.minutes;
  }
  $('timer-manual-message').textContent = prefill ? prefill.message : '';
  $('timer-manual-form').classList.remove('hidden');
}

// 起訖時間都填了就先用「結束−開始」帶入用時，使用者再依實際扣掉休息時間微調
function autoFillManualDuration() {
  const s = $('manual-start').value;
  const e = $('manual-end').value;
  if (!s || !e) return;
  const diff = Math.round((new Date(e).getTime() - new Date(s).getTime()) / 1000);
  if (diff <= 0) return;
  $('manual-hours').value = Math.floor(diff / 3600);
  $('manual-minutes').value = Math.floor((diff % 3600) / 60);
}

async function applyManualTime() {
  const s = $('manual-start').value;
  const e = $('manual-end').value;
  if (!s || !e) {
    $('timer-manual-message').textContent = '請填開始與結束時間';
    return;
  }
  const seconds = (Number($('manual-hours').value) || 0) * 3600 + (Number($('manual-minutes').value) || 0) * 60;
  const timer = await call(
    window.api.timer.setManual(state.currentTicket.id, {
      start: new Date(s).toISOString(),
      end: new Date(e).toISOString(),
      seconds,
    }),
    (err) => {
      $('timer-manual-message').textContent = '設定失敗：' + err;
    }
  );
  if (!timer) return;
  state.timers[state.currentTicket.id] = timer;
  $('timer-manual-form').classList.add('hidden');
  renderTicketList();
  updateDetailTimerDisplay();
}

async function clearManualTime() {
  const timer = await call(window.api.timer.clearManual(state.currentTicket.id));
  if (!timer) return;
  state.timers[state.currentTicket.id] = timer;
  $('timer-manual-form').classList.add('hidden');
  ['manual-start', 'manual-end', 'manual-hours', 'manual-minutes'].forEach((id) => ($(id).value = ''));
  renderTicketList();
  updateDetailTimerDisplay();
}

async function openTicketDetail(id) {
  const ticket = await call(window.api.eip.getTicket(id), (err) => alert('讀取工單失敗：' + err));
  if (!ticket) return;

  state.currentTicket = ticket;
  $('ticket-detail').classList.remove('hidden');
  $('ticket-list-view').classList.add('hidden');

  $('detail-title').textContent = `${ticket.name || ''} / ${ticket.summary || ''}`;
  $('detail-id').textContent = `#${ticket.id}`;
  $('detail-project').textContent = ticket.project_name
    ? `所屬專案：${ticket.project_name} (id=${ticket.project_id})`
    : '所屬專案：(無)';
  $('btn-jump-to-site').classList.toggle('hidden', !ticket.project_id);
  $('btn-jump-to-project').classList.toggle('hidden', !ticket.project_id);

  const savedType = await call(window.api.ticketMeta.getType(ticket.id));
  $('ticket-type-select').value = savedType || defaultLocalTypeFor(ticket);
  $('ticket-type-eip-hint').textContent = ticket.type_text ? `(EIP總表類型：${ticket.type_text})` : '';

  // 工單描述來自EIP的富文本編輯器(CKEditor)，本來就是HTML，直接用innerHTML呈現才會有正確排版，
  // 跟textContent顯示會看到一堆<p>標籤不一樣；這是同事在EIP後台自己填的內容，跟網頁版本身的信任層級一致
  $('detail-description').innerHTML = ticket.description || '(無說明)';
  $('reply-info').value = '';
  $('reply-commit-message').value = '';
  $('reply-status').innerHTML = buildStatusOptionsHtml(ticket.is_qc_stage, ticket.status);
  $('reply-transfer-to-label').classList.add('hidden');
  $('detail-message').textContent = '';
  $('ai-status').textContent = '';
  $('git-extra-note').value = '';
  $('git-mode-uncommitted').checked = true;
  $('git-commits-box').classList.add('hidden');
  $('git-commits-list').innerHTML = '';
  $('btn-do-git-commit').classList.add('hidden');
  $('git-commit-status').textContent = '';
  $('pending-files-text').textContent = '';
  state.pendingFileIds = [];
  renderAttachments(ticket);
  renderReplies(ticket);

  // 不是自己負責的工單只能查看(可能是同一個專案底下同事在跑的)，不能回覆/計時，避免誤觸動到別人的工單；專管例外
  const isOwn = state.currentUserId == null || ticket.p_user_id === state.currentUserId;
  $('not-own-notice').textContent = state.canEditAnyTicket
    ? `這張工單不是指派給你的(負責人員：${ticket.p_user_name || '未指派'})，你是專管，可以直接回覆`
    : '這張工單不是指派給你的，只能查看，不能回覆或計時';
  $('not-own-notice').classList.toggle('hidden', isOwn);
  $('reply-section').classList.toggle('hidden', !isOwn && !state.canEditAnyTicket);
  $('btn-delete-ticket').classList.toggle('hidden', !state.canDeleteTicket || ticket.status === 9);

  // 品保審核階段不需要計時操作
  $('timer-box').classList.toggle('hidden', !!ticket.is_qc_stage);
  $('timer-manual-form').classList.add('hidden');
  ['manual-start', 'manual-end', 'manual-hours', 'manual-minutes'].forEach((id) => ($(id).value = ''));

  const resolvedPath = await call(window.api.git.resolvePath(ticket.project_id));
  $('detail-project-path').value = resolvedPath || '';

  if (!state.timers[ticket.id]) {
    state.timers[ticket.id] = await call(window.api.timer.get(ticket.id));
  }
  updateDetailTimerDisplay();
}

async function saveProjectPath() {
  if (!state.currentTicket) return;
  const localPath = $('detail-project-path').value.trim();
  await call(window.api.settings.setProjectPath(state.currentTicket.project_id, localPath), (err) => {
    $('detail-message').textContent = '儲存路徑失敗：' + err;
  });
  $('detail-message').textContent = '已儲存這個專案的Git路徑';
}

// 刪除工單後：左側正在看這張就回清單，右側詳情正在看這張就重新讀取(顯示已刪除)，清單重新整理
function afterTicketDeleted(ticketId) {
  if (state.currentTicket && String(state.currentTicket.id) === String(ticketId)) backToList();
  if (state.currentTicketSearchDetail && String(state.currentTicketSearchDetail.id) === String(ticketId)) {
    openTicketSearchDetail(ticketId);
  }
  refreshTicketList();
}

function backToList() {
  state.currentTicket = null;
  $('ticket-detail').classList.add('hidden');
  $('ticket-list-view').classList.remove('hidden');
  refreshTicketList();
}

function onGitSourceModeChange() {
  const mode = document.querySelector('input[name="git-source-mode"]:checked').value;
  $('git-commits-box').classList.toggle('hidden', mode !== 'commits');
}

async function loadCommitsList() {
  if (!state.currentTicket) return;
  $('git-commits-list').innerHTML = '<p class="meta">讀取中...</p>';
  const commits = await call(
    window.api.git.listCommits(state.currentTicket.project_id, 30),
    (err) => {
      $('git-commits-list').innerHTML = `<p style="color:#c0392b;">${escapeHtml(err)}</p>`;
    }
  );
  if (!commits) return;
  if (!commits.length) {
    $('git-commits-list').innerHTML = '<p class="meta">這個專案的git路徑裡沒有提交紀錄</p>';
    return;
  }
  $('git-commits-list').innerHTML = commitListHtml(commits);
  bindCommitList($('git-commits-list'), state.currentTicket.project_id);
}

// ---- commit清單(單張詳情與批次共用)：清單只負責勾選，「查看」開大彈窗看完整訊息、涉及檔案與各檔異動 ----

function commitListHtml(commits) {
  return commits
    .map((c) => {
      const subject = c.message.split('\n')[0];
      // 日期時間拿掉：這個區塊的寬度本來就窄，hash+日期都是固定寬度不會縮，
      // 剩給commit訊息的空間被擠到只剩一點點，訊息幾乎全被省略號蓋掉；日期在「查看」彈窗裡看得到，不差這裡
      return `
      <div class="git-commit-item" data-hash="${c.hash}" data-short="${c.shortHash}" data-subject="${escapeHtml(subject)}">
        <div class="git-commit-row">
          <button type="button" class="git-commit-view" title="在彈窗中查看完整訊息、涉及檔案與異動內容">查看</button>
          <label class="git-commit-main">
            <input type="checkbox" value="${c.hash}" />
            <span class="git-commit-hash">${c.shortHash}</span>
            <span class="git-commit-msg" title="${escapeHtml(c.message)}">${escapeHtml(subject)}</span>
          </label>
        </div>
      </div>`;
    })
    .join('');
}

function bindCommitList(container, projectId) {
  container.querySelectorAll('.git-commit-view').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.git-commit-item');
      openCommitModal(projectId, item.dataset.hash, item.dataset.short, item.dataset.subject);
    });
  });
}

const commitModal = { projectId: null, hash: null, seq: 0 };

function closeCommitModal() {
  $('commit-modal-backdrop').classList.add('hidden');
}

async function openCommitModal(projectId, hash, shortHash, subject) {
  commitModal.projectId = projectId;
  commitModal.hash = hash;
  commitModal.seq++;
  $('commit-modal-title').textContent = `${shortHash}　${subject}`;
  $('commit-modal-msg').textContent = '';
  $('commit-modal-summary').textContent = '';
  $('commit-modal-files').innerHTML = '<p class="meta">讀取中...</p>';
  $('commit-modal-diff').textContent = '';
  $('commit-modal-backdrop').classList.remove('hidden');

  const info = await call(window.api.git.getCommitFiles(projectId, hash), (err) => {
    $('commit-modal-files').innerHTML = `<p style="color:#c0392b;">讀取失敗：${escapeHtml(err)}</p>`;
  });
  if (!info || commitModal.hash !== hash) return;

  $('commit-modal-msg').textContent = info.message;
  const totalAdd = info.files.reduce((s, f) => s + (f.additions || 0), 0);
  const totalDel = info.files.reduce((s, f) => s + (f.deletions || 0), 0);
  $('commit-modal-summary').innerHTML = `共 ${info.files.length} 個檔案　<span class="git-add">+${totalAdd}</span> <span class="git-del">-${totalDel}</span>`;

  if (!info.files.length) {
    $('commit-modal-files').innerHTML = '<p class="meta">沒有異動檔案(可能是merge commit)</p>';
    return;
  }
  $('commit-modal-files').innerHTML = info.files
    .map(
      (f) => `
      <div class="git-file-row" data-path="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}">
        <span class="git-file-status git-file-status-${escapeHtml(f.status)}">${escapeHtml(f.statusLabel)}</span>
        <span class="git-file-path">${escapeHtml(f.path)}</span>
        <span class="git-file-stat">${
          f.additions === null ? '二進位' : `<span class="git-add">+${f.additions}</span> <span class="git-del">-${f.deletions}</span>`
        }</span>
      </div>`
    )
    .join('');
  const rows = $('commit-modal-files').querySelectorAll('.git-file-row');
  rows.forEach((row) => row.addEventListener('click', () => showCommitFileDiff(row, rows)));
  showCommitFileDiff(rows[0], rows);
}

async function showCommitFileDiff(row, allRows) {
  allRows.forEach((r) => r.classList.toggle('active', r === row));
  const pre = $('commit-modal-diff');
  const seq = ++commitModal.seq;
  pre.scrollTop = 0;
  pre.textContent = '讀取中...';

  let diff;
  try {
    const res = await window.api.git.getCommitFileDiff(commitModal.projectId, commitModal.hash, row.dataset.path);
    if (!res.ok) throw new Error(res.error);
    diff = res.data;
  } catch (err) {
    if (seq === commitModal.seq) pre.textContent = '讀取失敗：' + (err && err.message ? err.message : err);
    return;
  }
  if (seq !== commitModal.seq) return; // 使用者已經點了別的檔案，這份結果作廢
  if (typeof diff !== 'string' || !diff.trim()) {
    pre.textContent = '(這個檔案在此commit沒有可顯示的文字異動，可能是二進位檔或只有權限/模式變更)';
    return;
  }
  // 逐行用textContent建立節點，不組HTML字串，內容含任何特殊字元都不會被當成標籤
  const frag = document.createDocumentFragment();
  diff.split('\n').forEach((line, i, all) => {
    const span = document.createElement('span');
    if (line.startsWith('+') && !line.startsWith('+++')) span.className = 'git-add';
    else if (line.startsWith('-') && !line.startsWith('---')) span.className = 'git-del';
    else if (line.startsWith('@@')) span.className = 'git-hunk';
    span.textContent = line + (i < all.length - 1 ? '\n' : '');
    frag.appendChild(span);
  });
  pre.textContent = '';
  pre.appendChild(frag);
}

$('btn-commit-modal-close').addEventListener('click', closeCommitModal);
$('commit-modal-backdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeCommitModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCommitModal();
});

async function generateAiReply() {
  if (!state.currentTicket) return;
  $('ai-status').textContent = 'AI產生中，請稍候...(git讀取+LLM，可能需要幾秒到數十秒)';
  $('btn-do-git-commit').classList.add('hidden');
  $('git-commit-status').textContent = '';

  const mode = document.querySelector('input[name="git-source-mode"]:checked').value;
  const projectId = state.currentTicket.project_id;
  const timer = state.timers[state.currentTicket.id];
  let source;
  let repoPathForStatus = '';

  if (mode === 'commits') {
    const checked = Array.from($('git-commits-list').querySelectorAll('input[type="checkbox"]:checked')).map(
      (el) => el.value
    );
    if (!checked.length) {
      $('ai-status').textContent = '請先載入並勾選至少一筆commit';
      return;
    }
    const detail = await call(window.api.git.getCommitsDetail(projectId, checked), (err) => {
      $('ai-status').textContent = '讀取Git commit失敗：' + err;
    });
    if (!detail) return;
    source = { mode: 'commits', commits: detail.commits };
    repoPathForStatus = detail.repoPath;
  } else {
    const sinceIso = timer && timer.segments.length ? timer.segments[0].start : null;
    const gitChanges = await call(
      window.api.git.collectChanges(sinceIso, projectId),
      (err) => {
        $('ai-status').textContent = '讀取Git失敗：' + err;
      }
    );
    if (!gitChanges) return;
    source = { mode: 'uncommitted', ...gitChanges };
    repoPathForStatus = gitChanges.repoPath;
  }

  const type = $('ticket-type-select').value;
  const templateText = (type && state.settings.replyTemplates && state.settings.replyTemplates[type]) || '';
  const typeLabel = TICKET_TYPE_LABELS[type] || '';

  const result = await call(
    window.api.llm.generateReply({
      ticket: state.currentTicket,
      source,
      durationSeconds: timer ? liveSecondsOf(timer) : 0,
      userNote: $('git-extra-note').value.trim(),
      templateText,
      typeLabel,
    }),
    (err) => {
      $('ai-status').textContent = 'AI產生失敗：' + err;
    }
  );
  if (!result) return;

  $('reply-info').value = result.reply || '';
  $('reply-commit-message').value = result.commitMessage || '';
  const canCommit = mode === 'uncommitted' && !!result.commitMessage;
  $('btn-do-git-commit').classList.toggle('hidden', !canCommit);
  $('ai-status').textContent = `已產生(套用git路徑：${repoPathForStatus})，請自行確認/編輯後再送出${
    canCommit ? '；若要直接commit請按下方確認按鈕' : ''
  }。`;
}

async function confirmGitCommit() {
  if (!state.currentTicket) return;
  const message = $('reply-commit-message').value.trim();
  if (!message) {
    alert('commit訊息是空的，請先產生或自行輸入');
    return;
  }
  if (
    !confirm(
      `確定要在這個專案的本地git執行commit嗎？(會把目前所有未commit的變更一起加入這次commit)\n\n訊息內容：\n${message}`
    )
  ) {
    return;
  }
  $('git-commit-status').textContent = '執行中...';
  const result = await call(
    window.api.git.commit(state.currentTicket.project_id, message),
    (err) => {
      $('git-commit-status').textContent = 'commit失敗：' + err;
    }
  );
  if (!result) return;
  $('git-commit-status').textContent = `已commit：${(result.commit || '').slice(0, 7)}（${result.repoPath}）`;
  $('btn-do-git-commit').classList.add('hidden');
}

const TICKET_TYPE_LABELS = { bug: 'Bug回報', feature: '新增需求', optimize: '優化調整', inquiry: '詢問／諮詢', other: '其他' };

// EIP總表類型(document_heads.type數字，順序對應parameter_setting_details.task_type：
// 專案原案,客服報修,專案後續增加,bug,優化,新增,測試,詢問,調整,待報價)對應到本地工單類型標記，
// 只用來給沒有手動設定過的工單提供一個「預設選中」，使用者仍可自行改掉、且改掉後就以本地保存的為準
const EIP_TYPE_TO_LOCAL_TYPE = ['feature', 'bug', 'feature', 'bug', 'optimize', 'feature', 'other', 'inquiry', 'optimize', 'other'];

function defaultLocalTypeFor(ticket) {
  if (ticket.type === null || ticket.type === undefined) return '';
  return EIP_TYPE_TO_LOCAL_TYPE[ticket.type] || '';
}

async function onTicketTypeChange() {
  if (!state.currentTicket) return;
  const type = $('ticket-type-select').value;
  await window.api.ticketMeta.setType(state.currentTicket.id, type);
}

function applyReplyTemplate() {
  const type = $('ticket-type-select').value;
  if (!type) {
    alert('請先選擇工單類型');
    return;
  }
  const template = (state.settings && state.settings.replyTemplates && state.settings.replyTemplates[type]) || '';
  if (!template) {
    alert(`「${TICKET_TYPE_LABELS[type]}」還沒有設定範本，可以到設定頁的「回覆範本」填寫`);
    return;
  }
  if ($('reply-info').value.trim() && !confirm('回覆內容已經有文字了，套用範本會覆蓋掉，確定嗎？')) {
    return;
  }
  $('reply-info').value = template;
}

async function submitReply() {
  if (!state.currentTicket) return;
  const info = $('reply-info').value.trim();
  const status = $('reply-status').value;
  const transferTo = status === '10' ? $('reply-transfer-to').value : status === '4' ? 'quality_assurance' : '';
  if (!info) {
    $('detail-message').textContent = '請先填寫回覆內容';
    return;
  }

  // 送出前先把計時器停下來，鎖定這次的實際工時
  const stopped = await call(window.api.timer.stop(state.currentTicket.id));

  const payload = {
    info,
    status,
    transfer_to: transferTo,
    fileid: state.pendingFileIds.join(','),
    work_start_time: stopped ? stopped.firstStart : undefined,
    work_end_time: stopped ? stopped.lastEnd : undefined,
    actual_duration_seconds: stopped ? stopped.totalSeconds : undefined,
  };

  const result = await call(window.api.eip.replyTicket(state.currentTicket.id, payload), (err) => {
    $('detail-message').textContent = '送出失敗：' + err;
  });
  if (!result) return;

  state.pendingFileIds = [];
  await window.api.timer.reset(state.currentTicket.id);
  delete state.timers[state.currentTicket.id];
  $('detail-message').textContent = '已送出，回到清單...';
  setTimeout(backToList, 800);
}

// ---------------- 綁定事件 ----------------

window.api.notification.onShow(showAppNotification);
// 獨立工單視窗按「查看案場／專案」，經main process轉過來
window.api.window.onJump(({ target, id }) => {
  if (target === 'site') jumpToInstallListByProject(id);
  else if (target === 'project') jumpToProject(id);
  else if (target === 'reply') openTicketDetail(id);
});
// 工單被轉單後立即重整左側清單；左側正在看的就是這張時，轉單後多半已不在清單內，回到清單避免誤操作
window.api.window.onTicketChanged((id) => {
  refreshTicketList().then(() => {
    if (state.currentTicket && String(state.currentTicket.id) === String(id) && !state.tickets.some((t) => String(t.id) === String(id))) backToList();
  });
});
$('btn-close-app-notification').addEventListener('click', () => $('app-notification').classList.add('hidden'));
$('btn-settings').addEventListener('click', () => $('settings-panel').classList.toggle('hidden'));
$('btn-refresh').addEventListener('click', refreshAll);
$('btn-save-settings').addEventListener('click', saveSettings);
$('btn-test-connection').addEventListener('click', testConnection);
$('btn-login').addEventListener('click', doLogin);
$('btn-logout').addEventListener('click', doLogout);
// 別台電腦改過的資料同步回來後，重新讀取有用到的畫面
window.api.sync.onApplied(async (keys) => {
  if (keys.includes('todos')) loadTodos();
  if (keys.includes('project_stars')) {
    await loadStarredProjects();
    if (!$('project-panel').classList.contains('hidden')) runProjectSearch();
  }
  if (keys.includes('timers')) {
    const timers = await call(window.api.timer.getAll());
    if (timers) {
      state.timers = timers;
      renderTicketList();
    }
  }
  if (keys.includes('reply_templates') && !$('settings-panel').classList.contains('hidden')) loadSettingsIntoForm();
});
$('btn-open-install-search').addEventListener('click', openInstallPanel);
$('btn-install-back').addEventListener('click', closeInstallPanel);
$('btn-install-detail-close').addEventListener('click', closeInstallDetail);
$('btn-install-tickets-more').addEventListener('click', loadMoreInstallTickets);
$('btn-open-project-search').addEventListener('click', () => openProjectPanel());
$('btn-project-back').addEventListener('click', closeProjectPanel);
$('btn-project-tickets-close').addEventListener('click', closeProjectTickets);
$('project-tickets-status-bar').addEventListener('click', (e) => {
  const chip = e.target.closest('.ticket-status-chip');
  if (!chip) return;
  if (chip.dataset.preset === 'pending') togglePendingPreset();
  else toggleTicketStatusFilter(Number(chip.dataset.status));
});
$('project-results').addEventListener('click', onProjectResultsClick);
$('project-results').addEventListener('change', onProjectResultsChange);
$('project-search').addEventListener('input', () => {
  clearTimeout(projectSearchTimer);
  projectSearchTimer = setTimeout(runProjectSearch, 300);
});
document.querySelectorAll('.project-status-btn').forEach((el) => {
  el.addEventListener('click', () => switchProjectStatus(el.dataset.status));
});
$('btn-project-star-only').addEventListener('click', switchProjectStarOnly);
document.querySelectorAll('.project-dept-btn').forEach((el) => {
  el.addEventListener('click', () => switchProjectDept(el.dataset.dept));
});
$('btn-open-ticket-search').addEventListener('click', () => openTicketSearchPanel());
$('btn-ticket-search-back').addEventListener('click', closeTicketSearchPanel);
$('btn-ticket-search-detail-close').addEventListener('click', closeTicketSearchDetail);
$('btn-ts-copy-id').addEventListener('click', () => {
  if (!state.currentTicketSearchDetail) return;
  copyWithFeedback($('btn-ts-copy-id'), state.currentTicketSearchDetail.id);
});
$('btn-ts-jump-to-site').addEventListener('click', () => {
  if (!state.currentTicketSearchDetail) return;
  jumpToInstallListByProject(state.currentTicketSearchDetail.project_id);
});
$('btn-ts-jump-to-project').addEventListener('click', () => {
  if (!state.currentTicketSearchDetail) return;
  jumpToProject(state.currentTicketSearchDetail.project_id);
});
$('btn-jump-to-project').addEventListener('click', () => {
  if (!state.currentTicket) return;
  jumpToProject(state.currentTicket.project_id);
});
$('btn-install-jump-to-project').addEventListener('click', () => {
  if (!state.currentInstallList) return;
  jumpToProject(state.currentInstallList.project_id);
});
$('btn-ts-transfer').addEventListener('click', () => {
  if (!state.currentTicketSearchDetail) return;
  // 轉單後重新整理詳情，顯示轉單後的最新狀態/負責人員/回覆紀錄
  const d = state.currentTicketSearchDetail;
  openTransferTicketModal(d.id, (ticketId) => openTicketSearchDetail(ticketId), d.end_time, { [d.id]: d.p_user_id }, d.start_time);
});
bindTransferTicketModal();
$('btn-ts-reply').addEventListener('click', () => {
  if (state.currentTicketSearchDetail) openTicketDetail(state.currentTicketSearchDetail.id);
});
$('btn-ts-delete').addEventListener('click', () => {
  if (state.currentTicketSearchDetail) openDeleteTicketDialog(state.currentTicketSearchDetail, afterTicketDeleted);
});
$('btn-delete-ticket').addEventListener('click', () => {
  if (state.currentTicket) openDeleteTicketDialog(state.currentTicket, afterTicketDeleted);
});
$('ticket-search-query').addEventListener('input', () => {
  clearTimeout(ticketSearchTimer);
  const q = $('ticket-search-query').value;
  ticketSearchTimer = setTimeout(() => runTicketSearch(q), 300);
});
$('btn-toggle-adv-search').addEventListener('click', toggleAdvSearchPanel);
$('btn-adv-search').addEventListener('click', applyAdvSearch);
$('adv-keyword').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') applyAdvSearch();
});
$('btn-adv-clear').addEventListener('click', () => resetAdvSearchState(false));
$('btn-ts-prev-page').addEventListener('click', () => {
  if (state.advSearch.lastMeta && state.advSearch.lastMeta.current_page > 1) {
    runAdvancedTicketSearch(state.advSearch.lastMeta.current_page - 1).then(renderAdvChips);
  }
});
$('btn-ts-next-page').addEventListener('click', () => {
  if (state.advSearch.lastMeta && state.advSearch.lastMeta.current_page < state.advSearch.lastMeta.last_page) {
    runAdvancedTicketSearch(state.advSearch.lastMeta.current_page + 1).then(renderAdvChips);
  }
});
bindAdvSiteInput();
$('btn-jump-to-site').addEventListener('click', jumpToSiteFromTicket);
$('install-search').addEventListener('input', () => {
  clearTimeout(installSearchTimer);
  const q = $('install-search').value;
  installSearchTimer = setTimeout(() => runInstallSearch(q), 300);
});
$('btn-test-mail').addEventListener('click', testMailConnection);
$('btn-add-todo').addEventListener('click', () => openTodoForm());
$('btn-save-todo').addEventListener('click', () => saveTodo());
$('btn-cancel-todo').addEventListener('click', resetTodoForm);
$('btn-todo-history').addEventListener('click', openTodoHistory);
$('btn-todo-history-close').addEventListener('click', closeTodoHistory);
$('todo-history-backdrop').addEventListener('click', (e) => {
  if (e.target.id === 'todo-history-backdrop') closeTodoHistory();
});
$('todo-history-search').addEventListener('input', () => renderTodoHistory($('todo-history-search').value));
$('todo-list').addEventListener('click', (e) => {
  const item = e.target.closest('.todo-item');
  if (!item) return;
  const id = item.dataset.todoId;
  const todo = state.todos.find((entry) => entry.id === id);
  if (!todo) return;
  if (e.target.closest('.btn-edit-todo')) openTodoForm(todo);
  if (e.target.closest('.btn-delete-todo')) deleteTodo(id);
});
$('todo-list').addEventListener('change', (e) => {
  if (e.target.classList.contains('todo-screen-check')) {
    const screenTodo = state.todos.find((entry) => entry.id === e.target.closest('.todo-item').dataset.todoId);
    if (!screenTodo) return;
    call(window.api.todo.save({ ...screenTodo, onScreen: e.target.checked }), (err) => alert('更新失敗：' + err)).then((saved) => {
      if (saved) Object.assign(screenTodo, saved);
      renderTodoList();
    });
    return;
  }
  if (!e.target.classList.contains('todo-check')) return;
  const item = e.target.closest('.todo-item');
  const todo = state.todos.find((entry) => entry.id === item.dataset.todoId);
  if (!todo) return;
  const previous = todo.completed;
  todo.completed = e.target.checked;
  call(window.api.todo.save(todo), (err) => {
    todo.completed = previous;
    renderTodoList();
    alert('更新待辦失敗：' + err);
  }).then((saved) => {
    if (!saved) return;
    Object.assign(todo, saved);
    renderTodoList();
  });
});
$('btn-mail-modal-close').addEventListener('click', closeMailModal);
$('mail-modal-backdrop').addEventListener('click', (e) => {
  if (e.target.id === 'mail-modal-backdrop') closeMailModal();
});
$('btn-calendar-prev').addEventListener('click', () => changeCalendarMonth(-1));
$('btn-calendar-next').addEventListener('click', () => changeCalendarMonth(1));
$('btn-calendar-today').addEventListener('click', goToCurrentMonth);
$('btn-toggle-add-event').addEventListener('click', () => {
  if ($('add-event-form').classList.contains('hidden')) {
    openAddEventForm();
  } else {
    cancelEventForm();
  }
});
$('btn-cancel-event').addEventListener('click', cancelEventForm);
$('btn-delete-event').addEventListener('click', deleteCurrentEvent);
$('btn-submit-new-event').addEventListener('click', submitNewEvent);
$('btn-back').addEventListener('click', backToList);
$('btn-copy-id').addEventListener('click', (e) => copyWithFeedback(e.currentTarget, state.currentTicket.id));
$('btn-view-ticket-full').addEventListener('click', viewCurrentTicketFull);
$('btn-copy-commit').addEventListener('click', () => window.api.clipboard.copy($('reply-commit-message').value));
$('btn-save-project-path').addEventListener('click', saveProjectPath);
$('set-hotkey').addEventListener('keydown', onHotkeyCapture);
$('btn-clear-hotkey').addEventListener('click', () => {
  $('set-hotkey').value = '';
  $('set-hotkey').focus();
});
$('btn-generate').addEventListener('click', generateAiReply);
$('btn-pick-attach-file').addEventListener('click', pickAndUploadForDetail);
$('ticket-type-select').addEventListener('change', onTicketTypeChange);
$('btn-apply-template').addEventListener('click', applyReplyTemplate);
document
  .querySelectorAll('input[name="git-source-mode"]')
  .forEach((el) => el.addEventListener('change', onGitSourceModeChange));
$('btn-load-commits').addEventListener('click', loadCommitsList);
$('btn-do-git-commit').addEventListener('click', confirmGitCommit);
$('ticket-search').addEventListener('input', () => {
  state.searchQuery = $('ticket-search').value;
  renderTicketList();
});
$('engineer-select').addEventListener('change', switchEngineer);
document.querySelectorAll('#ticket-range .range-btn').forEach((el) => {
  el.addEventListener('click', () => switchTicketRange(el.dataset.range));
});
$('btn-project-tickets-to-left').addEventListener('click', sendProjectTicketsToLeft);
$('btn-project-view-exit').addEventListener('click', exitProjectView);
$('btn-project-view-reload').addEventListener('click', () => {
  $('ticket-list').innerHTML = '<p style="color:#888;">讀取中...</p>';
  loadProjectViewTickets();
});
document.querySelectorAll('.tab-btn').forEach((el) => {
  el.addEventListener('click', () => switchTab(el.dataset.tab));
});
$('btn-submit-reply').addEventListener('click', submitReply);
$('reply-status').addEventListener('change', () => {
  $('reply-transfer-to-label').classList.toggle('hidden', $('reply-status').value !== '10');
});

$('btn-batch-open').addEventListener('click', () => openBatchPanel());
$('btn-batch-finish').addEventListener('click', () => openBatchPanel('finish'));
$('btn-batch-clear').addEventListener('click', clearSelection);
$('btn-batch-select-all').addEventListener('click', selectAllVisibleTickets);
$('btn-batch-transfer').addEventListener('click', () => {
  const picked = selectedTickets();
  const ids = picked.map((t) => t.id);
  const assignees = Object.fromEntries(picked.map((t) => [String(t.id), t.p_user_id]));
  if (ids.length) openTransferTicketModal(ids, afterBatchTicketAction, undefined, assignees);
});
$('btn-batch-delete').addEventListener('click', () => {
  const tickets = selectedTickets();
  if (tickets.length) openDeleteTicketDialog(tickets, afterBatchTicketAction);
});
$('btn-batch-back').addEventListener('click', backFromBatch);
$('btn-batch-submit').addEventListener('click', submitBatch);
$('batch-reply-status').addEventListener('change', () => {
  $('batch-transfer-to-label').classList.toggle('hidden', $('batch-reply-status').value !== '10');
});
document
  .querySelectorAll('input[name="batch-git-source-mode"]')
  .forEach((el) => el.addEventListener('change', onBatchGitSourceModeChange));
$('btn-batch-load-commits').addEventListener('click', loadBatchCommitsList);
$('btn-batch-generate').addEventListener('click', generateBatchAiReply);
$('btn-batch-copy-commit').addEventListener('click', () => window.api.clipboard.copy($('batch-reply-commit-message').value));

$('btn-timer-manual-toggle').addEventListener('click', openManualForm);
$('manual-start').addEventListener('change', autoFillManualDuration);
$('manual-end').addEventListener('change', autoFillManualDuration);
$('btn-manual-apply').addEventListener('click', applyManualTime);
$('btn-manual-clear').addEventListener('click', clearManualTime);
$('btn-manual-cancel').addEventListener('click', () => $('timer-manual-form').classList.add('hidden'));
$('btn-timer-start').addEventListener('click', () => onCardTimerAction(state.currentTicket.id, 'start'));
$('btn-timer-pause').addEventListener('click', () => onCardTimerAction(state.currentTicket.id, 'pause'));
$('btn-timer-stop').addEventListener('click', () => onCardTimerAction(state.currentTicket.id, 'stop'));

// ---------------- 統一重新整理 + 自動倒數重整 ----------------

const AUTO_REFRESH_SECONDS = 120; // 每2分鐘自動重整一次工單/信箱/行事曆
let autoRefreshRemaining = AUTO_REFRESH_SECONDS;
let autoRefreshInFlight = false;

function updateRefreshCountdownDisplay() {
  $('refresh-countdown').textContent = `${autoRefreshRemaining}s`;
}

async function refreshAll({ notify = false } = {}) {
  if (autoRefreshInFlight) return;
  autoRefreshInFlight = true;
  try {
    const changes = await Promise.all([refreshTicketList(), refreshMail(), refreshCalendar()]);
    if (notify) {
      const changed = changes.filter((item) => item && item.count > 0);
      if (changed.length) {
        const body = changed.map((item) => `${item.label}新增${item.count}筆`).join('、');
        await call(window.api.notification.show({ title: '有新的資訊', body }));
      }
    }
    state.refreshSnapshot.initialized = true;
  } finally {
    autoRefreshInFlight = false;
    autoRefreshRemaining = AUTO_REFRESH_SECONDS;
    updateRefreshCountdownDisplay();
  }
}

function tickAutoRefresh() {
  if (autoRefreshRemaining > 0) autoRefreshRemaining -= 1;
  if (autoRefreshRemaining === 0 && !autoRefreshInFlight) {
    refreshAll({ notify: true });
  }
  updateRefreshCountdownDisplay();
}

(async function init() {
  state.tickInterval = setInterval(tick, 1000);
  setInterval(tickAutoRefresh, 1000);
  await loadSettingsIntoForm();
  const whoamiResult = await call(window.api.eip.whoami());
  if (whoamiResult) {
    state.currentUserId = whoamiResult.id;
    state.canTransferTicket = !!whoamiResult.can_transfer_ticket;
    state.canEditAnyTicket = !!whoamiResult.can_edit_any_ticket;
    state.canDeleteTicket = !!whoamiResult.can_delete_ticket;
    versionPermission.canAdd = !!whoamiResult.can_add_version;
  }
  await Promise.all([refreshAll(), loadTodos(), loadEngineers()]);
})();
