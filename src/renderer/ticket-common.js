// 主視窗(renderer.js)與獨立工單詳情視窗(ticket-window.js)共用的工具函式與工單排版，要在各自的script之前載入

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 備註這種自由文字欄位常常有換行，先跳脫HTML特殊字元再把換行轉成<br>，不然會全部擠成一行看不出段落
function escapeHtmlPreserveNewlines(text) {
  return escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>');
}

const $ = (id) => document.getElementById(id);

// 後端 /file/ 對圖片/影片回的Content-Type是application/jpg、application/mp4之類，瀏覽器會當成下載，
// 所以圖片、影片附件改在客戶端內用<img>/<video>顯示(不看Content-Type)，其他檔案才交給瀏覽器開
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];
const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'm4v', 'ogv'];

function fileExt(name) {
  const m = /.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

let imagePreviewUrl = '';
let imagePreviewScale = 1; // Ctrl+滾輪縮放用，1=原始大小
let imagePreviewDragStart = null; // { x, y, scrollLeft, scrollTop } 或 null(沒在拖曳)
let imagePreviewDidDrag = false; // 這次按下滑鼠到放開之間有沒有真的拖曳過，用來擋掉放開時誤觸backdrop的關閉

function currentPreviewTarget() {
  return $('image-preview-video').classList.contains('hidden') ? $('image-preview-img') : $('image-preview-video');
}

function openMediaPreview(url, name, isVideo) {
  imagePreviewUrl = url;
  imagePreviewScale = 1;
  $('image-preview-title').textContent = name || '';
  $('image-preview-img').classList.toggle('hidden', isVideo);
  $('image-preview-video').classList.toggle('hidden', !isVideo);
  $('image-preview-img').style.transform = '';
  $('image-preview-video').style.transform = '';
  $('image-preview-wrap').classList.remove('zoomed');
  $('image-preview-wrap').scrollLeft = 0;
  $('image-preview-wrap').scrollTop = 0;
  if (isVideo) $('image-preview-video').src = url;
  else $('image-preview-img').src = url;
  $('image-preview-backdrop').classList.remove('hidden');
}

function closeImagePreview() {
  $('image-preview-backdrop').classList.add('hidden');
  $('image-preview-img').removeAttribute('src');
  // 關掉視窗要停掉影片，不然會在背景繼續播放/下載
  const video = $('image-preview-video');
  video.pause();
  video.removeAttribute('src');
  video.load();
}

// 圖片有時原始尺寸很小看不清楚：Ctrl+滾輪縮放，放大超出視窗範圍時用原生捲軸(可以直接拖捲軸，也支援按住圖片拖曳平移)查看
function applyImagePreviewTransform() {
  currentPreviewTarget().style.transform = `scale(${imagePreviewScale.toFixed(2)})`;
  $('image-preview-wrap').classList.toggle('zoomed', imagePreviewScale > 1);
}

function zoomMediaPreview(deltaY) {
  imagePreviewScale = Math.min(5, Math.max(0.3, imagePreviewScale + (deltaY < 0 ? 0.1 : -0.1)));
  applyImagePreviewTransform();
}

function resetImagePreviewZoom() {
  imagePreviewScale = 1;
  applyImagePreviewTransform();
  $('image-preview-wrap').scrollLeft = 0;
  $('image-preview-wrap').scrollTop = 0;
}

// 附件連結點擊：圖片/影片→預覽視窗，其他→瀏覽器
function bindAttachmentLinks(container) {
  container.querySelectorAll('.attachment-link').forEach((el) => {
    el.addEventListener('click', () => {
      const url = el.dataset.url;
      const name = el.dataset.name;
      const ext = fileExt(name);
      if (IMAGE_EXTS.includes(ext)) openMediaPreview(url, name, false);
      else if (VIDEO_EXTS.includes(ext)) openMediaPreview(url, name, true);
      else window.api.shell.openExternal(url);
    });
  });
}

// 預覽視窗的DOM(#image-preview-*)每個頁面各自放一份，頁面載入時呼叫一次綁定關閉/開啟事件
function initMediaPreview() {
  $('btn-image-preview-close').addEventListener('click', closeImagePreview);
  $('btn-image-preview-open').addEventListener('click', () => window.api.shell.openExternal(imagePreviewUrl));
  $('image-preview-backdrop').addEventListener('click', (e) => {
    // 剛拖完圖片放開滑鼠時，瀏覽器可能把放開當下的位置(常常已經移到背景區域)當成一次click事件，
    // 若不擋掉會被下面這行誤判成「點了背景空白處」而關掉視窗，所以拖曳當下跳過這一次click
    if (imagePreviewDidDrag) {
      imagePreviewDidDrag = false;
      return;
    }
    if (e.target === e.currentTarget) closeImagePreview();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeImagePreview();
  });
  // Ctrl+滾輪縮放；一定要用{passive:false}才能擋掉Chromium預設的「ctrl+滾輪=整個頁面縮放」行為
  const wrap = $('image-preview-wrap');
  wrap.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomMediaPreview(e.deltaY);
    },
    { passive: false }
  );
  // 放大後(scale>1)按住滑鼠拖曳可以平移查看超出視窗的部分，直接拖動wrap的捲動位置(跟捲軸是同一套狀態，
  // 用捲軸拖、用滑鼠拖內容效果一致)；沒放大時維持原本的滑鼠行為(例如影片控制列要能正常點)
  wrap.addEventListener('mousedown', (e) => {
    if (imagePreviewScale <= 1) return;
    e.preventDefault();
    imagePreviewDragStart = { x: e.clientX, y: e.clientY, scrollLeft: wrap.scrollLeft, scrollTop: wrap.scrollTop };
    imagePreviewDidDrag = false;
    wrap.classList.add('dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!imagePreviewDragStart) return;
    const dx = e.clientX - imagePreviewDragStart.x;
    const dy = e.clientY - imagePreviewDragStart.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) imagePreviewDidDrag = true; // 超過3px才算真的拖曳，單純手滑一下不算
    wrap.scrollLeft = imagePreviewDragStart.scrollLeft - dx;
    wrap.scrollTop = imagePreviewDragStart.scrollTop - dy;
  });
  window.addEventListener('mouseup', () => {
    if (!imagePreviewDragStart) return;
    imagePreviewDragStart = null;
    wrap.classList.remove('dragging');
  });
  // 雙擊快速恢復100%大小，不用慢慢滾滾輪縮回去
  wrap.addEventListener('dblclick', resetImagePreviewZoom);
}

