const { exec } = require('child_process');

// 只允許IP位址或一般主機名稱的字元，避免組指令字串時被注入奇怪的內容
const SAFE_HOST_PATTERN = /^[a-zA-Z0-9.\-:]+$/;

// 用本機(工程師電腦)對案場IP做連線測試，不是伺服器端的偵測，
// 所以結果反映的是「這台電腦現在到得了那個IP嗎」，通常要接公司VPN/內網才有意義
function pingHost(host) {
  return new Promise((resolve) => {
    const trimmed = (host || '').trim();
    if (!trimmed) {
      resolve({ host: trimmed, reachable: false, detail: '沒有設定IP位址' });
      return;
    }
    if (!SAFE_HOST_PATTERN.test(trimmed)) {
      resolve({ host: trimmed, reachable: false, detail: 'IP格式看起來不正確' });
      return;
    }
    exec(`ping -n 2 -w 1500 ${trimmed}`, { timeout: 8000 }, (error, stdout) => {
      const reachable = !error && /TTL=/i.test(stdout);
      const lines = stdout.trim().split(/\r?\n/);
      resolve({ host: trimmed, reachable, detail: lines.slice(-2).join(' ') });
    });
  });
}

module.exports = { pingHost };
