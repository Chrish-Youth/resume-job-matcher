// 定时雷达后台线程：每日按设置自动启动一轮采集，并轮询结果发桌面通知。
const API = "http://127.0.0.1:8765";
const SCHEDULE_ALARM = "zhide-scheduled-radar";
const SYNC_ALARM = "zhide-sync";

async function fetchJson(path, options) {
  try {
    const response = await fetch(API + path, options);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function nextRunAt(schedule) {
  const now = new Date();
  const next = new Date(
    now.getFullYear(), now.getMonth(), now.getDate(),
    Number(schedule.hour) || 9, Number(schedule.minute) || 0, 0, 0
  );
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

async function syncAlarm() {
  const schedule = await fetchJson("/api/radar/schedule");
  if (!schedule || !schedule.enabled) {
    await chrome.alarms.clear(SCHEDULE_ALARM);
    return;
  }
  const when = nextRunAt(schedule);
  const existing = await chrome.alarms.get(SCHEDULE_ALARM);
  if (!existing || existing.scheduledTime !== when) {
    await chrome.alarms.create(SCHEDULE_ALARM, { when, periodInMinutes: 24 * 60 });
  }
}

async function runScheduledRadar() {
  const active = await fetchJson("/api/radar/active");
  if (active?.radar?.active) return;
  const started = await fetchJson("/api/radar/scheduled/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  if (!started?.firstTask?.url) return;
  await chrome.tabs.create({ url: started.firstTask.url });
}

async function checkNotifications() {
  const last = await fetchJson("/api/radar/scheduled/last");
  if (!last?.summary?.runId) return;
  const stored = await chrome.storage.local.get("zhideLastNotifiedRun");
  if (stored.zhideLastNotifiedRun === last.summary.runId) return;
  await chrome.storage.local.set({ zhideLastNotifiedRun: last.summary.runId });
  const title = last.summary.newCount > 0
    ? `定时雷达完成：发现 ${last.summary.newCount} 个新岗位`
    : "定时雷达完成：本轮没有新岗位";
  chrome.notifications.create("zhide-scheduled-done", {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message: last.summary.message || "打开本地助手查看推荐结果。",
    priority: 1
  });
}

chrome.notifications.onClicked.addListener(() => {
  chrome.tabs.create({ url: `${API}/` });
});

chrome.runtime.onInstalled.addListener(() => { syncAlarm(); checkNotifications(); });
chrome.runtime.onStartup.addListener(() => { syncAlarm(); checkNotifications(); });

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === SCHEDULE_ALARM) {
    runScheduledRadar();
  } else if (alarm.name === SYNC_ALARM) {
    syncAlarm();
    checkNotifications();
  }
});

chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
syncAlarm();
checkNotifications();
