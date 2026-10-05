// 獨立工單詳情視窗：工單id由main process開窗時帶在網址 ?id= 上，不回覆、不計時；專管可以轉單
const ticketId = new URLSearchParams(location.search).get('id');
let currentUserId = null;
let currentProjectId = null;
let canTransferTicket = false; // 身份是「專管」才會是true
let canEditAnyTicket = false; // 專管：可以回覆別人的工單
let canDeleteTicket = false; // 專管：可以刪除工單
let currentTicket = null;

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
  if (!isOwn && canEditAnyTicket) $('tw-not-own').textContent = '這張工單不是指派給你的，你是專管，可以回覆、轉單或刪除';
  currentProjectId = ticket.project_id || null;
  $('btn-tw-jump-to-site').classList.toggle('hidden', !currentProjectId);
  $('btn-tw-jump-to-project').classList.toggle('hidden', !currentProjectId);
  // 轉單僅限「專管」身份，且只有「已指派」狀態的工單可以轉(跟後端transfer()的限制一致)
  $('btn-tw-transfer').classList.toggle('hidden', !canTransferTicket || ticket.status !== 1);
  // 這個視窗不做回覆表單，回覆一律到主視窗左側的工單詳情；已結束(成功/關閉/刪除)的單後端不收回覆
  const closed = [2, 4, 8, 9].includes(ticket.status);
  $('btn-tw-reply').classList.toggle('hidden', closed || (!isOwn && !canEditAnyTicket));
  $('btn-tw-delete').classList.toggle('hidden', !canDeleteTicket || ticket.status === 9);
  currentTicket = ticket;

  $('tw-basic').innerHTML = ticketFullInfoRows(ticket);
  bindVersionEditor($('tw-basic'), ticket);
  bindTimeEditors($('tw-basic'), ticket);
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
// 轉單成功後重新讀取這張工單，顯示新的負責人員/狀態/轉單說明回覆
$('btn-tw-transfer').addEventListener('click', () => openTransferTicketModal(ticketId, loadTicket, currentTicket && currentTicket.end_time, currentTicket ? { [ticketId]: currentTicket.p_user_id } : undefined, currentTicket && currentTicket.start_time));
bindTransferTicketModal();
$('btn-tw-reply').addEventListener('click', () => call(window.api.window.jumpInMain('reply', ticketId)));
// 刪除後重新讀取，畫面會顯示「已刪除」狀態與刪除原因回覆
$('btn-tw-delete').addEventListener('click', () => {
  if (currentTicket) openDeleteTicketDialog(currentTicket, loadTicket);
});

(async function init() {
  const me = await call(window.api.eip.whoami(), () => {});
  if (me) {
    currentUserId = me.id;
    versionPermission.canAdd = !!me.can_add_version;
    canTransferTicket = !!me.can_transfer_ticket;
    canEditAnyTicket = !!me.can_edit_any_ticket;
    canDeleteTicket = !!me.can_delete_ticket;
  }
  loadTicket();
})();
