const OpenAI = require('openai');
const { settingsStore } = require('./store');

function client() {
  const llm = settingsStore.get('llm');
  return new OpenAI({ baseURL: llm.baseURL, apiKey: llm.apiKey || 'not-needed' });
}

// LLM不知道「今天」是幾號，範本裡的送QC日期(如2026/06/11)只是範例格式，
// 一定要把實際日期傳進prompt，不然AI只能照抄範本日期或留空給使用者自己填
function formatToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

function formatDuration(durationSeconds) {
  return durationSeconds
    ? `${Math.floor(durationSeconds / 3600)}小時${Math.round((durationSeconds % 3600) / 60)}分鐘`
    : '未提供';
}

// 兩種來源：commits=工單其實已經commit過了，選幾筆現有的commit來寫回覆(不需要再產生commit訊息);
// uncommitted=目前工作區還沒commit的變更，這就是這次要做的內容，還需要生成commit訊息
// 單張工單與批次工單共用同一套來源說明邏輯，只有前面包的工單資訊區塊不同
function buildSourceBlock(source) {
  const needCommitMessage = source.mode !== 'commits';
  let sourceText;
  if (source.mode === 'commits') {
    sourceText =
      `【本次參考的git提交紀錄(已經commit過了，不需要再產生commit訊息，commitMessage請回空字串)】\n` +
      source.commits
        .map((c, i) => `--- 提交${i + 1} (${c.hash.slice(0, 7)}) ---\n訊息：${c.message}\ndiff(節錄)：\n${(c.diff || '').slice(0, 4000)}`)
        .join('\n\n');
  } else {
    const diffText = [source.diffStaged, source.diffUnstaged].filter(Boolean).join('\n').slice(0, 8000);
    const commitsText = (source.commitsSince || []).map((c) => `- ${c.message}`).join('\n');
    sourceText = `【目前git分支】${source.branch}
【變更的檔案】
${(source.changedFiles || []).join('\n') || '(無未commit變更)'}

【期間內已commit的訊息】
${commitsText || '(無)'}

【尚未commit的程式碼diff(節錄)】
${diffText || '(無)'}`;
  }
  return { sourceText, needCommitMessage };
}

// 範本裡「送QC/品保測試」這類日期只是範例格式，一律要求AI換成今天的實際日期，不要照抄或留占位文字給使用者填
function buildTemplateBlock(templateText, todayDate, extraNote) {
  if (!templateText) return '';
  return (
    `\n【回覆範本參考(請依照這份的語氣與結構調整，但要填入本次實際處理內容，不要照抄範本裡的佔位文字；` +
    `範本裡如果有「送QC」「品保測試」之類的日期，那只是範例格式，一律換成下面【今天日期】給的實際日期，` +
    `直接寫成完整的一行如「${todayDate} 送QC」，不要留下「(填寫送QC的日期)」這種要使用者自己填的提示文字${extraNote || ''})】\n${templateText}`
  );
}

function buildPrompt({ ticket, source, durationSeconds, userNote, templateText, typeLabel, todayDate }) {
  const { sourceText, needCommitMessage } = buildSourceBlock(source);

  const typeBlock = typeLabel ? `\n【工單類型】${typeLabel}` : '';
  const templateBlock = buildTemplateBlock(templateText, todayDate);
  const noteBlock = userNote
    ? `\n【使用者補充說明／參考】\n${userNote}\n(請把以上補充說明的重點融合進工單回覆${needCommitMessage ? '與commit訊息' : ''}中)`
    : '';

  return `你是資深工程師，要幫忙把下面的工單需求跟這次實際修改的程式碼，整理成「工單回覆」${needCommitMessage ? '與「git commit訊息」' : ''}。
${typeBlock}
【工單編號】${ticket.id}
【工單標題】${ticket.name || ''} / ${ticket.summary || ''}
【工單需求說明】
${ticket.description || '(無)'}

【本次實際耗時】${formatDuration(durationSeconds)}
【今天日期】${todayDate}
${sourceText}
${templateBlock}
${noteBlock}

請用以下JSON格式回覆，不要加其他說明文字、不要用markdown code block包起來：
{"reply": "工單回覆內容，條列式說明做了什麼、驗證方式，語氣正式、給客戶或PM看", "commitMessage": ${
    needCommitMessage ? '"一行的conventional commit訊息，例如 fix: xxx 或 feat: xxx，主題要圍繞這張工單"' : '""'
  }}`;
}

