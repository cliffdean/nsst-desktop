// 電子紙看板(擴展功能)的設定畫面：沒勾選「啟用」時詳細設定整塊隱藏，功能也不運作
// 用到ticket-common.js的$、call、escapeHtml，要在它們之後載入

const SCREEN_STATUS_LIST = [
  [0, '新任務'], [1, '已指派'], [3, '已暫停'], [5, '失敗'], [7, '追蹤中'],
  [10, '品保中'], [2, '已完成'], [4, '成功'],
];

const screenUi = { config: null, engineers: [], status: null, loaded: false, baseline: null };

function screenStatusKind(config, status) {
  if ((config.todoStatuses || []).map(Number).includes(status)) return 'todo';
  if ((config.reviewStatuses || []).map(Number).includes(status)) return 'review';
  return 'none';
}

function renderScreenStatusMap(config) {
  $('screen-status-map').innerHTML = SCREEN_STATUS_LIST.map(([code, name]) => {
    const kind = screenStatusKind(config, code);
    const opt = (v, text) => `<option value="${v}"${kind === v ? ' selected' : ''}>${text}</option>`;
    return `<label>${escapeHtml(name)}
      <select data-status="${code}">${opt('todo', '待處理')}${opt('review', '待審核')}${opt('none', '不計入')}</select>
    </label>`;
  }).join('');
}

function renderScreenBlacklist(config) {
  const black = new Set((config.engineerBlacklist || []).map(String));
  const list = screenUi.engineers.filter((e) => e.is_engineering);
  $('screen-blacklist').innerHTML = list.length
    ? list.map((e) => `<label class="screen-check"><input type="checkbox" data-eng="${e.id}"${black.has(String(e.id)) ? ' checked' : ''} />${escapeHtml(e.name)}</label>`).join('')
    : '<span class="screen-sub">(讀不到工程師清單，請確認已登入 EIP)</span>';
}

function formatScreenTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function renderScreenStatus(status) {
  if (!status) return;
  screenUi.status = status;
  const lines = [];
  if (!status.enabled) {
    $('screen-status').textContent = '';
    return;
  }
  lines.push(status.running ? `● MQTT 伺服器運行中(連接埠 ${status.port}，目前連線 ${status.clients} 台)` : '○ MQTT 伺服器未運行');
  if (status.lastError) lines.push(`⚠ ${status.lastError}`);
  lines.push(`最後取數據：${formatScreenTime(status.lastBuildAt)}${status.lastBuildMs ? `(耗時 ${(status.lastBuildMs / 1000).toFixed(1)} 秒)` : ''}　內容版本：${status.rev || '—'}`);
  const s = status.screen;
  if (s) {
    const bits = [];
    if (s.battery != null) bits.push(`電量 ${s.battery}%`);
    if (s.ip) bits.push(`IP ${s.ip}`);
    if (s.rssi != null) bits.push(`訊號 ${s.rssi}dBm`);
    if (s.rev) bits.push(`畫面版本 ${s.rev}`);
    if (s.mode) bits.push(`模式 ${s.mode}`);
    if (s.parked) bits.push(s.parked === 2 ? '畫面已手動清除' : '畫面已因斷線太久自動清除');
    lines.push(`屏幕最後回報：${formatScreenTime(s.receivedAt)}　${bits.join('　')}`);
  } else {
    lines.push('屏幕尚未回報過(第一次需在屏幕端填入下面的連線資訊)');
  }
  $('screen-status').innerHTML = lines.map((l) => escapeHtml(l)).join('<br>');

  const sel = $('screen-host');
  const current = status.host;
  sel.innerHTML = status.addresses.map((a) => `<option value="${a}"${a === current ? ' selected' : ''}>${a}</option>`).join('');
  if (!status.addresses.length) sel.innerHTML = '<option value="">(找不到網路位址)</option>';
}

