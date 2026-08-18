// 定时雷达后台线程：每日按设置启动采集；服务离线时保留待办，恢复后自动补跑。
const API = "http://127.0.0.1:8765";
const SCHEDULE_ALARM = "zhide-scheduled-radar";
const SYNC_ALARM = "zhide-sync";
const PENDING_KEY = "zhidePendingScheduledRunAt";
const FAILURE_NOTICE_KEY = "zhideLastFailureNoticeAt";

async function requestJson(path, options) {
  const response = await fetch(API + path, options);
  let data = null;
  try { data = await response.json(); } catch { /* 使用下面的通用错误 */ }
  if (!response.ok) throw new Error(data?.error || `本地助手返回 ${response.status}`);
  return data;
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
  try {
    const schedule = await requestJson("/api/radar/schedule");
    if (!schedule.enabled) {
      await chrome.alarms.clear(SCHEDULE_ALARM);
      await chrome.storage.local.remove(PENDING_KEY);
      return;
    }
    const when = nextRunAt(schedule);
    const existing = await chrome.alarms.get(SCHEDULE_ALARM);
    if (!existing || Math.abs(existing.scheduledTime - when) > 1000) {
      await chrome.alarms.create(SCHEDULE_ALARM, { when, periodInMinutes: 24 * 60 });
    }
  } catch {
    // 本地服务暂时不可用时保留既有闹钟，避免静默取消用户的定时设置。
  }
}

async function notifyRunFailure(message) {
  const stored = await chrome.storage.local.get(FAILURE_NOTICE_KEY);
  const now = Date.now();
  if (now - Number(stored[FAILURE_NOTICE_KEY] || 0) < 30 * 60 * 1000) return;
  await chrome.storage.local.set({ [FAILURE_NOTICE_KEY]: now });
  chrome.notifications.create("zhide-scheduled-failed", {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "定时雷达暂未运行",
    message: message || "请启动本地助手。恢复连接后扩展会自动补跑。",
    priority: 1
  });
}

async function runScheduledRadar() {
  try {
    const active = await requestJson("/api/radar/active");
    if (active?.radar?.active) return false;
    const started = await requestJson("/api/radar/scheduled/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    if (!started?.firstTask?.url) throw new Error("没有生成可执行的搜索任务");
    await chrome.tabs.create({ url: started.firstTask.url });
    await chrome.storage.local.remove([PENDING_KEY, FAILURE_NOTICE_KEY]);
    return true;
  } catch (error) {
    await notifyRunFailure(`本地助手未连接或启动失败：${error.message || "稍后自动重试"}`);
    return false;
  }
}

async function runOrQueueScheduledRadar() {
  const stored = await chrome.storage.local.get(PENDING_KEY);
  if (!stored[PENDING_KEY]) await chrome.storage.local.set({ [PENDING_KEY]: Date.now() });
  await runScheduledRadar();
}

async function retryPendingRadar() {
  const stored = await chrome.storage.local.get(PENDING_KEY);
  const pendingAt = Number(stored[PENDING_KEY] || 0);
  if (!pendingAt) return;
  if (Date.now() - pendingAt > 12 * 60 * 60 * 1000) {
    await chrome.storage.local.remove(PENDING_KEY);
    await notifyRunFailure("本轮自动任务已等待超过 12 小时，请打开助手手动运行一次。");
    return;
  }
  await runScheduledRadar();
}

async function checkNotifications() {
  try {
    const last = await requestJson("/api/radar/scheduled/last");
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
  } catch { /* 服务离线时由待办重试流程处理 */ }
}

chrome.notifications.onClicked.addListener(() => {
  chrome.tabs.create({ url: `${API}/` });
});

chrome.runtime.onInstalled.addListener(() => { syncAlarm(); checkNotifications(); retryPendingRadar(); });
chrome.runtime.onStartup.addListener(() => { syncAlarm(); checkNotifications(); retryPendingRadar(); });

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === SCHEDULE_ALARM) {
    runOrQueueScheduledRadar();
  } else if (alarm.name === SYNC_ALARM) {
    syncAlarm();
    checkNotifications();
    retryPendingRadar();
  }
});

chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
syncAlarm();
checkNotifications();
retryPendingRadar();