function formatSeconds(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

async function call(promise, onError) {
  const res = await promise;
  if (!res.ok) {
    if (onError) onError(res.error);
    else alert(res.error);
    return null;
  }
  return res.data;
}

// 狀態代碼對應語意色系：0新任務/1已指派=待處理(藍)，7追蹤=提醒(橘)，10品保中=審核(紫)，5失敗=警示(紅)，其餘預設灰
const STATUS_COLOR_CLASS = {
  0: 'status-info',
  1: 'status-info',
  5: 'status-danger',
  7: 'status-warning',
  10: 'status-qc',
};

function statusBadge(ticket) {
  // 已完成(品保通過)：工單流程上還要工程師回覆並把狀態設為「成功」，所以用圖示跟一般待處理工單區分
  if (Number(ticket.status) === 2) {
    return '<span class="status-badge status-finished" title="已完成：品保已通過，還需要工程師回覆並將狀態設為成功">✔ 已完成・待回覆成功</span>';
  }
  const cls = STATUS_COLOR_CLASS[ticket.status] || 'status-default';
  return `<span class="status-badge ${cls}">${escapeHtml(ticket.status_text || '')}</span>`;
}

// EIP單號顯示成 #000123 (補滿6碼)
function formatTicketNo(id) {
  return `#${String(id).padStart(6, '0')}`;
}

// 進度文字的顏色：超前/準時/進行中偏綠，延誤偏紅，其他(未開始等)維持灰色
function progressClass(text) {
  if (/延誤/.test(text)) return 'bad';
  if (/超前|準時|進行中/.test(text)) return 'good';
  return '';
}

// 時間欄位：EIP用 0000-00-00 00:00:00 表示沒填，這種值等同空白
function validTime(value) {
  return value && !String(value).startsWith('0000-00-00') ? String(value) : '';
}

// value可以是{ html }：已經組好的HTML，空值也照樣顯示(給可編輯欄位用)
function ticketInfoRows(rows) {
  return rows
    .filter(([, value]) => value != null && value !== '')
    .map(([label, value]) => {
      const html = typeof value === 'object' ? value.html : escapeHtmlPreserveNewlines(value);
      return `<span class="info-label">${label}</span><span class="info-value">${html}</span>`;
    })
    .join('');
}

// 系統功能版本：顯示文字+筆按鈕，點筆變成下拉選單，筆變成保存按鈕；綁定事件見bindVersionEditor
function versionEditorHtml(ticket) {
  return `<span class="version-editor"><span class="version-value">${escapeHtml(ticket.version_text || '-')}</span>`
    + '<button type="button" class="btn-version-edit" title="修改系統功能版本">✎</button>'
    + '<button type="button" class="btn-version-cancel hidden" title="取消修改">✕</button></span>';
}

// 版本選項跟後端search-options同一份(parameter_settings的project_version)，同一個視窗只抓一次
let versionOptionsPromise = null;
function loadVersionOptions() {
  if (!versionOptionsPromise) {
    versionOptionsPromise = call(window.api.eip.getTicketSearchOptions()).then((opts) => {
      if (!opts) versionOptionsPromise = null; // 失敗的話下次再重抓
      return opts ? opts.versions || [] : null;
    });
  }
  return versionOptionsPromise;
}

// 能不能在下拉選單新增版本(專管/總經理)，各視窗whoami完後設定，後端也會再檢查一次
const versionPermission = { canAdd: false };
const NEW_VERSION_VALUE = '__new__';

// ticket是目前顯示中的工單物件，存檔成功會直接更新它的version/version_text，onSaved給呼叫端同步其他畫面用
function bindVersionEditor(container, ticket, onSaved) {
  const box = container.querySelector('.version-editor');
  if (!box) return;
  const btn = box.querySelector('.btn-version-edit');
  const cancelBtn = box.querySelector('.btn-version-cancel');
  const valueEl = box.querySelector('.version-value');
  let field = null; // 編輯中的元素：版本下拉選單，或選了「新增版本」後換成的文字輸入框

  // 回到顯示模式：輸入元件換回文字，保存鈕變回筆，隱藏取消鈕
  const exitEdit = () => {
    if (field) field.replaceWith(valueEl);
    field = null;
    btn.textContent = '✎';
    btn.title = '修改系統功能版本';
    cancelBtn.classList.add('hidden');
  };
  cancelBtn.addEventListener('click', exitEdit);

  const swapField = (el) => {
    (field || valueEl).replaceWith(el);
    field = el;
    el.focus();
  };

  const showNewVersionInput = () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'version-new-input';
    input.placeholder = '輸入新版本名稱';
    swapField(input);
  };

  const showSelect = (options) => {
    const select = document.createElement('select');
    select.className = 'version-select';
    select.innerHTML = options
      .map((o) => `<option value="${o.value}" ${o.value === ticket.version ? 'selected' : ''}>${escapeHtml(o.text)}</option>`)
      .join('')
      + (versionPermission.canAdd ? `<option value="${NEW_VERSION_VALUE}">＋ 新增版本...</option>` : '');
    // 原本沒設定或對不到清單的版本，先停在空白，避免沒注意就存成第一個選項
    if (!options.some((o) => o.value === ticket.version)) select.selectedIndex = -1;
    select.addEventListener('change', () => {
      if (select.value === NEW_VERSION_VALUE) showNewVersionInput();
    });
    swapField(select);
  };

  // 新增版本是改全公司共用的清單，先確認；成功後更新本視窗的選項快取，回傳新版本的value
  const addNewVersion = async (name) => {
    if (!confirm(`確定要在全公司共用的系統功能版本清單最後面新增「${name}」嗎？
新增後無法從這裡刪除，只能到EIP參數設定處理。`)) return null;
    const data = await call(window.api.eip.addTicketVersion(name), (err) => alert('新增版本失敗：' + err));
    if (!data) return null;
    versionOptionsPromise = Promise.resolve(data.versions);
    return data.value;
  };

  btn.addEventListener('click', async () => {
    if (!field) {
      btn.disabled = true;
      const options = await loadVersionOptions();
      btn.disabled = false;
      if (!options) return;
      showSelect(options);
      btn.textContent = '💾';
      btn.title = '保存系統功能版本';
      cancelBtn.classList.remove('hidden');
      return;
    }

    btn.disabled = true;
    cancelBtn.disabled = true;
    try {
      let version;
      if (field.tagName === 'INPUT') {
        const name = field.value.trim();
        if (!name) return alert('請輸入新版本名稱');
        if (name.includes(',')) return alert('版本名稱不可包含逗號');
        version = await addNewVersion(name);
        if (version == null) return;
      } else {
        if (field.value === '') return alert('請先選擇系統功能版本');
        version = Number(field.value);
      }
      const data = await call(window.api.eip.updateTicketVersion(ticket.id, version), (err) => alert('修改系統功能版本失敗：' + err));
      if (!data) return;
      ticket.version = data.version;
      ticket.version_text = data.version_text;
      valueEl.textContent = data.version_text || '-';
      exitEdit();
      if (onSaved) onSaved(data);
    } finally {
      btn.disabled = false;
      cancelBtn.disabled = false;
    }
  });
}

