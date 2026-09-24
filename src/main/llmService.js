const OpenAI = require('openai');
const { settingsStore } = require('./store');

function client() {
  const llm = settingsStore.get('llm');
  return new OpenAI({ baseURL: llm.baseURL, apiKey: llm.apiKey || 'not-needed' });
}

function buildPrompt({ ticket, source, durationSeconds, userNote, templateText, typeLabel }) {
  const durationText = durationSeconds
    ? `${Math.floor(durationSeconds / 3600)}小時${Math.round((durationSeconds % 3600) / 60)}分鐘`
    : '未提供';

  // 兩種來源：commits=工單其實已經commit過了，選幾筆現有的commit來寫回覆(不需要再產生commit訊息);
  // uncommitted=目前工作區還沒commit的變更，這就是這張工單本次要做的內容，還需要生成commit訊息
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

  const typeBlock = typeLabel ? `\n【工單類型】${typeLabel}` : '';
  const templateBlock = templateText
    ? `\n【回覆範本參考(請依照這份的語氣與結構調整，但要填入本次實際處理內容，不要照抄範本裡的佔位文字)】\n${templateText}`
    : '';
  const noteBlock = userNote
    ? `\n【使用者補充說明／參考】\n${userNote}\n(請把以上補充說明的重點融合進工單回覆${needCommitMessage ? '與commit訊息' : ''}中)`
    : '';

  return `你是資深工程師，要幫忙把下面的工單需求跟這次實際修改的程式碼，整理成「工單回覆」${needCommitMessage ? '與「git commit訊息」' : ''}。
${typeBlock}
【工單編號】${ticket.id}
【工單標題】${ticket.name || ''} / ${ticket.summary || ''}
【工單需求說明】
${ticket.description || '(無)'}

【本次實際耗時】${durationText}
${sourceText}
${templateBlock}
${noteBlock}

請用以下JSON格式回覆，不要加其他說明文字、不要用markdown code block包起來：
{"reply": "工單回覆內容，條列式說明做了什麼、驗證方式，語氣正式、給客戶或PM看", "commitMessage": ${
    needCommitMessage ? '"一行的conventional commit訊息，例如 fix: xxx 或 feat: xxx，主題要圍繞這張工單"' : '""'
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

async function generateTicketReply({ ticket, source, durationSeconds, userNote, templateText, typeLabel }) {
  const llm = settingsStore.get('llm');
  const prompt = buildPrompt({ ticket, source, durationSeconds, userNote, templateText, typeLabel });

  const completion = await client().chat.completions.create({
    model: llm.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
  });

  const text = completion.choices[0].message.content || '';
  return parseResult(text);
}

module.exports = { generateTicketReply };