function fillScreenForm(config) {
  screenUi.config = config;
  $('screen-enabled').checked = !!config.enabled;
  $('screen-details').classList.toggle('hidden', !config.enabled);
  $('screen-port').value = config.mqttPort;
  $('screen-user').value = config.mqttUser;
  $('screen-password').value = config.mqttPassword || '(啟用後自動產生)';
  $('screen-device').value = config.deviceId;
  $('screen-host-override').value = config.hostOverride || '';
  $('screen-title').value = config.title;
  $('screen-refresh-min').value = config.refreshMin;
  $('screen-show-projects').checked = !!config.showProjects;
  $('screen-todo-range').value = config.todoRange || (config.todoThisWeekOnly === false ? 'all' : 'week');
  $('screen-eng-review-success').checked = !!config.engineerReviewIncludeSuccess;
  $('screen-ip').value = config.screenIp || '';
  $('screen-power-mode').value = config.powerMode;
  $('screen-wake-min').value = config.wakeMin;
  $('screen-off-wake-min').value = config.offWakeMin;
  $('screen-active-start').value = config.activeStart || '';
  $('screen-active-end').value = config.activeEnd || '';
  $('screen-low-battery').value = config.lowBatteryPct;
  $('screen-clear-hours').value = config.clearOfflineMin;
  $('screen-ntp').value = config.ntpServer || '';
  $('screen-tz').value = config.tzHours;
  $('screen-weekends-off').checked = !!config.weekendsOff;
  $('screen-periodic-window').checked = !!config.periodicInWindowOnly;
  $('screen-usb-always-on').checked = !!config.usbAlwaysOn;
  renderScreenStatusMap(config);
  renderScreenBlacklist(config);
  screenUi.baseline = screenFormFingerprint();
  $('screen-dirty').classList.add('hidden');
}

function collectScreenForm() {
  const todo = [];
  const review = [];
  $('screen-status-map').querySelectorAll('select[data-status]').forEach((sel) => {
    const code = Number(sel.dataset.status);
    if (sel.value === 'todo') todo.push(code);
    else if (sel.value === 'review') review.push(code);
  });
  const blacklist = [...$('screen-blacklist').querySelectorAll('input[data-eng]:checked')].map((el) => Number(el.dataset.eng));
  return {
    enabled: $('screen-enabled').checked,
    mqttPort: $('screen-port').value.trim(),
    mqttUser: $('screen-user').value.trim() || 'nsst',
    deviceId: $('screen-device').value.trim(),
    hostOverride: $('screen-host-override').value.trim(),
    title: $('screen-title').value.trim() || '工單看板',
    refreshMin: $('screen-refresh-min').value.trim(),
    showProjects: $('screen-show-projects').checked,
    todoRange: $('screen-todo-range').value,
    engineerReviewIncludeSuccess: $('screen-eng-review-success').checked,
    todoStatuses: todo,
    reviewStatuses: review,
    engineerBlacklist: blacklist,
    screenIp: $('screen-ip').value.trim(),
    powerMode: $('screen-power-mode').value,
    wakeMin: $('screen-wake-min').value.trim(),
    offWakeMin: $('screen-off-wake-min').value.trim(),
    activeStart: $('screen-active-start').value.trim(),
    activeEnd: $('screen-active-end').value.trim(),
    lowBatteryPct: $('screen-low-battery').value.trim(),
    clearOfflineMin: $('screen-clear-hours').value.trim(),
    ntpServer: $('screen-ntp').value.trim() || 'pool.ntp.org',
    tzHours: $('screen-tz').value.trim(),
    weekendsOff: $('screen-weekends-off').checked,
    periodicInWindowOnly: $('screen-periodic-window').checked,
    usbAlwaysOn: $('screen-usb-always-on').checked,
  };
}

async function loadScreenSettings() {
  const settings = await call(window.api.settings.get());
  if (!settings || !settings.screen) return;
  const engineers = await call(window.api.eip.listEngineers(), () => {});
  screenUi.engineers = engineers || [];
  fillScreenForm(settings.screen);
  renderScreenStatus(await call(window.api.screen.status()));
  screenUi.loaded = true;
}