// ---------------- 轉單(僅限「專管」身份，可把工單改指派給別的工程師，不限自己負責的工單) ----------------
// 主視窗與獨立工單視窗共用，兩邊的HTML都要有transfer-ticket-*這組對話框元素，載入後各自呼叫一次bindTransferTicketModal

let transferTicketIds = [];
let transferDoneCallback = null;
let transferAssignees = {}; // { 工單id: 目前負責人id }，轉給「本來就是負責人」的人時要擋下來
let transferOriginalEndTime = ''; // 開窗時預填的結束日期，沒被改動就不送，避免沒必要地改到工單
let transferEngineersPromise = null;

function loadTransferEngineers() {
  if (!transferEngineersPromise) {
    transferEngineersPromise = call(window.api.eip.listEngineers()).then((list) => {
      if (!list) transferEngineersPromise = null; // 失敗的話下次再重抓
      return list || [];
    });
  }
  return transferEngineersPromise;
}

// 批次操作：一張一張送(後端沒有批次API，也比較好知道哪張失敗)，回傳成功的id與失敗的{id, error}
async function runForEachTicket(ids, request) {
  const done = [];
  const failed = [];
  for (const id of ids) {
    const res = await request(id);
    if (res.ok) done.push(id);
    else failed.push({ id, error: res.error });
  }
  return { done, failed };
}

