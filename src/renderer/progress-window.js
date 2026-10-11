// 專案進度視窗(甘特圖)：資料來自後端 /project-progress，邏輯與網頁端 manage/internal/project_progress 同一份，不含匯出
const $ = (id) => document.getElementById(id);

const PX = { day: 36, week: 14, month: 5 };
const PROJECT_COLORS = ['#3b82f6', '#06b6d4', '#22a559', '#8b5cf6', '#f59e0b', '#ec4899'];
// 工單狀態代碼 => 標籤/時間條顏色
const STATUS_COLOR = { 0: '#8c959f', 1: '#2f80ed', 2: '#22a559', 3: '#0ea5a5', 4: '#22a559', 5: '#8b5cf6', 6: '#8c959f', 7: '#f59e0b', 8: '#6b7280', 10: '#7c4dff' };
const OVERDUE_COLOR = '#f26d6d';
const SEV_COLOR = ['#e5484d', '#f59e0b', '#22a559'];
const MAX_PROJECTS = 20;
const DEFAULT_STATUS = [0, 1, 3, 6, 7]; // 新任務、已指派、已暫停、未定義、追蹤中
const LEFT_W = 300 + 70 + 100 + 84 + 70 + 62 + 62 + 84;

let zoom = 'week';
let loaded = null;
let collapsed = {};
let options = { projects: [], statuses: [], users: [] };
let selectedProjects = [];
let statusBox = null;
let userBox = null;

function esc(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const pad = (n) => (n < 10 ? '0' : '') + n;
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function toDate(str) {
  const p = str.split('-');
  return new Date(+p[0], +p[1] - 1, +p[2]);
}
const dayDiff = (a, b) => Math.round((a.getTime() - b.getTime()) / 86400000);
const md = (str) => (str ? `${str.substr(5, 2)}/${str.substr(8, 2)}` : '');

async function call(promise, onError) {
  const res = await promise;
  if (!res.ok) {
    if (onError) onError(res.error);
    else alert(res.error);
    return null;
  }
  return res.data;
}

function defaultRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 3, 1);
  return { from: fmt(from), to: fmt(to) };
}

// ----- 通用複選(標籤 + 下拉勾選) -----
function createMulti(boxId, opts, initial, emptyText) {
  const box = $(boxId);
  const chips = box.querySelector('.chips');
  const drop = box.querySelector('.drop');
  const list = box.querySelector('.options');
  let sel = initial.slice();
  let items = opts;
  const nameOf = (id) => { const o = items.find((x) => x.id === id); return o ? o.name : ''; };
  function drawChips() {
    chips.innerHTML = sel.map((id) => `<span class="chip">${esc(nameOf(id))}<i data-id="${id}">×</i></span>`).join('')
      || `<span class="placeholder">${esc(emptyText)}</span>`;
  }
  function drawOptions() {
    list.innerHTML = items.map((o) => `<label><input type="checkbox" value="${o.id}" ${sel.includes(o.id) ? 'checked' : ''} /> ${esc(o.name)}</label>`).join('');
  }
  chips.addEventListener('click', (e) => {
    const rm = e.target.closest('i[data-id]');
    if (rm) {
      sel = sel.filter((x) => x !== Number(rm.dataset.id));
      drawChips();
      drawOptions();
      return;
    }
    document.querySelectorAll('.drop.open').forEach((d) => { if (d !== drop) d.classList.remove('open'); });
    drop.classList.toggle('open');
    drawOptions();
  });
  list.addEventListener('change', (e) => {
    const id = Number(e.target.value);
    sel = sel.filter((x) => x !== id);
    if (e.target.checked) sel.push(id);
    drawChips();
  });
  document.addEventListener('click', (e) => { if (!box.contains(e.target)) drop.classList.remove('open'); });
  drawChips();
  return {
    get: () => sel.slice(),
    set: (a) => { sel = a.slice(); drawChips(); drawOptions(); },
    setItems: (o) => { items = o; drawChips(); drawOptions(); },
  };
}

