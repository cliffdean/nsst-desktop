const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { settingsStore } = require('./store');

function buildClient() {
  const mail = settingsStore.get('mail');
  if (!mail.username || !mail.password || !mail.imapHost) {
    throw new Error('尚未設定信箱帳號/密碼/IMAP主機，請先到設定裡填寫');
  }
  return new ImapFlow({
    host: mail.imapHost,
    port: mail.imapPort || 993,
    secure: mail.imapSecure !== false,
    auth: { user: mail.username, pass: mail.password },
    tls: mail.imapAllowInsecureTLS ? { rejectUnauthorized: false } : undefined,
    logger: false,
  });
}

// 抓收件匣最新N封信(含未讀狀態)，只拿信封資訊，不下載內文，避免大附件拖慢速度
async function listRecent(limit) {
  const max = limit || 20;
  const client = buildClient();
  await client.connect();

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = client.mailbox.exists;
      if (total === 0) {
        return { unseenCount: 0, messages: [] };
      }
      const from = Math.max(1, total - max + 1);
      const messages = [];
      for await (const msg of client.fetch(`${from}:${total}`, { envelope: true, flags: true })) {
        messages.push({
          uid: msg.uid,
          subject: (msg.envelope && msg.envelope.subject) || '(無主旨)',
          from: msg.envelope && msg.envelope.from && msg.envelope.from[0]
            ? (msg.envelope.from[0].name || msg.envelope.from[0].address)
            : '(未知寄件人)',
          date: msg.envelope ? msg.envelope.date : null,
          seen: msg.flags ? msg.flags.has('\\Seen') : true,
        });
      }
      messages.reverse(); // 最新的排最前面

      const unseenCount = messages.filter((m) => !m.seen).length;
      return { unseenCount, messages };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

// 點開一封信看完整內容，並回寫伺服器標記已讀(跟一般信箱軟體行為一致)
// imapflow抓內文用的是BODY.PEEK，本身不會改已讀狀態，所以要另外加\Seen旗標
async function getMessage(uid) {
  const client = buildClient();
  await client.connect();

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) {
        throw new Error('找不到這封信，可能已被刪除或移動');
      }
      const parsed = await simpleParser(msg.source);
      // 標記已讀失敗(例如信箱唯讀)不影響看信，只是角標不會消，記log就好
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch((err) => {
        console.warn('標記已讀失敗：', err.message);
      });
      const attachments = pickAttachments(parsed);
      // 附件內容留在main process，存檔時直接拿，不用整封信再下載一次；前端只拿檔名/大小
      lastAttachments = { uid: Number(uid), list: attachments };
      return {
        subject: parsed.subject || '(無主旨)',
        from: parsed.from ? parsed.from.text : '(未知寄件人)',
        date: parsed.date || null,
        html: parsed.html || null, // 前端會用sandbox iframe呈現，不會直接insert到頁面裡執行script
        text: parsed.text || '',
        attachments: attachments.map((a, index) => ({
          index,
          filename: a.filename,
          contentType: a.contentType,
          size: a.size,
        })),
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

// 內文裡引用的內嵌圖片(cid)mailparser已經轉成data URI顯示在內文了，不再列成附件
function pickAttachments(parsed) {
  return (parsed.attachments || [])
    .filter((a) => !(parsed.html && a.related))
    .map((a, i) => ({
      filename: a.filename || `附件${i + 1}`,
      contentType: a.contentType || 'application/octet-stream',
      size: a.size || (a.content ? a.content.length : 0),
      content: a.content,
    }));
}

let lastAttachments = { uid: null, list: [] };

// 取得某封信的某個附件內容；通常就是剛點開的那封，快取沒有時才重新抓信
async function getAttachment(uid, index) {
  if (lastAttachments.uid !== Number(uid)) {
    const client = buildClient();
    await client.connect();
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) throw new Error('找不到這封信，可能已被刪除或移動');
        lastAttachments = { uid: Number(uid), list: pickAttachments(await simpleParser(msg.source)) };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }
  const att = lastAttachments.list[index];
  if (!att) throw new Error('找不到這個附件');
  return att;
}

module.exports = { listRecent, getMessage, getAttachment };
