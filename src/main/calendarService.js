const axios = require('axios');
const https = require('https');
const { XMLParser } = require('fast-xml-parser');
const { settingsStore } = require('./store');

// 每個共用行事曆各給一個固定顏色。按discoverCalendars()回傳的順序分配(不是用名字算hash)，
// 這樣只要行事曆數量不超過調色盤大小，保證每個顏色都不一樣，不會像之前用hash算導致撞色
const PALETTE = ['#2f6fd8', '#d8862f', '#3fa876', '#a83fa0', '#c94f4f', '#4f9cc9', '#8a7fd8', '#4f4fc9', '#c9954f', '#4fc9a8'];
function colorForIndex(index) {
  return PALETTE[index % PALETTE.length];
}

function unfoldIcs(ics) {
  return ics.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

function parseIcsDate(value) {
  if (!value) return null;
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(T(\d{2})(\d{2})(\d{2})Z?)?$/);
  if (!m) return null;
  if (m[4]) {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[5], +m[6], +m[7]));
  }
  return new Date(+m[1], +m[2] - 1, +m[3]); // 全天事件，用本地日期
}

function parseVEvents(icsText) {
  const unfolded = unfoldIcs(icsText);
  const blocks = unfolded.split('BEGIN:VEVENT').slice(1);
  const events = [];

  for (const block of blocks) {
    const body = block.split('END:VEVENT')[0];
    const lines = body.split(/\r?\n/).filter(Boolean);
    const fields = {};
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const rawKey = line.slice(0, idx);
      const value = line.slice(idx + 1);
      const key = rawKey.split(';')[0];
      fields[key] = { value, allDay: rawKey.includes('VALUE=DATE') };
    }
    if (!fields.SUMMARY && !fields.DTSTART) continue;
    events.push({
      uid: fields.UID ? fields.UID.value : null,
      summary: fields.SUMMARY ? fields.SUMMARY.value : '(無標題)',
      description: fields.DESCRIPTION ? fields.DESCRIPTION.value.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';') : '',
      start: fields.DTSTART ? parseIcsDate(fields.DTSTART.value) : null,
      end: fields.DTEND ? parseIcsDate(fields.DTEND.value) : null,
      allDay: fields.DTSTART ? fields.DTSTART.allDay : false,
    });
  }
  return events;
}

function httpsAgentFor(mail) {
  return mail.imapAllowInsecureTLS ? new https.Agent({ rejectUnauthorized: false }) : undefined;
}

async function propfind(url, auth, httpsAgent, xmlBody, depth) {
  const res = await axios.request({
    url,
    method: 'PROPFIND',
    headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
    auth,
    data: xmlBody,
    httpsAgent,
    timeout: 15000,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    throw new Error(`PROPFIND ${url} 失敗(HTTP ${res.status})`);
  }
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
  return parser.parse(res.data);
}

// 從一個response節點裡，取出status為200的那個propstat底下的某個prop值(忽略404的propstat)
function propFromResponse(response, propName) {
  let propstats = response.propstat;
  if (!propstats) return null;
  if (!Array.isArray(propstats)) propstats = [propstats];
  for (const ps of propstats) {
    const status = String(ps.status || '');
    if (status.includes('200') && ps.prop && ps.prop[propName] !== undefined) {
      return ps.prop[propName];
    }
  }
  return null;
}

function asArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

// 找出這個帳號名下所有的行事曆(自己的+別人分享給自己看的)，回傳 [{url, name}]
async function discoverCalendars() {
  const mail = settingsStore.get('mail');
  if (!mail.calendarUrl || !mail.username || !mail.password) {
    throw new Error('尚未設定行事曆網址/信箱帳密，請先到設定裡填寫');
  }
  const auth = { username: mail.username, password: mail.password };
  const httpsAgent = httpsAgentFor(mail);
  const origin = new URL(mail.calendarUrl).origin;

  // Step1: 標準CalDAV discovery入口，通常會redirect到真正的DAV根目錄
  let davBase = origin + '/';
  try {
    const res = await axios.request({
      url: origin + '/.well-known/caldav',
      method: 'PROPFIND',
      headers: { Depth: '0' },
      auth,
      httpsAgent,
      maxRedirects: 0,
      timeout: 10000,
      validateStatus: () => true,
    });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      const loc = res.headers.location;
      davBase = loc.startsWith('http') ? loc : origin + loc;
    }
  } catch (e) {
    // 找不到就退回用origin當base，下面的PROPFIND如果也失敗，最外層會報錯
  }

  // Step2: 拿目前登入者的principal
  const principalXml = await propfind(
    davBase,
    auth,
    httpsAgent,
    '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>',
    0
  );
  const principalHref = propFromResponse(principalXml.multistatus.response, 'current-user-principal');
  if (!principalHref || !principalHref.href) {
    throw new Error('找不到行事曆principal，可能是這台伺服器的CalDAV路徑結構不同');
  }
  const principalUrl = origin + principalHref.href;

  // Step3: 拿calendar-home-set
  const homeXml = await propfind(
    principalUrl,
    auth,
    httpsAgent,
    '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>',
    0
  );
  const homeHref = propFromResponse(homeXml.multistatus.response, 'calendar-home-set');
  if (!homeHref || !homeHref.href) {
    throw new Error('找不到calendar-home-set');
  }
  const homeUrl = origin + homeHref.href;

  // Step4: 列出這個home底下所有行事曆(含別人分享的)
  const listXml = await propfind(
    homeUrl,
    auth,
    httpsAgent,
    '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>',
    1
  );
  const responses = asArray(listXml.multistatus.response);
  const calendars = [];
  for (const r of responses) {
    const resourcetype = propFromResponse(r, 'resourcetype');
    const isCalendar = resourcetype && Object.prototype.hasOwnProperty.call(resourcetype, 'calendar');
    if (!isCalendar) continue; // 排除inbox/outbox/home本身這些非真正行事曆的collection
    const displayname = propFromResponse(r, 'displayname');
    const href = r.href;
    calendars.push({
      url: origin + href,
      name: typeof displayname === 'string' ? displayname : href,
    });
  }
  return calendars;
}

