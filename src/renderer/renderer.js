const state = {
  settings: null,
  currentUserId: null,
  tickets: [],
  currentTicket: null,
  currentTicketSearchDetail: null, // 右側工單查詢目前顯示的那張工單，給複製工單號／跳去裝機單查詢用
  timers: {}, // { [ticketId]: { status, segments } }，本地算秒數用，不用每秒都問main process
  tickInterval: null,
  selectedIds: new Set(), // 批次提交用的多選狀態
  searchQuery: '',
  activeTab: 'normal', // 'normal'=待處理(assigned等) / 'qc'=品保中，分開避免QC單淹沒真正要處理的工單
  viewUserId: null, // 左側清單目前在看哪位工程師的工單；null=自己(每次開App都從自己開始，不記憶)
  engineers: [],
  pendingFileIds: [], // 詳情頁「上傳並附加到工單」暫存的file id，等送出回覆時一起帶上去
  todos: [],
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
  // 登入用的是「已儲存」的網址；使用者剛改完網址還沒按儲存就登入，會打到舊網址，所以先把網址存起來
  await call(window.api.settings.save({ eipBaseUrl: baseUrl }));
  const result = await call(window.api.eip.login(username, password), (err) => {
    $('login-message').textContent = `登入失敗(連線網址：${baseUrl})：${err}`;
  });
  if (!result) return;

  $('set-api-token').value = result.token;
  $('login-password').value = '';
  await saveSettings();
  $('login-message').textContent = `登入成功，已取得新Token(使用者：${result.user.name})`;
}

async function testConnection() {
  $('settings-message').textContent = '測試中...';
  const data = await call(window.api.eip.whoami(), (err) => {
    $('settings-message').textContent = '連線失敗：' + err;
  });
  if (data) {
    $('settings-message').textContent = `連線成功，登入身分：${data.name} (id=${data.id})`;
  }
}