// ---- 設定畫面的原則：測試/預覽/推送/連接都用「畫面上現在填的值」，成功才儲存；失敗什麼都不會存 ----

// 操作結果：顯示在按鈕旁邊(where='connect' 是連接屏幕那一組，否則是下方的操作列)，同時用固定在視窗底部的浮動提示，
// 不管頁面捲到哪裡都看得到，不會讓人覺得「按了沒反應」。kind：info(進行中) | ok | warn | err
let screenToastTimer = null;
function screenSay(text, kind = 'info', where = 'action') {
  const el = $(where === 'connect' ? 'screen-msg-connect' : 'screen-message');
  [$('screen-msg-connect'), $('screen-message')].forEach((x) => { if (x !== el) x.classList.add('hidden'); });
  el.textContent = text;
  el.className = `screen-msg ${kind === 'info' ? '' : kind}`;
  const toast = $('screen-toast');
  toast.textContent = text;
  toast.className = `screen-toast ${kind === 'info' ? '' : kind}`;
  clearTimeout(screenToastTimer);
  screenToastTimer = setTimeout(() => toast.classList.add('hidden'), kind === 'ok' ? 8000 : 20000);
}

// 按下去馬上有反應：按鈕變成「進行中」並停用，做完還原
async function screenBusy(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.classList.add('busy');
  button.textContent = label;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.classList.remove('busy');
    button.textContent = original;
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// 目前表單內容的指紋(不含「啟用」開關，它是即時生效的)，用來顯示「有尚未儲存的修改」
function screenFormFingerprint() {
  const f = collectScreenForm();
  delete f.enabled;
  return JSON.stringify(f);
}

function updateScreenDirty() {
  if (screenUi.baseline == null) return;
  $('screen-dirty').classList.toggle('hidden', screenFormFingerprint() === screenUi.baseline);
}

// onlyEnabled：只套用「啟用」開關本身，不順手把其他還沒測試的欄位也存起來
async function saveScreenSettings({ onlyEnabled = false, quiet = false } = {}) {
  const patch = onlyEnabled ? { enabled: $('screen-enabled').checked } : collectScreenForm();
  const status = await call(window.api.screen.saveConfig(patch), (err) => {
    screenSay('儲存失敗：' + err, 'err');
  });
  if (!status) return null;
  if (!onlyEnabled) {
    const settings = await call(window.api.settings.get());
    fillScreenForm(settings.screen);
  }
  renderScreenStatus(status);
  if (!quiet) screenSay(onlyEnabled ? ($('screen-enabled').checked ? '已啟用' : '已停用') : '已儲存並套用', 'ok');
  return status;
}

// 勾選/取消「啟用」馬上生效(啟動或關閉MQTT伺服器)；這是開關本身，不會連帶存其他欄位
$('screen-enabled').addEventListener('change', async () => {
  $('screen-details').classList.toggle('hidden', !$('screen-enabled').checked);
  await saveScreenSettings({ onlyEnabled: true });
  if ($('screen-enabled').checked) loadScreenSettings();
});
$('btn-screen-save').addEventListener('click', () => saveScreenSettings());

$('screen-details').addEventListener('input', updateScreenDirty);
$('screen-details').addEventListener('change', updateScreenDirty);

// 等屏幕確實連上桌面工具(MQTT)，最多等 timeoutMs；每2秒看一次狀態並更新進度
async function waitScreenConnected(label, timeoutMs, where) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await call(window.api.screen.status());
    if (st && st.clients > 0) return st;
    screenSay(`${label}(已等 ${Math.round((Date.now() - t0) / 1000)} 秒，最多約 ${Math.round(timeoutMs / 1000)} 秒)`, 'info', where);
    await sleepMs(2000);
  }
  return null;
}

