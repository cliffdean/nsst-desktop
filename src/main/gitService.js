const simpleGit = require('simple-git');
const { settingsStore } = require('./store');

// 依專案id找對應的本地git路徑，找不到就退回全域預設路徑
function resolveRepoPath(projectId) {
  const projectPaths = settingsStore.get('projectPaths') || {};
  const key = projectId === undefined || projectId === null ? '' : String(projectId);
  if (key && projectPaths[key]) {
    return projectPaths[key];
  }
  return settingsStore.get('gitRepoPath');
}

function repo(repoPath) {
  if (!repoPath) {
    throw new Error('這個專案尚未設定Git路徑，請先到工單詳情裡指定');
  }
  return simpleGit(repoPath);
}

// 抓「這次處理工單期間」的變更：已commit的(依起始時間)＋尚未commit的變更
async function collectChanges(sinceIso, projectId) {
  const repoPath = resolveRepoPath(projectId);
  const git = repo(repoPath);
  const status = await git.status();
  const diffStaged = await git.diff(['--staged']);
  const diffUnstaged = await git.diff();

  let log = [];
  if (sinceIso) {
    const logResult = await git.log(['--since', sinceIso]);
    log = logResult.all.map((c) => ({ hash: c.hash, message: c.message, date: c.date }));
  }

  const branch = await git.revparse(['--abbrev-ref', 'HEAD']);

  return {
    repoPath,
    branch: branch.trim(),
    changedFiles: status.files.map((f) => f.path),
    diffStaged,
    diffUnstaged,
    commitsSince: log,
  };
}

// 列出近期提交紀錄，給使用者勾選「工單其實已經commit過了，要用哪幾筆」
async function listCommits(projectId, limit) {
  const repoPath = resolveRepoPath(projectId);
  const git = repo(repoPath);
  const log = await git.log(['-n', String(limit || 30)]);
  return log.all.map((c) => ({
    hash: c.hash,
    shortHash: c.hash.slice(0, 7),
    date: c.date,
    author: c.author_name,
    message: c.message,
  }));
}

// 取選定commit(s)各自的完整訊息與diff，供AI生成回覆用(這些已經commit過了，不需要再產生新的commit訊息)
async function getCommitsDetail(projectId, hashes) {
  const repoPath = resolveRepoPath(projectId);
  const git = repo(repoPath);
  const commits = [];
  for (const hash of hashes) {
    const message = (await git.show(['-s', '--format=%B', hash])).trim();
    const diff = await git.show(['--format=', hash]);
    commits.push({ hash, message, diff: diff.slice(0, 8000) });
  }
  return { repoPath, commits };
}

const STATUS_LABELS = { A: '新增', M: '修改', D: '刪除', T: '型態變更' };

// 給畫面展開單筆commit用：完整訊息(含內文)＋涉及的檔案清單(狀態、新增/刪除行數)。
// 關掉rename偵測讓每個檔案各佔一行，路徑不引號跳脫才能正確顯示中文檔名
async function getCommitFiles(projectId, hash) {
  const git = repo(resolveRepoPath(projectId));
  const base = ['-c', 'core.quotePath=false', 'show', '--no-renames', '--format='];
  const message = (await git.show(['-s', '--format=%B', hash])).trim();
  const nameStatus = await git.raw([...base, '--name-status', hash]);
  const numstat = await git.raw([...base, '--numstat', hash]);

  const stats = {};
  numstat.split('\n').filter(Boolean).forEach((line) => {
    const [add, del, ...rest] = line.split('\t');
    stats[rest.join('\t')] = { additions: add === '-' ? null : Number(add), deletions: del === '-' ? null : Number(del) };
  });
  const files = nameStatus.split('\n').filter(Boolean).map((line) => {
    const [status, ...rest] = line.split('\t');
    const path = rest.join('\t');
    const s = stats[path] || {};
    return {
      path,
      status: status[0],
      statusLabel: STATUS_LABELS[status[0]] || status[0],
      additions: s.additions === undefined ? null : s.additions,
      deletions: s.deletions === undefined ? null : s.deletions,
    };
  });
  return { message, files };
}

// 單一檔案在該commit的異動內容，點開檔案才讀取，避免一次撈全部diff太慢
async function getCommitFileDiff(projectId, hash, filePath) {
  const git = repo(resolveRepoPath(projectId));
  // 檔案清單裡的路徑一律是「從git倉庫根目錄算起」，但專案設定的git路徑可能是倉庫底下的子資料夾，
  // pathspec預設又是相對目前資料夾，兩邊對不上就會撈到空白diff；用:(top)明確指定從根目錄算，:(literal)避免檔名含*?[被當萬用字元
  const diff = await git.raw(['-c', 'core.quotePath=false', 'show', '--no-renames', '--format=', hash, '--', `:(top,literal)${filePath}`]);
  const limit = 200000;
  return diff.length > limit ? diff.slice(0, limit) + '\n...(內容過長，已截斷)' : diff;
}

// 實際執行commit：把目前所有未commit的變更加進去，用AI產生(或使用者編輯過)的訊息送出，
// 呼叫前renderer那邊一定要先讓使用者看過訊息、明確按下確認按鈕才會走到這裡
async function commitAll(projectId, message) {
  const repoPath = resolveRepoPath(projectId);
  const git = repo(repoPath);
  await git.add(['-A']);
  const result = await git.commit(message);
  return { repoPath, commit: result.commit || null, summary: result.summary };
}

module.exports = { collectChanges, resolveRepoPath, listCommits, getCommitsDetail, getCommitFiles, getCommitFileDiff, commitAll };