async function testMailConnection() {
  $('settings-message').textContent = '測試信箱連線中...';
  const result = await call(window.api.mail.listRecent(5), (err) => {
    $('settings-message').textContent = '信箱連線失敗：' + err;
  });
  if (result) {
    $('settings-message').textContent = `信箱連線成功，共${result.messages.length}封(未讀${result.unseenCount}封)`;
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

function renderTodoList() {
  const list = $('todo-list');
  const todos = [...state.todos]
    .filter(isTodoVisibleToday)
    .sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (a.reminderAt || '').localeCompare(b.reminderAt || '');
    });
  list.innerHTML = todos.length ? todos.map((todo) => `
    <div class="todo-item ${todo.completed ? 'completed' : ''} ${todo.pinned ? 'pinned' : ''}" data-todo-id="${escapeHtml(todo.id)}">
      <input type="checkbox" class="todo-check" ${todo.completed ? 'checked' : ''} />
      <span class="todo-title">${escapeHtml(todo.title)}</span>
      ${todo.reminderAt ? `<span class="todo-due">提醒 ${escapeHtml(new Date(todo.reminderAt).toLocaleString('zh-Hant'))}</span>` : ''}
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
          }</div>`
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
const projectPanel = { status: '1', projects: [], selected: null }; // selected = { projectId, stage }，stage為null代表全部階段

// 專案狀態配色沿用EIP網頁：未進行灰、進行中橘、已完成綠、取消/終止紅
const PROJECT_STATUS_CLASS = { default: 'status-default', warning: 'status-warning', success: 'status-success', danger: 'status-danger' };

function openProjectPanel() {
  $('sidebar-default-view').classList.add('hidden');
  $('install-panel').classList.add('hidden');
  $('ticket-search-panel').classList.add('hidden');
  $('project-panel').classList.remove('hidden');
  closeProjectTickets();
  $('project-search').focus();
  runProjectSearch();
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

async function runProjectSearch() {
  const seq = ++projectSearchSeq;
  const q = $('project-search').value.trim();
  $('project-results').innerHTML = '<p style="color:#888;">讀取中...</p>';
  const projects = await call(window.api.eip.listProjects(q, projectPanel.status), (err) => {
    if (seq === projectSearchSeq) $('project-results').innerHTML = `<p style="color:#d84f4f;">查詢失敗：${escapeHtml(err)}</p>`;
  });
  if (!projects || seq !== projectSearchSeq) return;
  projectPanel.projects = projects;
  if (!projects.length) {
    $('project-results').innerHTML = '<p style="color:#888;">沒有符合的專案</p>';
    return;
  }
  $('project-results').innerHTML =
    projects.map(projectCardHtml).join('') +
    (projects.length >= 300 ? '<p class="meta">只顯示最新300筆，請用關鍵字或狀態縮小範圍</p>' : '');
  renderProjectSelection();
}

function projectCardHtml(p) {
  const metaItem = (label, value) => (value ? `<span><span class="ts-k">${label}</span> ${escapeHtml(value)}</span>` : '');
  const stages = (p.stages || [])
    .map((s, i) => {
      const tip = s.state === 0 ? `${s.name}：尚未開單` : `${s.name}：共${s.total}張工單，已關閉${s.closed}張`;
      return `${i ? '<span class="stage-arrow">›</span>' : ''}<button type="button" class="stage-chip stage-s${s.state}" data-pid="${p.id}" data-stage="${s.index}" title="${escapeHtml(tip)}" ${s.state === 0 ? 'disabled' : ''}>${escapeHtml(s.name)}</button>`;
    })
    .join('');
  return `<div class="install-card project-card" data-id="${p.id}">
    <div class="install-name">#${p.id} ${escapeHtml(p.name || '(無名稱)')}<span class="status-badge ${PROJECT_STATUS_CLASS[p.status_color] || 'status-default'}">${escapeHtml(p.status_text || '')}</span></div>
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
  </div>`;
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
  renderProjectSelection();

  $('project-panel').classList.add('has-detail');
  $('project-tickets').classList.remove('hidden');
  $('project-tickets-title').textContent = `▾ ${project.name}　${stageInfo ? stageInfo.name : '全部階段'}`;
  $('project-tickets-list').innerHTML = '<p style="color:#888;">讀取中...</p>';

  const seq = ++projectTicketsSeq;
  const filters = { project_id: project.id, status: '0,1,2,3,4,5,6,7,8,10', order_by: 'id', order_dir: 'desc', per_page: 100 };
  if (stage != null) filters.task_stage = stage;
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

function onProjectResultsClick(e) {
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
  }
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
  openTicketSearchPanel(false, true);
  openTicketSearchDetail(state.currentTicket.id, true);
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
        </div>
        <div class="ts-card-meta">
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
  state.currentTicketSearchDetail = ticket; // 給複製工單號／跳去裝機單查詢的按鈕用

  $('ticket-search-detail-basic').innerHTML = ticketFullInfoRows(ticket);

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
  $('mail-modal-backdrop').classList.remove('hidden');

  const msg = await call(window.api.mail.getMessage(uid), (err) => {
    $('mail-modal-subject').textContent = '讀取失敗';
    $('mail-modal-meta').textContent = err;
  });
  if (!msg) return;

  $('mail-modal-subject').textContent = msg.subject;
  $('mail-modal-meta').textContent = `${msg.from}　${msg.date ? new Date(msg.date).toLocaleString('zh-Hant') : ''}`;
  // 信件內容可能來自不明寄件者，一律丟進沒有任何權限(sandbox="")的iframe呈現，避免裡面的script/連結影響到App本身
  if (msg.html) {
    $('mail-modal-frame').srcdoc = msg.html;
  } else {
    $('mail-modal-frame').srcdoc = `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(msg.text || '(無內容)')}</pre>`;
  }

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
  const byTab = state.tickets.filter((t) => (state.activeTab === 'qc' ? t.is_qc_stage : !t.is_qc_stage));
  const q = state.searchQuery.trim().toLowerCase();
  const filtered = !q ? byTab : byTab.filter((t) => {
    return (
      String(t.id).includes(q) ||
      (t.summary || '').toLowerCase().includes(q) ||
      (t.project_name || '').toLowerCase().includes(q)
    );
  });
  return filtered.sort((a, b) => {
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
  const normalCount = state.tickets.filter((t) => !t.is_qc_stage).length;
  const qcCount = state.tickets.filter((t) => t.is_qc_stage).length;
  $('tab-count-normal').textContent = `(${normalCount})`;
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
  updateTabCounts();
  const tickets = filteredTickets();
  if (!tickets.length) {
    const emptyText = state.searchQuery
      ? '沒有符合搜尋的工單'
      : state.activeTab === 'qc'
      ? '目前沒有品保審核中的工單'
      : '目前沒有本週五之前需要處理的工單';
    container.innerHTML = `<p>${emptyText}。</p>`;
    return;
  }
  // 檢視其他工程師的工單時只能看：不顯示批次勾選、計時、附加檔案(後端也只允許本人回覆/附檔)
  const readonly = isViewingOtherEngineer();
  container.innerHTML = tickets
    .map(
      (t) => `
      <div class="ticket-card ${ticketDueClass(t)}" data-id="${t.id}">
        <div class="row1">
          ${readonly ? '' : `<label class="card-select"><input type="checkbox" class="chk-select" data-id="${t.id}" ${state.selectedIds.has(String(t.id)) ? 'checked' : ''} /></label>`}
          <span>#${t.id} ${t.project_name || t.name || ''}</span>${statusBadge(t)}
        </div>
        <div class="summary">${t.summary || ''}</div>
        <div class="meta">開始：${t.start_time || '-'}　預定完成：${ticketDueValue(t) || '-'}</div>
        ${readonly ? '' : timerControlsHtml(t)}
        <div class="card-actions-row">
          <button class="btn-card-copy-id" data-id="${t.id}" title="複製工單號到剪貼簿">複製單號</button>
          ${readonly ? '' : `<button class="btn-card-attach" data-id="${t.id}" title="不寫回覆，直接上傳檔案掛到這張工單">附加檔案</button>`}
        </div>
      </div>`
    )
    .join('');

  // 整張卡片都能點開詳情，只有勾選框/計時按鈕/附加檔案這些「卡片上的其他操作」要排除，不然會被誤觸連帶打開詳情
  container.querySelectorAll('.ticket-card').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('button, input, label')) return;
      openTicketDetail(el.dataset.id);
    });
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

function updateBatchBar() {
  const selected = selectedTickets();
  const bar = $('batch-bar');
  if (selected.length < 2) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const projectIds = new Set(selected.map((t) => String(t.project_id || '')));
  const qcStages = new Set(selected.map((t) => !!t.is_qc_stage));
  if (projectIds.size > 1) {
    $('batch-bar-text').textContent = `已選 ${selected.length} 張，但分屬不同專案，批次提交只支援同一個專案`;
    $('btn-batch-open').disabled = true;
  } else if (qcStages.size > 1) {
    $('batch-bar-text').textContent = `已選 ${selected.length} 張，但有的已轉品保有的還沒，批次提交需要階段一致`;
    $('btn-batch-open').disabled = true;
  } else {
    $('batch-bar-text').textContent = `已選 ${selected.length} 張工單(同一專案)`;
    $('btn-batch-open').disabled = false;
  }
}

function clearSelection() {
  state.selectedIds.clear();
  updateBatchBar();
  renderTicketList();
}

async function openBatchPanel() {
  const selected = selectedTickets();
  if (selected.length < 2) return;

  $('ticket-list-view').classList.add('hidden');
  $('batch-bar').classList.add('hidden');
  $('batch-panel').classList.remove('hidden');
  $('batch-panel-list').textContent = selected.map((t) => `#${t.id} ${t.summary || ''}`).join('、');
  $('batch-reply-info').value = '';
  $('batch-reply-commit-message').value = '';
  const isQcStage = !!selected[0].is_qc_stage;
  $('batch-reply-status').innerHTML = buildStatusOptionsHtml(isQcStage, selected[0].status);
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
  $('batch-panel').classList.add('hidden');
  $('ticket-list-view').classList.remove('hidden');
  refreshTicketList();
}

async function submitBatch() {
  const selected = selectedTickets();
  const info = $('batch-reply-info').value.trim();
  const status = $('batch-reply-status').value;
  const transferTo = status === '10' ? $('batch-reply-transfer-to').value : '';
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
  const id = Number($('engineer-select').value);
  state.viewUserId = id && id !== Number(state.currentUserId) ? id : null;
  const viewing = isViewingOtherEngineer();
  const who = viewing ? (state.engineers.find((u) => Number(u.id) === id) || {}).name : '';
  $('topbar-title').textContent = viewing ? `${who} 的工單` : '我的工單';
  $('engineer-readonly-hint').classList.toggle('hidden', !viewing);
  state.selectedIds.clear();
  updateBatchBar();
  state.tickets = [];
  $('ticket-list').innerHTML = '<p style="color:#888;">讀取中...</p>';
  updateTabCounts();
  refreshTicketList();
}

async function refreshTicketList() {
  const viewUserId = state.viewUserId;
  const [tickets, timers] = await Promise.all([
    call(window.api.eip.listTickets(null, viewUserId), (err) => {
      if (state.viewUserId === viewUserId) $('ticket-list').innerHTML = `<p>讀取工單失敗：${err}</p>`;
    }),
    call(window.api.timer.getAll()),
  ]);
  if (timers) state.timers = timers;
  // 請求途中切換了工程師，這批結果已經不是畫面上要看的人，丟掉，等新的那次請求回來
  if (!tickets || state.viewUserId !== viewUserId) return { label: '工單', count: 0 };
  state.tickets = tickets;
  // 「新工單」通知只看自己的工單；檢視別人時不動自己的快照，切回自己後下一次重整仍能正確比對出新增
  let count = 0;
  if (!isViewingOtherEngineer()) {
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

  // 不是自己負責的工單只能查看(可能是同一個專案底下同事在跑的)，不能回覆/計時，避免誤觸動到別人的工單
  const isOwn = state.currentUserId == null || ticket.p_user_id === state.currentUserId;
  $('not-own-notice').classList.toggle('hidden', isOwn);
  $('reply-section').classList.toggle('hidden', !isOwn);

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
  const transferTo = status === '10' ? $('reply-transfer-to').value : '';
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
$('btn-close-app-notification').addEventListener('click', () => $('app-notification').classList.add('hidden'));
$('btn-settings').addEventListener('click', () => $('settings-panel').classList.toggle('hidden'));
$('btn-refresh').addEventListener('click', refreshAll);
$('btn-save-settings').addEventListener('click', saveSettings);
$('btn-test-connection').addEventListener('click', testConnection);
$('btn-login').addEventListener('click', doLogin);
$('btn-open-install-search').addEventListener('click', openInstallPanel);
$('btn-install-back').addEventListener('click', closeInstallPanel);
$('btn-install-detail-close').addEventListener('click', closeInstallDetail);
$('btn-install-tickets-more').addEventListener('click', loadMoreInstallTickets);
$('btn-open-project-search').addEventListener('click', openProjectPanel);
$('btn-project-back').addEventListener('click', closeProjectPanel);
$('btn-project-tickets-close').addEventListener('click', closeProjectTickets);
$('project-results').addEventListener('click', onProjectResultsClick);
$('project-search').addEventListener('input', () => {
  clearTimeout(projectSearchTimer);
  projectSearchTimer = setTimeout(runProjectSearch, 300);
});
document.querySelectorAll('.project-status-btn').forEach((el) => {
  el.addEventListener('click', () => switchProjectStatus(el.dataset.status));
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
document.querySelectorAll('.tab-btn').forEach((el) => {
  el.addEventListener('click', () => switchTab(el.dataset.tab));
});
$('btn-submit-reply').addEventListener('click', submitReply);
$('reply-status').addEventListener('change', () => {
  $('reply-transfer-to-label').classList.toggle('hidden', $('reply-status').value !== '10');
});

$('btn-batch-open').addEventListener('click', openBatchPanel);
$('btn-batch-clear').addEventListener('click', clearSelection);
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
  if (whoamiResult) state.currentUserId = whoamiResult.id;
  await Promise.all([refreshAll(), loadTodos(), loadEngineers()]);
})();