// 測試連線：只讀屏幕的 /info，不寫任何設定
$('btn-screen-probe').addEventListener('click', () => screenBusy($('btn-screen-probe'), '測試中…', async () => {
  screenSay('測試連線中…', 'info', 'connect');
  const r = await call(window.api.screen.probe($('screen-ip').value.trim()), (err) => {
    screenSay('失敗：' + err, 'err', 'connect');
  });
  if (!r) return;
  const bits = [`WiFi ${r.ssid || '—'}(${r.rssi} dBm)`];
  if (r.battery != null) bits.push(`電量 ${r.battery}%`);
  if (r.usb != null) bits.push(r.usb ? '插著 USB' : '用電池');
  if (r.mode) bits.push(`模式 ${r.mode}`);
  bits.push(r.hasMqtt ? '屏幕裡已有桌面工具連線設定' : '屏幕還沒設定桌面工具');
  if (r.authRequired) {
    screenSay(`找到屏幕 ${r.ip}：${bits.join('，')}。⚠ 這台屏幕設過另一組密碼，現在寫入會被拒絕。請先把屏幕重新開機(撥一下背面電源開關，或重新接 USB)，5 分鐘內再按「連接屏幕並寫入設定」。`, 'warn', 'connect');
  } else {
    screenSay(`找到屏幕 ${r.ip}：${bits.join('，')}。現在可以按「連接屏幕並寫入設定」。`, 'ok', 'connect');
  }
}));

// 連接屏幕並寫入設定：用畫面上的值寫進屏幕，寫成功才把這些值存起來；接著等屏幕真的連上桌面工具才算完成
$('btn-screen-provision').addEventListener('click', () => screenBusy($('btn-screen-provision'), '連接中…', async () => {
  screenSay('連接屏幕並寫入設定中…', 'info', 'connect');
  const form = collectScreenForm();
  const r = await call(window.api.screen.provision(form.screenIp, form), (err) => {
    screenSay('失敗(沒有儲存任何東西)：' + err, 'err', 'connect');
  });
  if (!r) return;
  await saveScreenSettings({ quiet: true });
  const st = await waitScreenConnected('設定已寫入屏幕，等待它重開機並連上桌面工具', 90000, 'connect');
  if (st) {
    const s = st.screen;
    screenSay(`完成：屏幕已連上桌面工具${s && s.battery != null ? `，電量 ${s.battery}%` : ''}。接下來按「立即取數據並推送」，螢幕約 35 秒後會刷新。`, 'ok', 'connect');
  } else {
    screenSay(`設定已寫入屏幕(${r.ip}，MQTT 位置 ${r.host}:${r.port})，但 90 秒內屏幕沒有連上桌面工具。請確認：1) Windows 防火牆有允許連接埠 ${r.port}；2) 屏幕跟這台電腦在同一個網路。`, 'warn', 'connect');
  }
}));

// 立即取數據並推送：用畫面上的分類/名單設定算出來推給屏幕，成功才存。要有屏幕連線才算真的送到
$('btn-screen-refresh').addEventListener('click', () => screenBusy($('btn-screen-refresh'), '取數據中…', async () => {
  screenSay('向 EIP 取數據中(依工程師與專案數量，通常幾秒到十幾秒)…', 'info');
  const data = await call(window.api.screen.refresh(collectScreenForm()), (err) => {
    screenSay('失敗(沒有儲存任何東西)：' + err, 'err');
  });
  if (!data) return;
  await saveScreenSettings({ quiet: true });
  const summary = `待處理 ${data.totals.todo}、待審核 ${data.totals.review}、逾期 ${data.totals.overdue}(版本 ${data.rev})`;
  const st = await call(window.api.screen.status());
  if (!st || st.clients === 0) {
    screenSay(`已取得數據並放在伺服器上：${summary}。⚠ 但目前沒有屏幕連上桌面工具，所以螢幕不會變。請先在上面按「連接屏幕並寫入設定」讓屏幕連上；屏幕連上後會自動收到這份數據。`, 'warn');
    return;
  }
  screenSay(`已推送給屏幕：${summary}。電子紙刷新約 35 秒，等它回報…`, 'info');
  for (let i = 0; i < 45; i++) { // 最多等 90 秒
    await sleepMs(2000);
    const cur = await call(window.api.screen.status());
    if (cur && cur.screen && cur.screen.rev === data.rev) {
      screenSay(`屏幕已更新到最新數據：${summary}`, 'ok');
      return;
    }
  }
  screenSay(`已推送：${summary}，但 90 秒內屏幕沒有回報新版本。可能屏幕正在刷新、或剛好睡著(睡著的屏幕會在下次醒來時收到)；也可以按屏幕上的綠鍵喚醒。`, 'warn');
}));