function batchFailedText(failed) {
  return failed.map((f) => `${formatTicketNo(f.id)}：${f.error}`).join('\n');
}

// EIP的時間字串(YYYY-MM-DD HH:MM:SS，0000-00-00代表沒填)轉成datetime-local輸入框要的 YYYY-MM-DDTHH:MM
function toDatetimeLocal(value) {
  const v = validTime(value);
  return v ? v.replace(' ', 'T').slice(0, 16) : '';
}

// ticketIds：單一id或id陣列(左側批次轉單)；onDone(成功的id，傳入陣列就回陣列)：給呼叫端重新整理畫面用
// currentEndTime：單張轉單時帶入該工單目前的結束日期當預設值；批次不帶(每張不同)，留空=不改
// assignees：{ 工單id: 目前負責人id }(選填)，用來檢查「本來就在A身上又轉給A」
async function openTransferTicketModal(ticketIds, onDone, currentEndTime, assignees) {
  const isBatch = Array.isArray(ticketIds);
  transferTicketIds = isBatch ? ticketIds : [ticketIds];
  transferAssignees = assignees || {};
  transferDoneCallback = onDone ? (done) => onDone(isBatch ? done : done[0]) : null;
  $('transfer-ticket-info').value = '';
  transferOriginalEndTime = isBatch ? '' : toDatetimeLocal(currentEndTime);
  $('transfer-ticket-end-time').value = transferOriginalEndTime;
  $('transfer-ticket-message').textContent = isBatch ? `共 ${transferTicketIds.length} 張工單會轉給同一位工程師，並寫入同一段說明` : '';
  $('transfer-ticket-target').innerHTML = '<option value="">讀取工程師清單中...</option>';
  $('transfer-ticket-backdrop').classList.remove('hidden');

  const list = (await loadTransferEngineers()).filter((e) => e.is_engineering);
  $('transfer-ticket-target').innerHTML = list.length
    ? list.map((e) => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('')
    : '<option value="">沒有可轉單的工程師</option>';
}

function closeTransferTicketModal() {
  $('transfer-ticket-backdrop').classList.add('hidden');
  transferTicketIds = [];
  transferDoneCallback = null;
}

async function submitTransferTicket() {
  if (!transferTicketIds.length) return;
  const info = $('transfer-ticket-info').value.trim();
  const chgUserId = $('transfer-ticket-target').value;
  if (!chgUserId) {
    $('transfer-ticket-message').textContent = '請選擇轉單對象';
    return;
  }
  if (!info) {
    $('transfer-ticket-message').textContent = '請填寫轉單說明';
    return;
  }

  // 本來就是這位工程師負責的單不需要再轉：全部都是就擋下來；只有部分是就問要不要略過這幾張
  const already = transferTicketIds.filter((id) => transferAssignees[String(id)] != null && String(transferAssignees[String(id)]) === String(chgUserId));
  if (already.length) {
    const who = $('transfer-ticket-target').selectedOptions[0].textContent;
    const list = already.map((id) => formatTicketNo(id)).join('、');
    if (already.length === transferTicketIds.length) {
      $('transfer-ticket-message').textContent = `${list} 本來就是 ${who} 負責的，不需要再轉單給同一個人，請改選其他工程師`;
      return;
    }
    if (!confirm(`${already.length} 張本來就是 ${who} 負責的，不需要再轉：\n${list}\n\n略過這幾張，只轉其餘 ${transferTicketIds.length - already.length} 張嗎？`)) return;
    const skip = new Set(already.map(String));
    transferTicketIds = transferTicketIds.filter((id) => !skip.has(String(id)));
  }

  const endTimeValue = $('transfer-ticket-end-time').value;
  const endTime = endTimeValue && endTimeValue !== transferOriginalEndTime ? endTimeValue : '';

  const btn = $('btn-transfer-ticket-submit');
  btn.disabled = true;
  $('transfer-ticket-message').textContent = '處理中...';
  const ids = transferTicketIds;
  const onDone = transferDoneCallback;
  const { done, failed } = await runForEachTicket(ids, (id) => window.api.eip.transferTicket(id, info, chgUserId, endTime));
  btn.disabled = false;

  if (failed.length) {
    // 有失敗的就留著對話框顯示原因；成功的已經轉出去了，剩下沒成功的可以改完再按一次
    transferTicketIds = failed.map((f) => f.id);
    $('transfer-ticket-message').textContent = ids.length > 1
      ? `成功 ${done.length} 張，失敗 ${failed.length} 張：
${batchFailedText(failed)}`
      : '轉單失敗：' + failed[0].error;
    if (done.length && onDone) onDone(done);
    return;
  }
  closeTransferTicketModal();
  if (onDone) onDone(done);
}

function bindTransferTicketModal() {
  $('btn-transfer-ticket-close').addEventListener('click', closeTransferTicketModal);
  $('btn-transfer-ticket-submit').addEventListener('click', submitTransferTicket);
  $('transfer-ticket-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeTransferTicketModal();
  });
}