// ----- 專案多選(有搜尋、最多20個) -----
function drawProjectChips() {
  const html = selectedProjects.map((id) => {
    const p = options.projects.find((x) => x.id === id);
    return p ? `<span class="chip">${esc(p.name)}<i data-id="${id}">×</i></span>` : '';
  }).join('');
  $('projects-chips').innerHTML = html
    || `<span class="placeholder">${$('starred').checked ? '全部加星專案(點此選擇)' : '全部進行中專案(點此選擇)'}</span>`;
}
function drawProjectOptions() {
  const kw = $('projects-search').value.trim().toLowerCase();
  $('projects-hint').textContent = `已選 ${selectedProjects.length} / ${MAX_PROJECTS} 個專案`;
  $('projects-options').innerHTML = options.projects
    .filter((p) => !kw || (p.name || '').toLowerCase().includes(kw) || String(p.id).includes(kw))
    .map((p) => {
      const on = selectedProjects.includes(p.id);
      const full = !on && selectedProjects.length >= MAX_PROJECTS;
      return `<label style="${full ? 'opacity:.5;cursor:not-allowed' : ''}"><input type="checkbox" value="${p.id}" ${on ? 'checked' : ''} ${full ? 'disabled' : ''} /> `
        + `${p.starred ? '<span style="color:#f5b301">★</span> ' : ''}#${p.id} ${esc(p.name)} <small style="color:#999">${esc(p.status_text)}</small></label>`;
    }).join('') || '<div class="empty" style="padding:14px">沒有符合的專案</div>';
}

// ----- 資料 -----
function filters() {
  const params = { project_ids: selectedProjects, from: $('date-from').value, to: $('date-to').value };
  const statuses = statusBox.get();
  const users = userBox.get();
  if (statuses.length) params.status = statuses;
  if (users.length) params.user_ids = users;
  if ($('starred').checked) params.starred = 1;
  return params;
}

let querySeq = 0;
async function query() {
  const seq = ++querySeq;
  $('inner').innerHTML = '<div class="empty">讀取中...</div>';
  const data = await call(window.api.eip.projectProgress(filters()), (err) => {
    if (seq === querySeq) $('inner').innerHTML = `<div class="empty" style="color:#d84f4f">讀取失敗：${esc(err)}</div>`;
  });
  if (!data || seq !== querySeq) return;
  loaded = data;
  if (data.options) {
    options = data.options;
    statusBox.setItems(options.statuses.map((s) => ({ id: s.code, name: s.text })));
    userBox.setItems([{ id: 0, name: '未指派' }].concat(options.users));
  }
  drawProjectChips();
  render();
}