// 清除/恢復：發指令給在線的屏幕(MQTT cmd 是一次性訊息，屏幕不在線就收不到)
async function sendScreenCommand(button, label, name, doneText) {
  await screenBusy(button, label, async () => {
    const st = await call(window.api.screen.status());
    if (!st || st.clients === 0) {
      screenSay('屏幕目前沒有連上桌面工具(睡眠中，或用電池且不在上班時段)，指令送不到。可以在屏幕上按住綠鍵 5 秒手動清除，按綠鍵恢復。', 'warn');
      return;
    }
    const ok = await call(window.api.screen.command(name), (err) => {
      screenSay('失敗：' + err, 'err');
    });
    if (ok) screenSay(doneText, 'ok');
  });
}
$('btn-screen-clear').addEventListener('click', () => {
  if (!confirm('把屏幕畫面清成白色？(約 35 秒)\n清除後會保持空白，直到你按屏幕上的綠鍵或按「恢復顯示」。')) return;
  sendScreenCommand($('btn-screen-clear'), '送出中…', 'clear', '已通知屏幕清除畫面(約 35 秒)；要恢復請按屏幕上的綠鍵或「恢復顯示」。');
});
$('btn-screen-resume').addEventListener('click', () => sendScreenCommand($('btn-screen-resume'), '送出中…', 'resume', '已通知屏幕恢復顯示(約 35 秒)。'));

// 預覽數據：用畫面上的設定試算，不推送、不儲存
$('btn-screen-preview').addEventListener('click', () => screenBusy($('btn-screen-preview'), '計算中…', async () => {
  screenSay('計算中…', 'info');
  const data = await call(window.api.screen.preview(collectScreenForm()), (err) => {
    screenSay('失敗：' + err, 'err');
  });
  if (!data) return;
  const lines = [`待處理 ${data.totals.todo}　待審核 ${data.totals.review}　逾期 ${data.totals.overdue}`, '', '【工程師】'];
  data.engineers.forEach((e) => lines.push(`${e.name}　待處理 ${e.todo}　待審核 ${e.review}${e.overdue ? `　逾期 ${e.overdue}` : ''}`));
  lines.push('', '【追蹤專案】');
  data.projects.forEach((p) => {
    lines.push(`${p.name}　待處理 ${p.todo}　待審核 ${p.review}${p.overdue ? `　逾期 ${p.overdue}` : ''}`);
    if (p.stages.length) lines.push('    ' + p.stages.map((s) => `${s.name} ${s.todo}/${s.review}`).join('　'));
  });
  $('screen-preview').textContent = lines.join('\n');
  $('screen-preview').classList.remove('hidden');
  screenSay(`預覽完成(在下方清單；用畫面上目前的設定算的，尚未推送也未儲存)：待處理 ${data.totals.todo}、待審核 ${data.totals.review}、逾期 ${data.totals.overdue}`, 'ok');
}));

window.api.screen.onChanged(async () => {
  renderScreenStatus(await call(window.api.screen.status()));
});

// 打開設定面板時載入(登入、工程師清單都要等主程式準備好)
$('btn-settings').addEventListener('click', () => {
  if (!$('settings-panel').classList.contains('hidden')) loadScreenSettings();
});
loadScreenSettings();
