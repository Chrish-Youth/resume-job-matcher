const statusBox = document.querySelector("#status");
const collectButton = document.querySelector("#collect");

function setStatus(message, type = "") {
  statusBox.className = `status ${type}`.trim();
  statusBox.querySelector("span").textContent = message;
}

document.querySelector("#openApp").addEventListener("click", () => {
  chrome.tabs.create({ url: "http://127.0.0.1:8765" });
});

collectButton.addEventListener("click", async () => {
  collectButton.disabled = true;
  collectButton.textContent = "正在读取当前页面…";
  setStatus("正在加载并识别职位卡片…", "working");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("没有找到当前页面。");
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "ZHIDE_COLLECT_JOBS",
      autoScroll: document.querySelector("#autoScroll").checked
    });
    if (!result?.ok) throw new Error(result?.error || "页面采集失败。");
    if (!result.jobs?.length) throw new Error("没有识别到岗位。请确认已打开职位搜索结果页，并刷新页面后重试。");
    setStatus(`已识别 ${result.jobs.length} 个岗位，正在发送给本地助手…`, "working");
    const response = await fetch("http://127.0.0.1:8765/api/extension/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "本地助手接收失败。");
    setStatus(`成功导入 ${data.count} 个${data.platform}岗位，助手正在自动匹配。`, "success");
    collectButton.textContent = "再次手动采集";
  } catch (error) {
    const message = String(error?.message || error).includes("Receiving end does not exist")
      ? "扩展刚安装后需要刷新招聘网页，再重新采集。"
      : error.message || "采集失败。";
    setStatus(message, "error");
    collectButton.textContent = "重试采集";
  } finally {
    collectButton.disabled = false;
  }
});
