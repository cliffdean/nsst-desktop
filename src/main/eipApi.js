const axios = require('axios');
const { settingsStore } = require('./store');

function client() {
  const baseURL = settingsStore.get('eipBaseUrl');
  const apiToken = settingsStore.get('apiToken');
  return axios.create({
    baseURL,
    timeout: 15000,
    headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : {},
    // 有些伺服器(Apache/FastCGI設定不同)會把Authorization header吃掉，後端也接受query string帶token，兩種都送以確保能通
    params: apiToken ? { api_token: apiToken } : {},
  });
}

async function whoami() {
  const res = await client().get('/whoami');
  return res.data.data;
}

// 可指派工單的在職人員(工程部排前面)，給左側「切換工程師」選單用
async function listEngineers() {
  const res = await client().get('/engineers');
  return res.data.data;
}

// 專案清單(含流程進度各階段的狀態)；status是逗號分隔的專案狀態代碼，不帶=全部
async function listProjects(q, status) {
  const params = {};
  if (q) params.q = q;
  if (status) params.status = status;
  const res = await client().get('/projects', { params });
  return res.data.data;
}

// 用EIP帳號密碼直接換一組API token，不用再手動跑 artisan api-token:generate
async function login(username, password) {
  const res = await client().post('/login', { username, password, label: '桌面工具-自助登入' });
  return res.data.data;
}

async function searchInstallLists(q) {
  const res = await client().get('/install-lists', { params: q ? { q } : {} });
  return res.data.data;
}

async function getInstallListByProject(projectId) {
  const res = await client().get('/install-lists', { params: { project_id: projectId } });
  return res.data.data;
}

async function getInstallList(id, ticketsBeforeId) {
  const res = await client().get(`/install-lists/${id}`, {
    params: ticketsBeforeId ? { tickets_before_id: ticketsBeforeId } : {},
  });
  return res.data.data;
}

// userId不帶=自己的工單；帶其他人的id=改看那位工程師的待辦(專案管理分配工作用，僅供查看)
async function listTickets(before, q, userId) {
  const params = {};
  if (before) params.before = before;
  if (q) params.q = q;
  if (userId) params.user_id = userId;
  const res = await client().get('/tickets', { params });
  return res.data.data;
}

// 全站搜尋所有工單(不限自己、含已結束)；/tickets 只會回自己的待辦，所以用專屬的 /tickets/search
async function searchTickets(q) {
  const params = {};
  if (q) params.q = q;
  const res = await client().get('/tickets/search', { params });
  return res.data.data;
}

async function getTicket(id) {
  const res = await client().get(`/tickets/${id}`);
  return res.data.data;
}

// 進階搜尋：filters是後端 GET /tickets/advanced-search 接受的query參數物件(keyword/fields/id_from/id_to/
// site_id/status/category/date_field/date_from/date_to/page/per_page...等，全部可選)，回傳{items, meta}
async function advancedSearchTickets(filters) {
  const res = await client().get('/tickets/advanced-search', { params: filters || {} });
  return { items: res.data.data, meta: res.data.meta };
}

// 進階搜尋表單用的選項清單(狀態/種類/類型/嚴重程度/可搜尋的時間欄位)，跟後端parameter_settings同步
async function getTicketSearchOptions() {
  const res = await client().get('/tickets/search-options');
  return res.data.data;
}

async function replyTicket(id, payload) {
  const res = await client().post(`/tickets/${id}/reply`, payload);
  return res.data.data;
}

async function attachFile(id, fileId) {
  const res = await client().post(`/tickets/${id}/attach`, { fileid: fileId });
  return res.data.data;
}

// 用Electron/Node內建的fetch+FormData做multipart上傳，不用額外裝套件
async function uploadFile(filePath) {
  const fs = require('fs');
  const path = require('path');
  const baseURL = settingsStore.get('eipBaseUrl');
  const apiToken = settingsStore.get('apiToken');

  const buffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('files[]', new Blob([buffer]), path.basename(filePath));

  const tokenQuery = apiToken ? `?api_token=${encodeURIComponent(apiToken)}` : '';
  const res = await fetch(`${baseURL.replace(/\/?$/, '')}/upload${tokenQuery}`, {
    method: 'POST',
    headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : {},
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `上傳失敗(HTTP ${res.status})`);
  }
  return body.data;
}

module.exports = {
  whoami,
  listEngineers,
  listProjects,
  login,
  listTickets,
  searchTickets,
  advancedSearchTickets,
  getTicketSearchOptions,
  getTicket,
  replyTicket,
  attachFile,
  uploadFile,
  searchInstallLists,
  getInstallListByProject,
  getInstallList,
};