// ---------------- 刪除工單(僅限「專管」，後端只把狀態改成已刪除，並寫一則回覆記錄刪除原因) ----------------
// 主視窗與獨立工單視窗共用；對話框用JS動態建立，兩邊的HTML都不用另外放元素

// tickets：單一工單物件或陣列(左側批次刪除)；onDone(成功的id，傳入陣列就回陣列)：給呼叫端重新整理畫面用
function openDeleteTicketDialog(tickets, onDone) {
  const isBatch = Array.isArray(tickets);
  let pending = isBatch ? tickets : [tickets];
  const listHtml = pending.length === 1
    ? `${escapeHtml(formatTicketNo(pending[0].id))} ${escapeHtml(pending[0].summary || '')}`
    : `以下 ${pending.length} 張工單：<br>${pending.map((t) => `${escapeHtml(formatTicketNo(t.id))} ${escapeHtml(t.summary || '')}`).join('<br>')}<br>`;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal-box">
      <div class="modal-header">
        <h2>刪除工單</h2>
        <button type="button" data-act="close">✕</button>
      </div>
      <p style="color:#d84f4f;max-height:200px;overflow:auto;">確定要刪除 ${listHtml} 嗎？</p>
      <p class="meta">跟EIP網頁的刪除一樣只會把狀態改成「已刪除」，不會真的移除資料；刪除原因會記錄在工單回覆裡。</p>
      <label>刪除原因(選填${pending.length > 1 ? '，每張都會寫入同一段' : ''})
        <textarea rows="3" data-role="reason" placeholder="例如：重複開單"></textarea>
      </label>
      <div class="actions">
        <button type="button" data-act="submit" class="btn-danger">確認刪除</button>
        <button type="button" data-act="close">取消</button>
      </div>
      <p class="meta" data-role="message" style="white-space:pre-line;"></p>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  const message = backdrop.querySelector('[data-role="message"]');
  const submitBtn = backdrop.querySelector('[data-act="submit"]');
  const report = (done) => { if (done.length && onDone) onDone(isBatch ? done : done[0]); };

  backdrop.addEventListener('click', async (e) => {
    if (e.target === backdrop || e.target.closest('[data-act="close"]')) {
      close();
      return;
    }
    if (!e.target.closest('[data-act="submit"]')) return;
    submitBtn.disabled = true;
    message.textContent = '處理中...';
    const reason = backdrop.querySelector('[data-role="reason"]').value.trim();
    const total = pending.length;
    const { done, failed } = await runForEachTicket(pending.map((t) => t.id), (id) => window.api.eip.deleteTicket(id, reason));
    submitBtn.disabled = false;
    if (failed.length) {
      // 失敗的留著讓使用者看原因、可以再按一次重試；成功的先通知呼叫端更新畫面
      const failedIds = new Set(failed.map((f) => String(f.id)));
      pending = pending.filter((t) => failedIds.has(String(t.id)));
      message.textContent = total > 1
        ? `成功 ${done.length} 張，失敗 ${failed.length} 張：
${batchFailedText(failed)}`
        : '刪除失敗：' + failed[0].error;
      report(done);
      return;
    }
    close();
    report(done);
  });
  backdrop.querySelector('[data-role="reason"]').focus();
}

