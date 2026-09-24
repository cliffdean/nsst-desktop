// 有些終端機(例如VSCode內建終端)會帶入 ELECTRON_RUN_AS_NODE=1，
// 導致 `electron .` 被誤判成用純Node執行、require('electron')拿不到app/BrowserWindow。
// 用這個小腳本把該環境變數清掉後再真正啟動Electron，確保 npm start 在任何終端機都能正常開視窗。
const { spawn } = require('child_process');
const electronPath = require('electron');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code === null ? 1 : code));