// ----- 繪製 -----
function render() {
  if (!loaded) return;
  if (!loaded.projects.length) {
    $('inner').style.width = '';
    $('inner').innerHTML = `<div class="empty">${$('starred').checked && !selectedProjects.length
      ? '還沒有符合條件的加星專案。到專案查詢點 ☆ 加星，或取消「僅顯示有星號的案件」查看全部。'
      : '沒有符合條件的專案或工單'}</div>`;
    return;
  }
  const range = defaultRange();
  const from = toDate($('date-from').value || range.from);
  let to = toDate($('date-to').value || range.to);
  if (to < from) to = from;
  const days = dayDiff(to, from) + 1;
  const px = PX[zoom];
  const width = days * px;
  const today = toDate(loaded.today);
  const todayX = dayDiff(today, from) * px + px / 2;

  let months = '';
  let ticks = '';
  let grid = '';
  for (let i = 0; i < days; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    const x = i * px;
    if (d.getDate() === 1 || i === 0) {
      const left = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate() + 1;
      months += `<div style="left:${x}px;width:${Math.min(left, days - i) * px}px">${d.getFullYear()}年 ${d.getMonth() + 1}月</div>`;
    }
    let label = null;
    if (zoom === 'day') label = d.getDate();
    else if (zoom === 'week' && (d.getDay() === 1 || i === 0)) label = `${d.getMonth() + 1}/${d.getDate()}`;
    else if (zoom === 'month' && (d.getDate() === 1 || d.getDate() === 15)) label = `${d.getMonth() + 1}/${d.getDate()}`;
    if (label !== null) {
      ticks += `<div style="left:${x}px;width:${(zoom === 'day' ? 1 : zoom === 'week' ? 7 : 14) * px}px">${label}</div>`;
      grid += `<div class="grid" style="left:${x}px"></div>`;
    }
  }

  const bar = (start, end, color, text, cls, title) => {
    if (!start && !end) return '';
    const s = toDate(start || end);
    const e = toDate(end || start);
    let x1 = dayDiff(s, from);
    let x2 = dayDiff(e, from) + 1;
    if (x1 >= days) return '';
    if (x2 <= 0) { x1 = 0; x2 = 0.01; } // 整條在顯示範圍之前(逾期很久)：最左邊畫一小段提示
    x1 = Math.max(0, x1);
    x2 = Math.min(days, x2);
    return `<div class="bar ${cls || ''}" title="${esc(title || '')}" style="left:${x1 * px}px;width:${Math.max(6, (x2 - x1) * px)}px;background:${color}">${esc(text)}</div>`;
  };
  const timeCell = (inner) => `<div class="time" style="width:${width}px">${grid}${inner}</div>`;

  let rows = '';
  let colorIdx = 0;
  const projectRows = (p, depth, color) => {
    const key = `p${p.id}`;
    const closed = !!collapsed[key];
    const indent = depth * 22;
    rows += `<div class="row project"><div class="left" style="width:${LEFT_W}px">`
      + `<div class="c name" style="width:${300 + 70 + 100 + 84 + 70}px;padding-left:${8 + indent}px">`
      + `<span class="toggle" data-key="${key}">${closed ? '▸' : '▾'}</span>`
      + `<span class="folder" style="color:${color}">▣</span>`
      + `<span title="${esc(p.name)}">${esc(p.name)}</span><span class="count">(${p.ticket_total})</span>`
      + `<span class="star ${p.starred ? 'on' : ''}" data-id="${p.id}" title="${p.starred ? '取消關注' : '加星關注'}">${p.starred ? '★' : '☆'}</span>`
      + (p.overdue_total ? `<span class="tag" style="background:${OVERDUE_COLOR};margin-left:8px">逾期 ${p.overdue_total}</span>` : '')
      + '</div>'
      + `<div class="c date">${md(p.start)}</div><div class="c date">${md(p.end)}</div><div class="c user"></div>`
      + `</div>${timeCell(bar(p.start, p.end, color, p.name, 'project', `${p.name} ${p.start || ''} ~ ${p.end || ''}`))}</div>`;
    if (closed) return;
    p.tickets.forEach((t) => {
      const color2 = t.overdue ? OVERDUE_COLOR : (STATUS_COLOR[t.status] || '#8c959f');
      const title = `#${t.id} ${t.summary}\n${t.stage_text ? `流程階段：${t.stage_text}\n` : ''}${t.start || ''} ~ ${t.end || ''}\n${t.user_name}・${t.status_text}`;
      rows += `<div class="row"><div class="left" style="width:${LEFT_W}px">`
        + `<div class="c name" style="padding-left:${34 + indent + 22}px" title="${esc(title)}">`
        + `<a class="ticket-link" data-ticket="${t.id}">#${t.id} ${esc(t.summary)}</a></div>`
        + `<div class="c type">${esc(t.type_text)}</div><div class="c kind" title="${esc(t.kind_text)}">${esc(t.kind_text)}</div>`
        + `<div class="c stage"><span class="tag" style="background:${STATUS_COLOR[t.status] || '#8c959f'}">${esc(t.status_text)}</span></div>`
        + `<div class="c sev"><span class="tag" style="background:${SEV_COLOR[t.severity] || '#8c959f'};min-width:36px">${esc(t.severity_text)}</span></div>`
        + `<div class="c date">${md(t.start)}</div><div class="c date ${t.overdue ? 'overdue' : ''}" title="${t.overdue ? '已逾期' : ''}">${md(t.end)}</div><div class="c user">${esc(t.user_name)}</div>`
        + `</div>${timeCell(bar(t.start, t.end, color2, `#${t.id} ${t.summary}`, '', title))}</div>`;
    });
    p.children.forEach((ch) => projectRows(ch, depth + 1, '#22a559'));
  };
  loaded.projects.forEach((p) => projectRows(p, 0, PROJECT_COLORS[colorIdx++ % PROJECT_COLORS.length]));

  const head = `<div class="row head"><div class="left" style="width:${LEFT_W}px">`
    + '<div class="c name">專案 / 工單</div><div class="c type">任務類型</div><div class="c kind">任務分類</div>'
    + '<div class="c stage">任務階段</div><div class="c sev">緊急程度</div><div class="c date">起始日</div><div class="c date">結束日</div><div class="c user">負責人</div></div>'
    + `<div class="time" style="width:${width}px"><div class="months">${months}</div><div class="ticks">${ticks}</div>`
    + (todayX >= 0 && todayX <= width ? `<span class="today-flag" style="left:${todayX}px">今天</span>` : '') + '</div></div>';
  const todayLine = todayX >= 0 && todayX <= width ? `<div class="today" style="left:${LEFT_W + todayX}px"></div>` : '';
  $('inner').style.width = `${LEFT_W + width}px`;
  $('inner').innerHTML = head + rows + todayLine;
}