// 批次提交是「同一份回覆內容」分別存到選取的每一張工單，所以這裡請AI產生一份共用回覆，
// 但要求內容裡分段點名每一張工單各自對應到什麼，不要含糊帶過或漏掉任何一張
function buildTicketsBlock(tickets) {
  return tickets
    .map(
      (t, i) =>
        `--- 工單${i + 1} #${t.id} ---\n標題：${t.name || ''} / ${t.summary || ''}\n需求說明：\n${t.description || '(無)'}`
    )
    .join('\n\n');
}

function buildBatchPrompt({ tickets, source, durationSeconds, userNote, templateText, typeLabel, todayDate }) {
  const { sourceText, needCommitMessage } = buildSourceBlock(source);

  const typeBlock = typeLabel ? `\n【回覆範本類型】${typeLabel}` : '';
  const templateBlock = buildTemplateBlock(
    templateText,
    todayDate,
    '；這份範本結構請套用在整份共用回覆上，不用每張工單各自重複一次範本的所有段落'
  );
  const noteBlock = userNote
    ? `\n【使用者補充說明／參考】\n${userNote}\n(請把以上補充說明的重點融合進工單回覆${needCommitMessage ? '與commit訊息' : ''}中)`
    : '';

  return `你是資深工程師，這次的git異動同時對應下面好幾張工單，批次提交時「同一份回覆內容」會分別存到每一張工單，
請整理成一份「共用工單回覆」，並在內容中用工單編號分段清楚點名各自對應做了什麼、如何驗證，不要漏掉任何一張工單。
${typeBlock}
【本次涉及的工單】
${buildTicketsBlock(tickets)}

【本次實際耗時(整批合計)】${formatDuration(durationSeconds)}
【今天日期】${todayDate}
${sourceText}
${templateBlock}
${noteBlock}

請用以下JSON格式回覆，不要加其他說明文字、不要用markdown code block包起來：
{"reply": "共用工單回覆內容，需用工單編號分段列出每一張工單各自做了什麼、驗證方式，語氣正式、給客戶或PM看", "commitMessage": ${
    needCommitMessage ? '"一行的conventional commit訊息，例如 fix: xxx 或 feat: xxx，主題要能涵蓋這幾張工單的共同異動"' : '""'
  }}`;
}

function parseResult(text) {
  const trimmed = text.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(trimmed);
    return {
      reply: parsed.reply || trimmed,
      commitMessage: parsed.commitMessage || '',
    };
  } catch (e) {
    // LLM沒有照格式回，就整段當作回覆內容，commit訊息留空讓使用者自己補
    return { reply: trimmed, commitMessage: '' };
  }
}

async function callLlm(prompt) {
  const llm = settingsStore.get('llm');
  const completion = await client().chat.completions.create({
    model: llm.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
  });
  return completion.choices[0].message.content || '';
}

async function generateTicketReply({ ticket, source, durationSeconds, userNote, templateText, typeLabel }) {
  const prompt = buildPrompt({ ticket, source, durationSeconds, userNote, templateText, typeLabel, todayDate: formatToday() });
  const text = await callLlm(prompt);
  return parseResult(text);
}

// 批次提交專用：tickets是這次一起選取、要套用同一份回覆的工單陣列(同一個專案)
async function generateBatchReply({ tickets, source, durationSeconds, userNote, templateText, typeLabel }) {
  const prompt = buildBatchPrompt({ tickets, source, durationSeconds, userNote, templateText, typeLabel, todayDate: formatToday() });
  const text = await callLlm(prompt);
  return parseResult(text);
}

module.exports = { generateTicketReply, generateBatchReply };
