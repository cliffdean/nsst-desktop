const { timersStore } = require('./store');

function getTimer(ticketId) {
  return timersStore.get(String(ticketId), { status: 'idle', segments: [] });
}

function getAllTimers() {
  return timersStore.store;
}

function saveTimer(ticketId, timer) {
  timersStore.set(String(ticketId), timer);
  return timer;
}

// 已完成區段的秒數總和(不含目前還在跑、尚未end的那一段)
function closedSecondsOf(segments) {
  let total = 0;
  for (const seg of segments) {
    if (seg.end) {
      total += Math.max(0, (new Date(seg.end).getTime() - new Date(seg.start).getTime()) / 1000);
    }
  }
  return Math.round(total);
}

// 給畫面顯示用：含目前正在跑的那一段(即時累加)，暫停中的秒數不算進去；
// 有手動設定時，手動用時是基準，之後再按開始計時的區段繼續往上加
function liveSecondsOf(timer) {
  let total = (timer.manual ? timer.manual.seconds : 0) + closedSecondsOf(timer.segments);
  if (timer.status === 'running') {
    const openSeg = timer.segments[timer.segments.length - 1];
    if (openSeg && !openSeg.end) {
      total += Math.max(0, (Date.now() - new Date(openSeg.start).getTime()) / 1000);
    }
  }
  return Math.round(total);
}

function start(ticketId) {
  const timer = getTimer(ticketId);
  if (timer.status === 'running') {
    return timer;
  }
  timer.segments.push({ start: new Date().toISOString(), end: null });
  timer.status = 'running';
  return saveTimer(ticketId, timer);
}

function pause(ticketId) {
  const timer = getTimer(ticketId);
  if (timer.status !== 'running') {
    return timer;
  }
  const openSeg = timer.segments[timer.segments.length - 1];
  if (openSeg && !openSeg.end) {
    openSeg.end = new Date().toISOString();
  }
  timer.status = 'paused';
  return saveTimer(ticketId, timer);
}

// 停止：關閉目前區段並回傳統計摘要，供送出工單回覆使用
// 有手動設定時：用時=手動用時+之後計時的區段，開始時間取手動的開始，結束時間取最後一段計時的結束(沒有再計時就是手動的結束)
function stop(ticketId) {
  const timer = getTimer(ticketId);
  if (timer.status === 'running') {
    const openSeg = timer.segments[timer.segments.length - 1];
    if (openSeg && !openSeg.end) {
      openSeg.end = new Date().toISOString();
    }
  }
  timer.status = 'stopped';
  saveTimer(ticketId, timer);

  const manual = timer.manual;
  const segs = timer.segments;
  const totalSeconds = (manual ? manual.seconds : 0) + closedSecondsOf(segs);
  const firstStart = manual ? manual.start : segs.length ? segs[0].start : null;
  const lastEnd = segs.length ? segs[segs.length - 1].end : manual ? manual.end : null;

  return { segments: timer.segments, totalSeconds, firstStart, lastEnd };
}

// 補開單/事後補登用：直接指定起訖時間與實際用時(用時可以比 結束-開始 短，中間可能有休息或中斷)
function setManual(ticketId, { start, end, seconds }) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new Error('起始/結束時間格式不正確');
  if (endMs <= startMs) throw new Error('結束時間必須晚於起始時間');
  const secs = Math.round(Number(seconds));
  if (!Number.isFinite(secs) || secs <= 0) throw new Error('用時必須大於0');
  if (secs > Math.round((endMs - startMs) / 1000)) throw new Error('用時不能超過「結束時間 − 起始時間」');
  // 手動用時取代之前所有計時記錄；原本正在計時的話不中斷，從現在開一段新的繼續往上累加
  const wasRunning = getTimer(ticketId).status === 'running';
  const timer = {
    status: wasRunning ? 'running' : 'stopped',
    segments: wasRunning ? [{ start: new Date().toISOString(), end: null }] : [],
    manual: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), seconds: secs },
  };
  return saveTimer(ticketId, timer);
}

// 只拿掉手動設定的基準用時，之後按開始累計的區段與目前計時狀態保留
function clearManual(ticketId) {
  const timer = getTimer(ticketId);
  delete timer.manual;
  if (!timer.segments.length && timer.status !== 'running') {
    timersStore.delete(String(ticketId));
    return getTimer(ticketId);
  }
  return saveTimer(ticketId, timer);
}

function reset(ticketId) {
  timersStore.delete(String(ticketId));
}

module.exports = { getTimer, getAllTimers, start, pause, stop, reset, setManual, clearManual, liveSecondsOf, closedSecondsOf };