// ----- 互動 -----
$('inner').addEventListener('click', async (e) => {
  const toggle = e.target.closest('.toggle');
  if (toggle) {
    collapsed[toggle.dataset.key] = !collapsed[toggle.dataset.key];
    render();
    return;
  }
  const ticket = e.target.closest('.ticket-link');
  if (ticket) {
    call(window.api.window.openTicket(ticket.dataset.ticket));
    return;
  }
  const star = e.target.closest('.star');
  if (star) {
    const id = Number(star.dataset.id);
    const starred = await call(window.api.projectStar.toggle(String(id)), (err) => alert('加星失敗：' + err));
    if (starred === null || starred === undefined) return;
    const mark = (list) => list.forEach((p) => { if (p.id === id) p.starred = starred; mark(p.children); });
    mark(loaded.projects);
    options.projects.forEach((p) => { if (p.id === id) p.starred = starred; });
    if ($('starred').checked && !starred) query();
    else render();
  }
});

$('projects-chips').addEventListener('click', (e) => {
  const rm = e.target.closest('i[data-id]');
  if (rm) {
    selectedProjects = selectedProjects.filter((x) => x !== Number(rm.dataset.id));
    drawProjectChips();
    drawProjectOptions();
    return;
  }
  document.querySelectorAll('.drop.open').forEach((d) => { if (d !== $('projects-drop')) d.classList.remove('open'); });
  $('projects-drop').classList.toggle('open');
  drawProjectOptions();
  if ($('projects-drop').classList.contains('open')) $('projects-search').focus();
});
$('projects-search').addEventListener('input', drawProjectOptions);
$('projects-options').addEventListener('change', (e) => {
  const id = Number(e.target.value);
  selectedProjects = selectedProjects.filter((x) => x !== id);
  if (e.target.checked) selectedProjects.push(id);
  drawProjectChips();
  drawProjectOptions();
});
document.addEventListener('click', (e) => {
  if (!$('projects-box').contains(e.target)) $('projects-drop').classList.remove('open');
});

$('zoom').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  zoom = btn.dataset.zoom;
  document.querySelectorAll('#zoom button').forEach((b) => b.classList.toggle('active', b === btn));
  render();
});
$('btn-search').addEventListener('click', query);
$('btn-reload').addEventListener('click', query);
$('starred').addEventListener('change', () => { drawProjectChips(); query(); });
$('btn-reset').addEventListener('click', () => {
  const range = defaultRange();
  selectedProjects = [];
  collapsed = {};
  $('starred').checked = true;
  statusBox.set(DEFAULT_STATUS);
  userBox.set([]);
  $('date-from').value = range.from;
  $('date-to').value = range.to;
  drawProjectChips();
  query();
});

// 其他視窗/電腦改了加星、工單：回到視窗時重新讀取，不用手動按重新整理
window.addEventListener('focus', () => { if (loaded) query(); });

(function init() {
  const range = defaultRange();
  $('date-from').value = range.from;
  $('date-to').value = range.to;
  statusBox = createMulti('status-box', [], DEFAULT_STATUS, '全部未完成狀態(點此選擇)');
  userBox = createMulti('user-box', [], [], '全部負責人(點此選擇)');
  drawProjectChips();
  query();
})();
