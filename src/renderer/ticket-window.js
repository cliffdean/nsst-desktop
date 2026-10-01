// 獨立工單詳情視窗：工單id由main process開窗時帶在網址 ?id= 上，只做查看(不回覆、不計時)
const ticketId = new URLSearchParams(location.search).get('id');
let currentUserId = null;
let currentProjectId = null;

async function loadTicket() {
  $('tw-title').textContent = '讀取中...';
  const ticket = await call(window.api.eip.getTicket(ticketId), (err) => {
    $('tw-title').textContent = '讀取工單失敗：' + err;
  });
  if (!ticket) return;

  document.title = `${formatTicketNo(ticket.id)} ${ticket.summary || ''}`;
  $('tw-header').textContent = formatTicketNo(ticket.id);
  $('tw-title').textContent = ticket.summary || '(無摘要)';
  const isOwn = currentUserId == null || ticket.p_user_id === currentUserId;
  $('tw-not-own').classList.toggle('hidden', isOwn);
  currentProjectId = ticket.project_id || null;
  $('btn-tw-jump-to-site').classList.toggle('hidden', !currentProjectId);
  $('btn-tw-jump-to-project').classList.toggle('hidden', !currentProjectId);

  $('tw-basic').innerHTML = ticketFullInfoRows(ticket);
  bindVersionEditor($('tw-basic'), ticket);
  // 描述來自EIP富文本編輯器，本來就是HTML，直接用innerHTML才看得到正確排版
  $('tw-desc').innerHTML = ticket.description || '(無說明)';
  $('tw-attachments').innerHTML = attachmentsHtml(ticket.attachments);

  const replies = ticket.replies || [];
  $('tw-reply-count').textContent = replies.length ? `（共 ${replies.length} 則）` : '';
  $('tw-replies').innerHTML = replies.length
    ? replies.map((r) => ticketReplyHtml(r)).join('')
    : '<span style="color:#888;font-size:12px;">目前沒有回覆記錄</span>';

  bindAttachmentLinks($('tw-main'));
}

initMediaPreview();
$('btn-tw-copy-id').addEventListener('click', (e) => copyWithFeedback(e.currentTarget, ticketId));
$('btn-tw-reload').addEventListener('click', loadTicket);
$('btn-tw-jump-to-site').addEventListener('click', () => call(window.api.window.jumpInMain('site', currentProjectId)));
$('btn-tw-jump-to-project').addEventListener('click', () => call(window.api.window.jumpInMain('project', currentProjectId)));

(async function init() {
  const me = await call(window.api.eip.whoami(), () => {});
  if (me) {
    currentUserId = me.id;
    versionPermission.canAdd = !!me.can_add_version;
  }
  loadTicket();
})();
