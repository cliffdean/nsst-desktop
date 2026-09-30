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

function openMediaPreview(url, name, isVideo) {
  imagePreviewUrl = url;
  $('image-preview-title').textContent = name || '';
  $('image-preview-img').classList.toggle('hidden', isVideo);
  $('image-preview-video').classList.toggle('hidden', !isVideo);
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
    if (e.target === e.currentTarget) closeImagePreview();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeImagePreview();
  });
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

function ticketInfoRows(rows) {
  return rows
    .filter(([, value]) => value != null && value !== '')
    .map(([label, value]) => `<span class="info-label">${label}</span><span class="info-value">${escapeHtmlPreserveNewlines(value)}</span>`)
    .join('');
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
    ['系統功能版本', ticket.version_text],
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