// 一則回覆：回覆人／時間／當時標記的狀態、實際工作時段與耗時、回覆內容(EIP富文本HTML)、附檔
// collapsible=true時(左側工單詳情)：預設收起，只留回覆頭一行，點擊後才展開內容，避免回覆一多畫面被拉得很長
function ticketReplyHtml(r, collapsible = false) {
  const workStart = validTime(r.work_start_time);
  const workEnd = validTime(r.work_end_time);
  const duration = Number(r.actual_duration_seconds) > 0 ? formatSeconds(r.actual_duration_seconds) : '';
  const workLine = workStart || workEnd
    ? `<div class="ts-reply-work">工作時間：${escapeHtml(workStart || '-')} ~ ${escapeHtml(workEnd || '-')}${duration ? `（耗時 ${duration}）` : ''}</div>`
    : duration ? `<div class="ts-reply-work">耗時：${duration}</div>` : '';
  const files = (r.files || [])
    .map((f) => `<span class="attachment-link" data-url="${escapeHtml(f.url)}" data-name="${escapeHtml(f.original_filename)}">📎 ${escapeHtml(f.original_filename)}</span>`)
    .join('');
  return `<div class="ts-reply${collapsible ? ' collapsed' : ''}">
    <div class="ts-reply-head"${collapsible ? ' data-toggle="reply"' : ''}>
      ${collapsible ? '<span class="ts-reply-caret"></span>' : ''}
      <strong>${escapeHtml(r.user_name || '(未知)')}</strong>
      <span>${escapeHtml(r.created_at || '')}</span>
      ${r.status_text ? `<span class="status-badge status-default">${escapeHtml(r.status_text)}</span>` : ''}
    </div>
    <div class="ts-reply-content">
      ${workLine}
      <div class="ts-reply-body">${r.reply || '(無內容)'}</div>
      ${files}
    </div>
  </div>`;
}

