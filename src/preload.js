const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel) {
  return (...args) => ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: invoke('settings:get'),
    save: invoke('settings:save'),
    setProjectPath: invoke('settings:set-project-path'),
    getActiveHotkey: invoke('settings:get-active-hotkey'),
  },
  ticketMeta: {
    getType: invoke('ticket-meta:get-type'),
    setType: invoke('ticket-meta:set-type'),
  },
  projectStar: {
    list: invoke('project-star:list'),
    toggle: invoke('project-star:toggle'),
  },
  todo: {
    list: invoke('todo:list'),
    save: invoke('todo:save'),
    delete: invoke('todo:delete'),
  },
  notification: {
    show: invoke('notification:show'),
    onShow: (callback) => ipcRenderer.on('notification:push', (_event, data) => callback(data)),
    onUpdate: (callback) => ipcRenderer.on('notification:update', (_event, data) => callback(data)),
    close: invoke('notification:close-window'),
  },
  eip: {
    whoami: invoke('eip:whoami'),
    listEngineers: invoke('eip:list-engineers'),
    listProjects: invoke('eip:list-projects'),
    projectDeptTransfer: invoke('eip:project-dept-transfer'),
    projectPaymentUpdate: invoke('eip:project-payment-update'),
    projectPaymentPercentSave: invoke('eip:project-payment-percent-save'),
    login: invoke('eip:login'),
    searchInstallLists: invoke('eip:search-install-lists'),
    getInstallListByProject: invoke('eip:get-install-list-by-project'),
    getInstallList: invoke('eip:get-install-list'),
    listTickets: invoke('eip:list-tickets'),
    searchTickets: invoke('eip:search-tickets'),
    advancedSearchTickets: invoke('eip:advanced-search-tickets'),
    getTicketSearchOptions: invoke('eip:get-ticket-search-options'),
    getTicket: invoke('eip:get-ticket'),
    replyTicket: invoke('eip:reply-ticket'),
    transferTicket: invoke('eip:transfer-ticket'),
    uploadFile: invoke('eip:upload-file'),
    attachFile: invoke('eip:attach-file'),
  },
  timer: {
    get: invoke('timer:get'),
    getAll: invoke('timer:get-all'),
    start: invoke('timer:start'),
    pause: invoke('timer:pause'),
    stop: invoke('timer:stop'),
    reset: invoke('timer:reset'),
    setManual: invoke('timer:set-manual'),
    clearManual: invoke('timer:clear-manual'),
  },
  git: {
    collectChanges: invoke('git:collect-changes'),
    resolvePath: invoke('git:resolve-path'),
    listCommits: invoke('git:list-commits'),
    getCommitsDetail: invoke('git:get-commits-detail'),
    getCommitFiles: invoke('git:get-commit-files'),
    getCommitFileDiff: invoke('git:get-commit-file-diff'),
    commit: invoke('git:commit'),
  },
  llm: {
    generateReply: invoke('llm:generate-reply'),
    generateBatchReply: invoke('llm:generate-batch-reply'),
  },
  mail: {
    listRecent: invoke('mail:list-recent'),
    getMessage: invoke('mail:get-message'),
  },
  calendar: {
    listRange: invoke('calendar:list-range'),
    createEvent: invoke('calendar:create-event'),
    updateEvent: invoke('calendar:update-event'),
    deleteEvent: invoke('calendar:delete-event'),
  },
  clipboard: {
    copy: invoke('clipboard:copy'),
  },
  shell: {
    openExternal: invoke('shell:open-external'),
  },
  window: {
    openTicket: invoke('window:open-ticket'),
  },
  dialog: {
    pickFile: invoke('dialog:pick-file'),
  },
  site: {
    ping: invoke('site:ping'),
  },
});