async function fetchCalendarEvents(calendarUrl, auth, httpsAgent, start, end) {
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const body = `<?xml version="1.0"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${fmt(start)}" end="${fmt(end)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

  const res = await axios.request({
    url: calendarUrl.replace(/\/?$/, '/'),
    method: 'REPORT',
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    auth,
    data: body,
    httpsAgent,
    timeout: 15000,
    validateStatus: () => true,
  });
  if (res.status >= 400) return [];

  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
  const parsed = parser.parse(res.data);
  const multistatus = parsed.multistatus;
  if (!multistatus) return [];

  const origin = new URL(calendarUrl).origin;
  const responses = asArray(multistatus.response);
  const events = [];
  for (const r of responses) {
    const icsText = propFromResponse(r, 'calendar-data');
    if (!icsText) continue;
    // 一個.ics資源通常對應一筆VEVENT，把它自己的網址帶著走，之後編輯/刪除才知道要打哪個URL
    const resourceUrl = origin + r.href;
    for (const ev of parseVEvents(String(icsText))) {
      events.push({ ...ev, url: resourceUrl });
    }
  }
  return events;
}

// 抓start~end範圍內、「所有」行事曆(自己的+分享的)的事件，合併後依開始時間排序
async function listEventsInRange(startIso, endIso) {
  const mail = settingsStore.get('mail');
  const auth = { username: mail.username, password: mail.password };
  const httpsAgent = httpsAgentFor(mail);
  const start = new Date(startIso);
  const end = new Date(endIso);

  const calendars = await discoverCalendars();
  const results = await Promise.all(
    calendars.map(async (cal, index) => {
      const color = colorForIndex(index);
      try {
        const events = await fetchCalendarEvents(cal.url, auth, httpsAgent, start, end);
        return { name: cal.name, color, events: events.map((e) => ({ ...e, calendarName: cal.name, color })), error: null };
      } catch (e) {
        // 單一個行事曆抓失敗不要讓整體掛掉，跳過就好，但把錯誤原因也帶回去，
        // 這樣前端才能分辨「這個行事曆本來就沒事件」跟「這個行事曆抓失敗」的差別
        return { name: cal.name, color, events: [], error: e.message };
      }
    })
  );

  const events = results.flatMap((r) => r.events);
  events.sort((a, b) => (a.start ? a.start.getTime() : 0) - (b.start ? b.start.getTime() : 0));

  // 連同「這次有找到的全部行事曆清單」+ 各自的事件數量/是否抓取失敗 一起回傳，
  // 這樣即使某個行事曆這段期間剛好沒有任何事件，前端也能清楚顯示「0筆」而不是誤以為漏掉了
  const calendarList = results.map((r) => ({
    name: r.name,
    color: r.color,
    eventCount: r.events.length,
    error: r.error,
  }));
  return { events, calendars: calendarList };
}

function formatIcsDate(date, allDay) {
  if (allDay) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function escapeIcsText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function buildIcs({ uid, summary, description, start, end, allDay }) {
  const startDate = new Date(start);
  const endDate = end ? new Date(end) : new Date(startDate.getTime() + (allDay ? 24 * 3600 * 1000 : 3600 * 1000));

  const dtstartLine = allDay
    ? `DTSTART;VALUE=DATE:${formatIcsDate(startDate, true)}`
    : `DTSTART:${formatIcsDate(startDate, false)}`;
  const dtendLine = allDay
    ? `DTEND;VALUE=DATE:${formatIcsDate(endDate, true)}`
    : `DTEND:${formatIcsDate(endDate, false)}`;
  const now = formatIcsDate(new Date(), false);

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//nsst-desktop//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `CREATED:${now}`,
    dtstartLine,
    dtendLine,
    `SUMMARY:${escapeIcsText(summary)}`,
    description ? `DESCRIPTION:${escapeIcsText(description)}` : null,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter(Boolean)
    .join('\r\n');
}

async function putIcs(url, ics, auth, httpsAgent, action) {
  const res = await axios.request({
    url,
    method: 'PUT',
    headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
    auth,
    data: ics,
    httpsAgent,
    timeout: 15000,
    validateStatus: () => true,
  });
  if (res.status === 403) {
    throw new Error(`${action}失敗：沒有寫入權限(可能是別人分享給你的唯讀行事曆)`);
  }
  if (res.status >= 400) {
    throw new Error(`${action}失敗(HTTP ${res.status})`);
  }
}

// 新增一個行事曆事件(CalDAV PUT)，預設寫進settings.mail.calendarUrl那個行事曆，
// 也可以傳calendarUrl指定寫到別的行事曆(要有寫入權限)
async function createEvent({ calendarUrl, summary, description, start, end, allDay }) {
  const mail = settingsStore.get('mail');
  if (!summary) {
    throw new Error('事件標題不可為空');
  }
  const auth = { username: mail.username, password: mail.password };
  const httpsAgent = httpsAgentFor(mail);

  // 沒有指定要寫進哪個行事曆時，自動找一個來寫，優先選「預設」，這樣同事不用手動設定自己專屬的行事曆路徑
  let targetUrl = calendarUrl;
  if (!targetUrl) {
    const calendars = await discoverCalendars();
    const preferred = calendars.find((c) => c.name === '預設') || calendars[0];
    targetUrl = preferred ? preferred.url : null;
  }
  if (!targetUrl) {
    throw new Error('沒有指定要寫入哪個行事曆，也找不到可用的預設行事曆');
  }

  const uid = 'desktop-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const ics = buildIcs({ uid, summary, description, start, end, allDay });
  const eventUrl = targetUrl.replace(/\/?$/, '/') + uid + '.ics';

  await putIcs(eventUrl, ics, auth, httpsAgent, '新增事件');
  return { uid, url: eventUrl };
}

// 更新既有事件：url是這筆事件自己的.ics網址(從listEventsInRange回傳的event.url)，uid要跟原本一樣
async function updateEvent({ url, uid, summary, description, start, end, allDay }) {
  const mail = settingsStore.get('mail');
  if (!url) throw new Error('缺少事件網址');
  if (!summary) throw new Error('事件標題不可為空');

  const auth = { username: mail.username, password: mail.password };
  const httpsAgent = httpsAgentFor(mail);
  const ics = buildIcs({ uid: uid || 'desktop-' + Date.now(), summary, description, start, end, allDay });

  await putIcs(url, ics, auth, httpsAgent, '更新事件');
  return { url };
}

async function deleteEvent({ url }) {
  const mail = settingsStore.get('mail');
  if (!url) throw new Error('缺少事件網址');

  const auth = { username: mail.username, password: mail.password };
  const httpsAgent = httpsAgentFor(mail);
  const res = await axios.request({
    url,
    method: 'DELETE',
    auth,
    httpsAgent,
    timeout: 15000,
    validateStatus: () => true,
  });
  if (res.status === 403) {
    throw new Error('刪除失敗：沒有寫入權限(可能是別人分享給你的唯讀行事曆)');
  }
  if (res.status >= 400 && res.status !== 404) {
    throw new Error(`刪除失敗(HTTP ${res.status})`);
  }
  return true;
}

module.exports = { discoverCalendars, listEventsInRange, createEvent, updateEvent, deleteEvent };