// 收合式回覆列表點擊展開/收起：一次綁在容器上即可，不用每則回覆分別綁
function bindReplyToggles(container) {
  container.querySelectorAll('.ts-reply-head[data-toggle="reply"]').forEach((head) => {
    head.addEventListener('click', () => head.closest('.ts-reply').classList.toggle('collapsed'));
  });
}

// 工單完整資訊欄位：順序與名稱對齊EIP總表；所有代碼(狀態/類型/人員ID等)都已由後端轉成文字，這裡不顯示任何裸ID
function ticketFullInfoRows(ticket) {
  const estimate = Number(ticket.estimate) > 0 ? `${ticket.estimate} 小時` : '';
  return ticketInfoRows([
    ['單號', formatTicketNo(ticket.id)],
    ['狀態', ticket.is_qc_stage ? `${ticket.status_text}（已轉品保）` : ticket.status_text],
    ['進度', ticket.progress_text],
    ['任務類型', ticket.kind_name],
    ['專案名稱', ticket.project_name],
    ['類型', ticket.type_label],
    ['分類', ticket.classification],
    ['嚴重程度', ticket.severity_text],
    ['負責人員', ticket.p_user_name],
    ['反應人', ticket.c_user_name],
    ['客戶名稱', ticket.customer_name],
    ['經銷商', ticket.dealer_name],
    ['系統功能版本', { html: versionEditorHtml(ticket) }],
    ['負責業務', ticket.sales_name],
    ['預計工時', estimate],
    ['創建日期', validTime(ticket.created_at)],
    ['任務開始日期', validTime(ticket.start_time)],
    ['任務結束日期', validTime(ticket.end_time)],
    ['最後更新', validTime(ticket.updated_at)],
  ]);
}

function attachmentsHtml(files) {
  return files && files.length
    ? files.map((f) => `<span class="attachment-link" data-url="${escapeHtml(f.url)}" data-name="${escapeHtml(f.original_filename)}">📎 ${escapeHtml(f.original_filename)}</span>`).join('')
    : '<span style="color:#888;font-size:12px;">目前沒有附件</span>';
}

// 複製到剪貼簿，按鈕文字短暫變成「已複製」當作回饋，不然按了沒反應會以為沒複製到
function copyWithFeedback(btn, text) {
  window.api.clipboard.copy(String(text));
  if (!btn) return;
  const original = btn.textContent;
  btn.textContent = '已複製';
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 800);
}
