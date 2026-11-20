const state = {
  profile: null, jobs: [], visibleJobs: [], activeJob: null, tone: "professional",
  engine: null, providerStatus: null, jobSource: "示例岗位",
  extensionSequence: 0, extensionImporting: false, extensionPlatforms: [], pendingCapturePlatform: null,
  captureSessionId: createSessionId(), modalReturnFocus: null, sourceMeta: null,
  radar: null, radarFinalizing: false, resultView: "all", batchGreetings: [], blockedNotified: false,
  lastScheduledSeen: null, feedback: {}, pendingFeedbackJob: null,
  radarChecking: false, radarResultsLoaded: ""
};
const WORKSPACE_STORAGE_KEY = "zhideWorkspaceV2";
const PROVIDER_STORAGE_KEY = "zhideProviderV1";
let pendingRadarWindow = null;

const $ = (selector) => document.querySelector(selector);
const els = {
  uploadSection: $("#uploadSection"), dropZone: $("#dropZone"), fileInput: $("#fileInput"),
  chooseFile: $("#chooseFile"), loadingPanel: $("#loadingPanel"), loadingText: $("#loadingText"),
  workspace: $("#workspace"), jobList: $("#jobList"), emptyState: $("#emptyState"),
  searchInput: $("#searchInput"), sortSelect: $("#sortSelect"), modal: $("#greetingModal"),
  greetingText: $("#greetingText"), charCount: $("#charCount"), toast: $("#toast"),
  providerSelect: $("#providerSelect"), enginePill: $("#enginePill"), bossModal: $("#bossModal"), zhaopinModal: $("#zhaopinModal"),
  extensionModal: $("#extensionModal"), captureStatus: $("#captureStatus"),
  locationFilter: $("#locationFilter"), minSalaryPreference: $("#minSalaryPreference"),
  educationFilter: $("#educationFilter"), experienceFilter: $("#experienceFilter"), freshFilter: $("#freshFilter"),
  targetCity: $("#targetCity"), jobKeyword: $("#jobKeyword"), radarPanel: $("#radarPanel"),
  startRadar: $("#startRadar"), stopRadar: $("#stopRadar"), resumeRadar: $("#resumeRadar"), resultTabs: $("#resultTabs"),
  autoStartRadar: $("#autoStartRadar"), batchGreeting: $("#batchGreeting"),
  batchGreetingModal: $("#batchGreetingModal"), batchGreetingList: $("#batchGreetingList"),
  batchToneTabs: $("#batchToneTabs"), copyAllGreetings: $("#copyAllGreetings"),
  downloadGreetings: $("#downloadGreetings"), batchGreetingModalClose: $("#batchGreetingModalClose"),
  scheduleEnabled: $("#scheduleEnabled"), scheduleTime: $("#scheduleTime"), saveSchedule: $("#saveSchedule"),
  scheduleState: $("#scheduleState"), scheduledResult: $("#scheduledResult"),
  scheduledResultTitle: $("#scheduledResultTitle"), scheduledResultText: $("#scheduledResultText"),
  loadScheduledResults: $("#loadScheduledResults"), feedbackModal: $("#feedbackModal")
};

bootstrap();

async function bootstrap() {
  await Promise.all([loadProviderStatus(), loadFeedback()]);
  restoreWorkspace();
  loadScheduleConfig();
  checkScheduledSummary();
}

function createSessionId() {
  if (globalThis.crypto?.randomUUID) return `capture_${crypto.randomUUID().replaceAll("-", "")}`;
  return `capture_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
}

function currentPreferences() {
  return {
    city: els.targetCity.value || "全国",
    keyword: els.jobKeyword.value.trim(),
    minSalaryK: Number(els.minSalaryPreference.value || 0),
    freshOnly: els.freshFilter.checked
  };
}

function profileForRequest() {
  return {
    ...state.profile,
    preferences: currentPreferences(),
    feedback: Object.values(state.feedback).slice(-80)
  };
}

async function loadFeedback() {
  try {
    const response = await fetch("/api/feedback", { cache: "no-store" });
    const data = await response.json();
    if (response.ok && data.feedback && typeof data.feedback === "object") state.feedback = data.feedback;
  } catch { /* 本地服务刚启动时稍后仍可保存反馈 */ }
}

function saveWorkspace() {
  if (!state.profile) return;
  try {
    const profile = { ...state.profile };
    delete profile.preview;
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({
      version: 3,
      savedAt: Date.now(),
      profile,
      jobs: state.jobs.slice(0, 300),
      engine: state.engine,
      jobSource: state.jobSource,
      sourceMeta: state.sourceMeta,
      extensionPlatforms: state.extensionPlatforms,
      captureSessionId: state.captureSessionId,
      radar: state.radar,
      radarResultsLoaded: state.radarResultsLoaded,
      resultView: state.resultView,
      preferences: currentPreferences(),
      filters: {
        location: els.locationFilter.value,
        education: els.educationFilter.value,
        experience: els.experienceFilter.value,
        search: els.searchInput.value,
        sort: els.sortSelect.value
      }
    }));
    $("#clearWorkspace").classList.remove("hidden");
  } catch { /* 存储空间不足时仍允许继续使用当前会话 */ }
}

function restoreWorkspace() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY) || "null"); }
  catch { saved = null; }
  if (!saved || ![2, 3].includes(saved.version) || !saved.profile || !Array.isArray(saved.jobs)) return;
  state.profile = saved.profile;
  state.jobs = saved.jobs;
  state.visibleJobs = saved.jobs;
  state.engine = saved.engine || null;
  state.jobSource = saved.jobSource || "已保存岗位";
  state.sourceMeta = saved.sourceMeta || null;
  state.extensionPlatforms = Array.isArray(saved.extensionPlatforms) ? saved.extensionPlatforms : [];
  if (saved.captureSessionId) state.captureSessionId = saved.captureSessionId;
  state.radar = saved.radar || null;
  state.radarResultsLoaded = saved.radarResultsLoaded || "";
  state.resultView = ["all", "strong", "transferable", "saved", "new"].includes(saved.resultView) ? saved.resultView : "all";
  renderProfile();
  setSearchPreferences(saved.preferences);
  refreshFilterOptions(true);
  const filters = saved.filters || {};
  if ([...els.locationFilter.options].some(option => option.value === filters.location)) els.locationFilter.value = filters.location;
  if ([...els.educationFilter.options].some(option => option.value === filters.education)) els.educationFilter.value = filters.education;
  if ([...els.experienceFilter.options].some(option => option.value === filters.experience)) els.experienceFilter.value = filters.experience;
  els.searchInput.value = filters.search || "";
  els.sortSelect.value = filters.sort === "latest" ? "latest" : "score";
  if (state.engine) applyEngine(state.engine, false);
  filterAndRender();
  renderRadar();
  updateResultTabs();
  showWorkspace();
  updateSourceNotice();
  $("#clearWorkspace").classList.remove("hidden");
  showToast("已恢复上次保存在本机的求职工作区");
}

async function clearWorkspace() {
  if (!window.confirm("确定清除本机保存的简历画像、岗位、定时雷达和反馈记录吗？")) return;
  try {
    const response = await fetch("/api/local-data/clear", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "清理失败");
    localStorage.removeItem(WORKSPACE_STORAGE_KEY);
    window.location.reload();
  } catch (error) {
    showToast(error.message);
  }
}

$("#clearWorkspace").addEventListener("click", clearWorkspace);

els.chooseFile.addEventListener("click", () => els.fileInput.click());
$("#tryDemo").addEventListener("click", loadDemo);
$("#replaceFile").addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => els.fileInput.files[0] && uploadResume(els.fileInput.files[0]));

["dragenter", "dragover"].forEach(type => els.dropZone.addEventListener(type, event => {
  event.preventDefault(); els.dropZone.classList.add("dragging");
}));
["dragleave", "drop"].forEach(type => els.dropZone.addEventListener(type, event => {
  event.preventDefault(); els.dropZone.classList.remove("dragging");
}));
els.dropZone.addEventListener("drop", event => event.dataTransfer.files[0] && uploadResume(event.dataTransfer.files[0]));

async function uploadResume(file) {
  const valid = ["docx", "pdf", "txt"].includes(file.name.split(".").pop().toLowerCase());
  if (!valid) return showToast("请上传 DOCX、PDF 或 TXT 文件");
  if (file.size > 8 * 1024 * 1024) return showToast("文件不能超过 8MB");

  closePendingRadarWindow();
  if (els.autoStartRadar.checked) pendingRadarWindow = window.open("about:blank", "_blank");
  els.uploadSection.classList.add("hidden");
  els.workspace.classList.add("hidden");
  els.loadingPanel.classList.remove("hidden");
  const isPdf = file.name.toLowerCase().endsWith(".pdf");
  const messages = isPdf
    ? ["正在解析 PDF 页面文字…", "提取教育与经历信息…", "识别技能并计算岗位匹配度…"]
    : ["提取教育与经历信息…", "识别技能与求职方向…", "正在计算岗位匹配度…"];
  let index = 0;
  const timer = setInterval(() => { els.loadingText.textContent = messages[++index % messages.length]; }, 850);

  try {
    const form = new FormData(); form.append("resume", file);
    const response = await fetchWithTimeout(`/api/analyze?provider=${encodeURIComponent(currentProvider())}`, { method: "POST", body: form }, 90000);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "简历解析失败");
    state.profile = data.profile; state.jobs = data.jobs; state.visibleJobs = data.jobs; state.jobSource = "示例岗位"; state.extensionPlatforms = []; state.sourceMeta = null;
    state.captureSessionId = createSessionId(); state.extensionSequence = 0; state.radar = null; state.resultView = "all";
    applyEngine(data.engine);
    renderProfile(); setSearchPreferences(); refreshFilterOptions(true); filterAndRender();
    els.loadingPanel.classList.add("hidden");
    showWorkspace(); updateSourceNotice(); saveWorkspace();
    if (pendingRadarWindow) {
      const windowRef = pendingRadarWindow;
      pendingRadarWindow = null;
      startRadar({ windowRef });
    }
  } catch (error) {
    closePendingRadarWindow();
    els.loadingPanel.classList.add("hidden"); els.uploadSection.classList.remove("hidden");
    showToast(error.message);
  } finally { clearInterval(timer); els.fileInput.value = ""; }
}

async function loadDemo() {
  closePendingRadarWindow();
  if (els.autoStartRadar.checked) pendingRadarWindow = window.open("about:blank", "_blank");
  els.uploadSection.classList.add("hidden");
  els.loadingPanel.classList.remove("hidden");
  els.loadingText.textContent = "正在准备示例求职画像…";
  try {
    const response = await fetchWithTimeout(`/api/demo?provider=${encodeURIComponent(currentProvider())}`, { method: "POST" }, 90000);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "示例加载失败");
    state.profile = data.profile; state.jobs = data.jobs; state.visibleJobs = data.jobs; state.jobSource = "示例岗位"; state.extensionPlatforms = []; state.sourceMeta = null;
    state.captureSessionId = createSessionId(); state.extensionSequence = 0; state.radar = null; state.resultView = "all";
    applyEngine(data.engine);
    renderProfile(); setSearchPreferences(); refreshFilterOptions(true); filterAndRender();
    els.loadingPanel.classList.add("hidden");
    showWorkspace(); updateSourceNotice(); saveWorkspace();
    if (pendingRadarWindow) {
      const windowRef = pendingRadarWindow;
      pendingRadarWindow = null;
      startRadar({ windowRef });
    }
  } catch (error) {
    closePendingRadarWindow();
    els.loadingPanel.classList.add("hidden"); els.uploadSection.classList.remove("hidden");
    showToast(error.message);
  }
}

function closePendingRadarWindow() {
  if (pendingRadarWindow && !pendingRadarWindow.closed) pendingRadarWindow.close();
  pendingRadarWindow = null;
}

function showWorkspace() {
  els.uploadSection.classList.add("hidden");
  els.loadingPanel.classList.add("hidden");
  els.workspace.classList.remove("hidden");
  $("#hero").classList.add("hidden");
  document.body.classList.add("workspace-mode");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
}

function renderProfile() {
  const p = state.profile;
  $("#avatar").textContent = p.name.slice(0, 1);
  $("#profileName").textContent = p.name;
  $("#profileTarget").textContent = p.target;
  $("#profileFile").textContent = p.filename;
  $("#fileType").textContent = (p.filename.split(".").pop() || "DOC").toUpperCase().slice(0, 4);
  $("#profileEducation").textContent = p.education;
  $("#experienceCount").textContent = p.experienceCount;
  $("#skillCount").textContent = p.skills.length;
  $("#skillList").innerHTML = p.skills.length
    ? p.skills.map(skill => `<span>${escapeHtml(skill)}</span>`).join("")
    : "<span>待补充</span>";
  $("#profileTip").textContent = p.highlights[0] || "已根据简历信息完成岗位匹配。";
}

function setSearchPreferences(savedPreferences = null) {
  const rawCity = String(savedPreferences?.city || state.profile?.city || "全国").replace(/市$/, "");
  const city = rawCity && rawCity !== "待确认" ? rawCity : "全国";
  if (![...els.targetCity.options].some(option => option.value === city)) els.targetCity.add(new Option(city, city));
  els.targetCity.value = city;
  const keyword = String(savedPreferences?.keyword || state.profile?.searchKeyword || state.profile?.target || "")
    .replace(/相关岗位|方向|求职/g, "").replace(/\s*\/\s*/g, " ").trim();
  els.jobKeyword.value = keyword.slice(0, 30);
  els.minSalaryPreference.value = String(savedPreferences?.minSalaryK || 0);
  els.freshFilter.checked = Boolean(savedPreferences?.freshOnly);
  syncManualBossUrl();
}

function feedbackForJob(job) {
  const title = String(job.title || "").trim().toLowerCase();
  const company = String(job.company || "").trim().toLowerCase();
  const location = String(job.location || "").trim().toLowerCase();
  return Object.values(state.feedback).find(item =>
    String(item.title || "").trim().toLowerCase() === title &&
    String(item.company || "").trim().toLowerCase() === company &&
    String(item.location || "").trim().toLowerCase() === location
  ) || null;
}

function filterAndRender() {
  const keyword = els.searchInput.value.trim().toLowerCase();
  const targetCity = els.targetCity.value;
  const location = els.locationFilter.value;
  const minSalary = Number(els.minSalaryPreference.value || 0);
  const education = els.educationFilter.value;
  const experience = els.experienceFilter.value;
  let jobs = state.jobs.filter(job => {
    if (feedbackForJob(job)?.status === "dismissed") return false;
    if (!`${job.title}${job.company}${job.location}`.toLowerCase().includes(keyword)) return false;
    if (targetCity !== "全国" && jobCity(job) !== targetCity) return false;
    if (location !== "all" && jobCity(job) !== location) return false;
    const salary = salaryMidpointK(job.salary);
    if (minSalary && salary !== null && salary < minSalary) return false;
    if (education !== "all" && normalizeEducation(job.education) !== education) return false;
    if (experience !== "all" && normalizeExperience(job.experience) !== experience) return false;
    if (els.freshFilter.checked && !job.fresh) return false;
    return true;
  });
  const baseJobs = jobs;
  const strongJobs = baseJobs.filter(job =>
    job.searchTier !== "transferable" && effectiveFit(job).grade === "A"
  );
  const transferableJobs = baseJobs.filter(job =>
    job.searchTier === "transferable" || ["B", "C"].includes(effectiveFit(job).grade)
  );
  const savedJobs = baseJobs.filter(job => feedbackForJob(job)?.status === "saved");
  const newJobs = baseJobs.filter(job => job.isNew);
  $("#allJobCount").textContent = baseJobs.length;
  $("#strongJobCount").textContent = strongJobs.length;
  $("#transferJobCount").textContent = transferableJobs.length;
  $("#savedJobCount").textContent = savedJobs.length;
  $("#newJobCount").textContent = newJobs.length;
  if (state.resultView === "strong") jobs = strongJobs;
  else if (state.resultView === "transferable") jobs = transferableJobs;
  else if (state.resultView === "saved") jobs = savedJobs;
  else if (state.resultView === "new") jobs = newJobs;
  if (els.sortSelect.value === "score") jobs.sort((a, b) => effectiveScore(b) - effectiveScore(a));
  else jobs.sort((a, b) => (Number(b.capturedAt || 0) - Number(a.capturedAt || 0)) || (postedRank(b.posted) - postedRank(a.posted)));
  state.visibleJobs = jobs;
  $("#jobCount").textContent = jobs.length;
  els.emptyState.classList.toggle("hidden", jobs.length > 0);
  updateFilterAppearance();
  $("#emptyHint").textContent = state.resultView !== "all"
    ? "这个分组暂时没有岗位，切换到“全部”继续查看。"
    : activeFilterCount() ? "试试放宽或重置筛选条件。" : "换个职位或公司关键词试试。";
  els.jobList.innerHTML = jobs.map(job => {
    const fit = effectiveFit(job);
    const matchedTags = Array.isArray(job.matchedTags) ? job.matchedTags : [];
    const reasons = Array.isArray(job.reasons) && job.reasons.length ? job.reasons.slice(0, 2) : ["建议打开原岗位核对职责与要求"];
    const gaps = Array.isArray(job.gaps) ? job.gaps.slice(0, 2) : [];
    const source = job.source || state.jobSource;
    const feedback = feedbackForJob(job);
    const evidenceLabel = effectiveEvidence(job).label;
    const logoColor = /^#[0-9a-f]{6}$/i.test(String(job.logoColor || "")) ? job.logoColor : "#17633f";
    return `
    <article class="job-card" data-grade="${escapeHtml(fit.grade)}">
      <div class="company-logo" style="background:${logoColor}">${escapeHtml(job.logo)}</div>
      <div class="job-main">
        <div class="job-title-row"><h3>${job.url ? `<a href="${escapeHtml(job.url)}" target="_blank" rel="noopener">${escapeHtml(job.title)}</a>` : escapeHtml(job.title)}</h3><span class="fit-badge"><b>${escapeHtml(fit.grade)}</b>${escapeHtml(fit.label)}</span>${job.isNew ? '<span class="new-badge">本轮新增</span>' : ""}</div>
        <div class="company-line"><span>${escapeHtml(job.company)}</span><i></i><span>${escapeHtml(job.location)}</span></div>
        <div class="job-tags">${job.tags.map(tag => `<span class="${matchedTags.includes(tag) ? "matched" : ""}">${escapeHtml(tag)}</span>`).join("")}</div>
        <div class="match-explain">
          <div><b>推荐依据</b><span>${reasons.map(escapeHtml).join("；")}</span></div>
          ${gaps.length ? `<div class="gap-line"><b>需要核对</b><span>${gaps.map(escapeHtml).join("、")}</span></div>` : ""}
        </div>
        <div class="job-source">${job.searchTierLabel ? `${escapeHtml(job.searchTierLabel)} · ` : ""}${job.searchQuery ? `搜索「${escapeHtml(job.searchQuery)}」 · ` : ""}${escapeHtml(source)} · ${job.matchEngine === "ai" ? "AI 评估" : "本地规则"} · ${escapeHtml(evidenceLabel)}</div>
      </div>
      <div class="job-side">
        <div><div class="salary">${escapeHtml(job.salary)}</div><div class="job-meta">${escapeHtml(job.education)} · ${escapeHtml(job.experience)} · ${escapeHtml(job.posted)}</div></div>
        <div class="job-actions">
          <button class="greet-button" data-job-id="${job.id}" type="button">✦ 生成招呼语</button>
          <button class="chat-button" data-go-chat-id="${job.id}" type="button">去沟通 ↗</button>
        </div>
        <div class="feedback-actions">
          ${feedback?.status === "contacted" ? '<span>✓ 已沟通</span>' : ""}
          <button class="${feedback?.status === "saved" ? "active" : ""}" data-save-job-id="${job.id}" type="button">${feedback?.status === "saved" ? "★ 已收藏" : "☆ 收藏"}</button>
          <button data-dismiss-job-id="${job.id}" type="button">不合适</button>
        </div>
      </div>
    </article>`;
  }).join("");
}

function updateResultTabs() {
  els.resultTabs.querySelectorAll("button").forEach(button => {
    const active = button.dataset.view === state.resultView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

els.resultTabs.addEventListener("click", event => {
  const button = event.target.closest("button[data-view]");
  if (!button) return;
  state.resultView = button.dataset.view;
  updateResultTabs();
  filterAndRender();
  saveWorkspace();
});

els.searchInput.addEventListener("input", filterAndRender);
els.sortSelect.addEventListener("change", filterAndRender);
[els.locationFilter, els.educationFilter, els.experienceFilter]
  .forEach(control => control.addEventListener("change", () => { filterAndRender(); saveWorkspace(); }));
[els.targetCity, els.minSalaryPreference, els.freshFilter]
  .forEach(control => control.addEventListener("change", () => {
    syncManualBossUrl(); filterAndRender(); updateSourceNotice(); saveWorkspace();
  }));
els.jobKeyword.addEventListener("input", () => { syncManualBossUrl(); saveWorkspace(); });
els.searchInput.addEventListener("change", saveWorkspace);
els.sortSelect.addEventListener("change", saveWorkspace);
$("#resetFilters").addEventListener("click", () => resetFilters(true));

function jobCity(job) {
  const value = String(job.location || "").trim();
  if (!value || value.includes("待确认")) return "待确认";
  for (const city of ["北京", "上海", "天津", "重庆"]) if (value.startsWith(city)) return city;
  const cityMatch = value.match(/^(.{2,8}?(?:市|自治州|地区|盟))/);
  if (cityMatch) return cityMatch[1].replace(/市$/, "");
  return value.split(/[·\s]/)[0];
}

function normalizeEducation(value) {
  const text = String(value || "");
  for (const item of ["博士", "硕士", "本科", "大专", "中专/中技", "高中"]) if (text.includes(item)) return item;
  if (text.includes("中专")) return "中专/中技";
  if (text.includes("不限")) return "不限";
  return text.trim() || "待确认";
}

function normalizeExperience(value) {
  const text = String(value || "").trim();
  if (/在校|应届/.test(text)) return "在校/应届";
  if (!text || /不限/.test(text)) return "经验不限";
  return text;
}

function salaryMidpointK(value) {
  const text = String(value || "").replace(/,/g, "");
  if (/面议|待确认/.test(text) || !text) return null;
  const numbers = (text.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!numbers.length) return null;
  let values = numbers.slice(0, 2);
  let midpoint = values.reduce((sum, number) => sum + number, 0) / values.length;
  if (/元\s*\/?\s*(天|日)/.test(text)) midpoint = midpoint * 21.75 / 1000;
  else if (/元\s*\/?\s*(小时|时)/.test(text)) midpoint = midpoint * 8 * 21.75 / 1000;
  else if (/万/.test(text)) midpoint *= 10;
  else if (/元/.test(text) && midpoint >= 100) midpoint /= 1000;
  if (/\/\s*年|年薪/.test(text)) midpoint /= 12;
  return midpoint;
}

function postedRank(value) {
  const text = String(value || "");
  if (/刚刚/.test(text)) return 100000;
  if (/今天|今日/.test(text)) return 90000;
  if (/昨天/.test(text)) return 70000;
  const minutes = text.match(/(\d+)\s*分钟前/);
  if (minutes) return 95000 - Number(minutes[1]);
  const hours = text.match(/(\d+)\s*小时前/);
  if (hours) return 90000 - Number(hours[1]) * 60;
  const days = text.match(/(\d+)\s*天前/);
  if (days) return 70000 - Number(days[1]) * 1440;
  return 0;
}

function fitFromScore(score) {
  if (score >= 86) return { grade: "A", label: "高度匹配" };
  if (score >= 74) return { grade: "B", label: "值得尝试" };
  if (score >= 62) return { grade: "C", label: "能力可迁移" };
  return { grade: "D", label: "匹配较弱" };
}

function effectiveEvidence(job) {
  const description = String(job.description || "").replace(/\s+/g, " ").trim();
  const tagCount = Array.isArray(job.tags) ? job.tags.filter(Boolean).length : 0;
  if (job.detailStatus === "detail" && description.length >= 180) {
    return { level: "detail", label: "岗位详情已复核", cap: 97 };
  }
  if (description.length >= 180 && tagCount >= 3) {
    return { level: "summary", label: "列表信息较完整", cap: 85 };
  }
  return { level: "limited", label: "信息有限，建议核对", cap: 81 };
}

function effectiveScore(job) {
  return Math.min(Number(job.score || 0), effectiveEvidence(job).cap);
}

function effectiveFit(job) {
  return fitFromScore(effectiveScore(job));
}

function setDynamicOptions(select, values, allLabel, order = []) {
  select.replaceChildren(new Option(allLabel, "all"));
  const unique = [...new Set(values.filter(Boolean))];
  unique.sort((a, b) => {
    const left = order.indexOf(a), right = order.indexOf(b);
    if (left >= 0 || right >= 0) return (left < 0 ? 999 : left) - (right < 0 ? 999 : right);
    return a.localeCompare(b, "zh-CN");
  });
  unique.forEach(value => select.add(new Option(value, value)));
}

function refreshFilterOptions(reset = false) {
  if (reset) resetFilters(false);
  setDynamicOptions(els.locationFilter, state.jobs.map(jobCity), "全部地点");
  setDynamicOptions(els.educationFilter, state.jobs.map(job => normalizeEducation(job.education)), "全部学历", ["不限", "中专/中技", "高中", "大专", "本科", "硕士", "博士"]);
  setDynamicOptions(els.experienceFilter, state.jobs.map(job => normalizeExperience(job.experience)), "全部经验", ["经验不限", "在校/应届", "1年以内", "1-3年", "3-5年", "5-10年"]);
}

function activeFilterCount() {
  return [els.locationFilter, els.educationFilter, els.experienceFilter].filter(select => select.value !== "all").length;
}

function updateFilterAppearance() {
  const count = activeFilterCount();
  const badge = $("#activeFilterCount");
  badge.textContent = count; badge.classList.toggle("hidden", count === 0);
  [els.locationFilter, els.educationFilter, els.experienceFilter]
    .forEach(select => select.classList.toggle("active", select.value !== "all"));
}

function resetFilters(render = true) {
  [els.locationFilter, els.educationFilter, els.experienceFilter].forEach(select => { select.value = "all"; });
  if (render) { filterAndRender(); saveWorkspace(); } else updateFilterAppearance();
}
els.jobList.addEventListener("click", event => {
  const saveButton = event.target.closest("[data-save-job-id]");
  if (saveButton) {
    toggleSavedJob(saveButton.dataset.saveJobId);
    return;
  }
  const dismissButton = event.target.closest("[data-dismiss-job-id]");
  if (dismissButton) {
    openFeedbackModal(dismissButton.dataset.dismissJobId);
    return;
  }
  const button = event.target.closest("[data-job-id]");
  if (button) openGreeting(button.dataset.jobId);
  const chatButton = event.target.closest("[data-go-chat-id]");
  if (chatButton) openAndCopyGreeting(chatButton.dataset.goChatId, chatButton);
});

async function setJobFeedback(job, status, reason = "") {
  const response = await fetch("/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job, status, reason })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "反馈保存失败");
  if (data.feedback) state.feedback[data.key] = data.feedback;
  else delete state.feedback[data.key];
  state.profile.feedback = Object.values(state.feedback).slice(-80);
  filterAndRender();
  saveWorkspace();
}

async function toggleSavedJob(jobId) {
  const job = state.jobs.find(item => item.id === jobId);
  if (!job) return;
  const current = feedbackForJob(job);
  try {
    await setJobFeedback(job, current?.status === "saved" ? "none" : "saved");
    showToast(current?.status === "saved" ? "已取消收藏" : "已收藏，后续会提高相似岗位权重");
  } catch (error) { showToast(error.message); }
}

function openFeedbackModal(jobId) {
  state.pendingFeedbackJob = state.jobs.find(item => item.id === jobId) || null;
  if (!state.pendingFeedbackJob) return;
  $("#feedbackJobTitle").textContent = `${state.pendingFeedbackJob.company} · ${state.pendingFeedbackJob.title}`;
  showDialog(els.feedbackModal, "#feedbackReasons button");
}

function closeFeedbackModal() {
  state.pendingFeedbackJob = null;
  hideDialog(els.feedbackModal);
}

$("#feedbackModalClose").addEventListener("click", closeFeedbackModal);
els.feedbackModal.addEventListener("click", event => { if (event.target === els.feedbackModal) closeFeedbackModal(); });
$("#feedbackReasons").addEventListener("click", async event => {
  const button = event.target.closest("button[data-reason]");
  const job = state.pendingFeedbackJob;
  if (!button || !job) return;
  button.disabled = true;
  try {
    await setJobFeedback(job, "dismissed", button.dataset.reason);
    closeFeedbackModal();
    showToast(`已减少“${button.dataset.reason}”的相似岗位`);
  } catch (error) {
    showToast(error.message);
  } finally { button.disabled = false; }
});

async function openAndCopyGreeting(jobId, button) {
  const job = state.jobs.find(item => item.id === jobId);
  if (!job) return showToast("岗位已更新，请刷新结果后重试");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "生成中…";
  let opened = false;
  if (job.url) {
    try { opened = Boolean(window.open(job.url, "_blank")); } catch { opened = false; }
  }
  try {
    const response = await fetchWithTimeout("/api/greeting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: job.id, job, profile: profileForRequest(), tone: state.tone, provider: currentProvider() })
    }, 75000);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "生成失败");
    await navigator.clipboard.writeText(data.greeting);
    if (feedbackForJob(job)?.status !== "saved") {
      try { await setJobFeedback(job, "contacted"); } catch { /* 沟通主流程不因反馈保存失败而中断 */ }
    }
    button.textContent = "已复制 ✓";
    showToast(opened
      ? "岗位页已打开，招呼语已复制到剪贴板"
      : job.url
        ? "招呼语已复制（浏览器可能拦截了新窗口，可点标题打开）"
        : "招呼语已复制（该岗位暂无页面链接）");
  } catch (error) {
    button.textContent = original;
    showToast(error.message);
  } finally {
    button.disabled = false;
    setTimeout(() => { button.textContent = "去沟通 ↗"; }, 2500);
  }
}

async function openGreeting(jobId) {
  state.activeJob = state.jobs.find(job => job.id === jobId);
  if (!state.activeJob) return showToast("岗位已更新，请刷新结果后重试");
  $("#openJobPage").classList.toggle("hidden", !state.activeJob.url);
  state.tone = "professional";
  document.querySelectorAll("#toneTabs button").forEach(btn => btn.classList.toggle("active", btn.dataset.tone === state.tone));
  const fit = effectiveFit(state.activeJob).label;
  $("#modalJob").textContent = `${state.activeJob.company} · ${state.activeJob.title} · ${fit}`;
  $("#platformNote").textContent = state.activeJob.source?.includes("BOSS")
    ? "可粘贴到 BOSS 直聘的聊天对话框中"
    : "可粘贴到智联招聘的「立即沟通」对话框中";
  const matchedTags = Array.isArray(state.activeJob.matchedTags) ? state.activeJob.matchedTags : [];
  $("#matchBasis").innerHTML = (matchedTags.length ? matchedTags : state.profile.skills.slice(0, 2))
    .map(item => `<span>✓ ${escapeHtml(item)}</span>`).join("");
  showDialog(els.modal, "#modalClose");
  await generateGreeting();
}

async function generateGreeting() {
  const controls = [$("#regenerate"), $("#copyGreeting"), ...document.querySelectorAll("#toneTabs button")];
  controls.forEach(control => { control.disabled = true; });
  els.greetingText.value = "正在生成…"; updateCharCount();
  try {
    const response = await fetchWithTimeout("/api/greeting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: state.activeJob.id, job: state.activeJob, profile: profileForRequest(), tone: state.tone, provider: currentProvider() })
    }, 75000);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "生成失败");
    els.greetingText.value = data.greeting; updateCharCount();
    applyEngine(data.engine, false);
  } catch (error) {
    els.greetingText.value = "";
    showToast(error.name === "AbortError" ? "生成超时，请重试或切换模型" : error.message);
  } finally {
    controls.forEach(control => { control.disabled = false; });
  }
}

function showDialog(element, focusSelector = "button, input, textarea, select") {
  state.modalReturnFocus = document.activeElement;
  element.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  requestAnimationFrame(() => element.querySelector(focusSelector)?.focus());
}

function hideDialog(element) {
  element.classList.add("hidden");
  const openDialog = document.querySelector(".modal-backdrop:not(.hidden)");
  if (!openDialog) {
    document.body.style.overflow = "";
    if (state.modalReturnFocus instanceof HTMLElement) state.modalReturnFocus.focus();
    state.modalReturnFocus = null;
  }
}

function visibleDialog() {
  return document.querySelector(".modal-backdrop:not(.hidden)");
}

function closeModal() { hideDialog(els.modal); }
$("#modalClose").addEventListener("click", closeModal);
els.modal.addEventListener("click", event => { if (event.target === els.modal) closeModal(); });
document.addEventListener("keydown", event => {
  const dialog = visibleDialog();
  if (!dialog) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (dialog === els.modal) closeModal();
    else if (dialog === els.bossModal) closeBossModal();
    else if (dialog === els.zhaopinModal) closeZhaopinModal();
    else if (dialog === els.extensionModal) closeExtensionModal();
    else if (dialog === els.batchGreetingModal) hideDialog(els.batchGreetingModal);
    else if (dialog === els.feedbackModal) closeFeedbackModal();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...dialog.querySelectorAll("button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")]
    .filter(node => node.getClientRects().length);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
$("#toneTabs").addEventListener("click", event => {
  const button = event.target.closest("[data-tone]"); if (!button) return;
  state.tone = button.dataset.tone;
  document.querySelectorAll("#toneTabs button").forEach(btn => btn.classList.toggle("active", btn === button));
  generateGreeting();
});
$("#regenerate").addEventListener("click", generateGreeting);
els.greetingText.addEventListener("input", updateCharCount);

$("#copyGreeting").addEventListener("click", async () => {
  if (!els.greetingText.value.trim() || els.greetingText.value === "正在生成…") return showToast("招呼语尚未生成完成");
  try { await navigator.clipboard.writeText(els.greetingText.value); showToast("招呼语已复制，可以去沟通啦"); }
  catch { els.greetingText.select(); document.execCommand("copy"); showToast("招呼语已复制"); }
});
$("#openJobPage").addEventListener("click", () => {
  if (!state.activeJob?.url) return showToast("该岗位没有页面链接");
  window.open(state.activeJob.url, "_blank");
});

async function openBatchGreetings() {
  if (!state.profile) return showToast("请先上传并分析简历");
  if (!state.visibleJobs.length) return showToast("当前没有可生成的岗位");
  showDialog(els.batchGreetingModal, "#batchGreetingList");
  await loadBatchGreetings();
}

async function loadBatchGreetings() {
  const jobs = state.visibleJobs.slice(0, 15);
  els.batchGreetingList.innerHTML = `<p class="batch-loading">正在为 ${jobs.length} 个岗位生成招呼语，请稍候…</p>`;
  try {
    const response = await fetchWithTimeout("/api/greetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: profileForRequest(), jobs, tone: state.tone, provider: currentProvider()
      })
    }, 120000);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "批量生成失败");
    state.batchGreetings = data.greetings;
    applyEngine(data.engine, false);
    renderBatchGreetings();
  } catch (error) {
    state.batchGreetings = [];
    els.batchGreetingList.innerHTML = `<p class="batch-loading error">${escapeHtml(error.message)}</p>`;
  }
}

function renderBatchGreetings() {
  const items = state.batchGreetings || [];
  if (!items.length) {
    els.batchGreetingList.innerHTML = '<p class="batch-loading">没有生成结果，请检查岗位列表后重试。</p>';
    return;
  }
  els.batchGreetingList.innerHTML = items.map((item, index) => `
    <article class="batch-greeting-item">
      <header>
        <div><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.company)}</span></div>
        <button class="copy-small" data-batch="${index}" type="button">复制</button>
      </header>
      <p>${escapeHtml(item.greeting)}</p>
    </article>
  `).join("");
}

els.batchGreeting.addEventListener("click", openBatchGreetings);
els.batchGreetingModalClose.addEventListener("click", () => hideDialog(els.batchGreetingModal));
els.batchGreetingModal.addEventListener("click", event => { if (event.target === els.batchGreetingModal) hideDialog(els.batchGreetingModal); });
els.batchGreetingList.addEventListener("click", async event => {
  const button = event.target.closest(".copy-small");
  if (!button) return;
  const item = (state.batchGreetings || [])[Number(button.dataset.batch)];
  if (!item) return;
  try {
    await navigator.clipboard.writeText(item.greeting);
    showToast(`已复制「${item.title}」的招呼语`);
  } catch { showToast("复制失败，请手动选择文本"); }
});
els.batchToneTabs.addEventListener("click", event => {
  const button = event.target.closest("[data-tone]");
  if (!button) return;
  state.tone = button.dataset.tone;
  document.querySelectorAll("#batchToneTabs button").forEach(btn => btn.classList.toggle("active", btn === button));
  if (visibleDialog() === els.batchGreetingModal) loadBatchGreetings();
});
els.copyAllGreetings.addEventListener("click", async () => {
  const items = state.batchGreetings || [];
  if (!items.length) return showToast("招呼语尚未生成完成");
  const text = items.map(item => `${item.title}（${item.company}）\n${item.greeting}`).join("\n\n");
  try { await navigator.clipboard.writeText(text); showToast(`已复制 ${items.length} 条招呼语`); }
  catch { showToast("复制失败，请使用“下载 Markdown”"); }
});
els.downloadGreetings.addEventListener("click", () => {
  const items = state.batchGreetings || [];
  if (!items.length) return showToast("招呼语尚未生成完成");
  const markdown = items.map(item => `## ${item.title} · ${item.company}\n\n${item.greeting}\n`).join("\n---\n\n");
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `招呼语-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
});

function updateCharCount() { $("#charCount").textContent = `${els.greetingText.value.length} / 300`; }

async function loadProviderStatus() {
  try {
    const response = await fetch("/api/status");
    const data = await response.json();
    if (!response.ok) throw new Error("模型状态读取失败");
    state.providerStatus = data;
    if (data.extensionPath) $("#extensionPath").value = data.extensionPath;
    els.providerSelect.replaceChildren(new Option("本地规则 · 隐私优先", "local"));
    data.providers.forEach(provider => {
      const option = new Option(`${provider.label} · ${provider.model}${provider.configured ? "" : "（未配置）"}`, provider.id);
      option.disabled = !provider.configured;
      els.providerSelect.add(option);
    });
    const savedProvider = localStorage.getItem(PROVIDER_STORAGE_KEY);
    const selectableProviders = [...els.providerSelect.options]
      .filter(option => !option.disabled)
      .map(option => option.value);
    els.providerSelect.value = selectableProviders.includes(savedProvider)
      ? savedProvider
      : (data.default || "local");
    updateProviderHint();
  } catch {
    els.providerSelect.value = "local";
    updateProviderHint();
  }
}

function currentProvider() { return els.providerSelect.value || "local"; }

function updateProviderHint() {
  const isLocal = currentProvider() === "local";
  $("#modelStatusDot").classList.toggle("local", isLocal);
  $("#privacyText").textContent = isLocal
    ? "本地模式不会上传简历；分析与文案均在当前电脑完成。"
    : "云端模式会把提取后的简历文字发送到所选模型 API，不发送原文件。";
}

els.providerSelect.addEventListener("change", () => {
  localStorage.setItem(PROVIDER_STORAGE_KEY, currentProvider());
  updateProviderHint();
  if (state.profile) showToast("模型切换将在新分析和下一次文案生成时生效");
});

function renderRadar() {
  const radar = state.radar;
  const visible = radar && radar.status && radar.status !== "idle";
  els.radarPanel.classList.toggle("hidden", !visible);
  if (!visible) {
    els.startRadar.disabled = false;
    els.startRadar.textContent = "开始自动找工作";
    els.stopRadar.classList.add("hidden");
    els.resumeRadar.classList.add("hidden");
    return;
  }
  const completed = Number(radar.completed || 0);
  const total = Number(radar.total || 0);
  const progress = total ? Math.min(100, Math.round(completed / total * 100)) : 0;
  const current = radar.currentTask;
  const statusText = {
    running: current?.type === "detail" ? `正在复核「${current.query}」岗位详情` : current ? `正在搜索「${current.query}」` : "正在连续采集岗位",
    ready: "采集完成，准备统一匹配",
    finalizing: "采集完成，正在自动匹配岗位",
    paused: "已停止采集，正在整理现有岗位",
    paused_blocked: "等待处理验证码 / 登录",
    finalized: "本轮岗位雷达已完成",
    error: "岗位雷达未能完成整理",
  }[radar.status] || "正在准备岗位雷达";
  $("#radarTitle").textContent = statusText;
  $("#radarDetail").textContent = radar.status === "error"
    ? (radar.error || "请检查招聘页面或放宽条件后重新开始。")
    : radar.status === "paused_blocked"
    ? (radar.blockedReason || "请在招聘页面完成验证或登录，页面恢复后会自动继续。")
    : radar.status === "running"
    ? current?.type === "detail"
      ? `${current?.platformLabel || "招聘平台"} · 已复核 ${Number(radar.detailCompleted || 0)} / ${Number(radar.detailTotal || 0)} 个高潜岗位`
      : `${current?.platformLabel || "招聘平台"} · ${current?.tierLabel || "扩展搜索范围"} · 已采集 ${Number(current?.pagesCollected || 0)} 页`
    : radar.status === "finalizing"
      ? "后台正在去重与匹配；重新打开助手后会自动载入结果。"
    : radar.status === "finalized"
      ? "岗位已去重并完成统一评分，可按下方分组查看。"
      : "已采集的岗位会保留，不会因为停止而丢失。";
  $("#radarProgressText").textContent = `${completed} / ${total}`;
  $("#radarProgressBar").style.transform = `scaleX(${progress / 100})`;
  $("#radarCollected").textContent = Number(radar.collected || 0);
  $("#radarUnique").textContent = Number(radar.unique || 0);
  $("#radarDuplicates").textContent = Number(radar.duplicates || 0);
  $("#radarPlan").innerHTML = (radar.groups || []).map(group => `
    <div><b>${escapeHtml(group.label)}</b>${group.queries.map(query => `<span>${escapeHtml(query)}</span>`).join("")}</div>
  `).join("");
  const running = radar.status === "running";
  const blocked = radar.status === "paused_blocked";
  const matching = ["ready", "finalizing"].includes(radar.status) || state.radarFinalizing;
  els.startRadar.disabled = running || matching;
  els.startRadar.textContent = matching ? "正在自动匹配岗位" : radar.status === "finalized" ? "开始新一轮搜索" : running ? "岗位雷达运行中" : blocked ? "等待恢复" : "重新开始岗位雷达";
  els.stopRadar.classList.toggle("hidden", !running);
  els.resumeRadar.classList.toggle("hidden", !blocked);
}

function mergeRadarJobs(incoming) {
  const hasRealPool = !state.jobSource.includes("示例");
  const existingJobs = hasRealPool ? state.jobs.map(job => ({ ...job, isNew: false })) : [];
  const knownKeys = new Set(existingJobs.map(job => `${job.title}|${job.company}|${job.location}`.toLowerCase()));
  const merged = new Map();
  existingJobs.forEach(job => merged.set(`${job.title}|${job.company}|${job.location}`.toLowerCase(), job));
  incoming.forEach(job => {
    const key = `${job.title}|${job.company}|${job.location}`.toLowerCase();
    const candidate = { ...job, isNew: !knownKeys.has(key) };
    const previous = merged.get(key);
    if (!previous || candidate.detailStatus === "detail" && previous.detailStatus !== "detail" || effectiveScore(candidate) >= effectiveScore(previous)) {
      merged.set(key, { ...candidate, isNew: candidate.isNew });
    }
  });
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 300);
}

async function startRadar(options = {}) {
  if (!state.profile) {
    if (options.windowRef) options.windowRef.close();
    return showToast("请先上传并分析简历");
  }
  if (localStorage.getItem("zhideExtensionOnboarded") !== "1") {
    if (options.windowRef) options.windowRef.close();
    state.pendingCapturePlatform = "radar";
    openExtensionModal();
    return;
  }
  const searchWindow = options.windowRef || window.open("about:blank", "_blank");
  if (!searchWindow || searchWindow.closed) return showToast("浏览器阻止了搜索页，请允许弹出窗口后重试");
  state.captureSessionId = createSessionId();
  state.extensionSequence = 0;
  state.radarFinalizing = false;
  state.resultView = "all";
  state.blockedNotified = false;
  state.radarResultsLoaded = "";
  updateResultTabs();
  els.startRadar.disabled = true;
  els.startRadar.textContent = "正在生成搜索计划…";
  try {
    const response = await fetchWithTimeout(`/api/radar/start?provider=${encodeURIComponent(currentProvider())}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.captureSessionId,
        profile: profileForRequest(),
        platforms: ["zhaopin", "boss"]
      })
    }, 90000);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "岗位雷达启动失败");
    state.radar = data.radar;
    renderRadar();
    saveWorkspace();
    if (data.firstTask?.url) {
      searchWindow.opener = null;
      searchWindow.location.replace(data.firstTask.url);
    }
    else searchWindow.close();
    els.captureStatus.classList.add("hidden");
    if (data.warning) showToast(data.warning, 5200);
  } catch (error) {
    searchWindow.close();
    state.radar = null;
    renderRadar();
    showToast(error.name === "AbortError" ? "生成搜索计划超时，请稍后重试" : error.message);
  }
}

async function stopRadar() {
  if (!state.radar) return;
  els.stopRadar.disabled = true;
  try {
    const response = await fetch("/api/radar/cancel", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.captureSessionId })
    });
    const data = await response.json();
    if (response.ok) state.radar = data.radar;
    renderRadar();
    await finalizeRadar();
  } finally {
    els.stopRadar.disabled = false;
  }
}

async function finalizeRadar() {
  if (state.radarFinalizing) return;
  const sessionId = state.captureSessionId;
  state.radarFinalizing = true;
  renderRadar();
  setCaptureStatus("正在统一匹配岗位", "先用本地规则初筛全部岗位，再由大模型精排更值得看的候选。", "working");
  try {
    const response = await fetchWithTimeout(`/api/radar/finalize?provider=${encodeURIComponent(currentProvider())}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, profile: profileForRequest() })
    }, 180000);
    const data = await response.json();
    if (sessionId !== state.captureSessionId) return;
    if (!response.ok) throw new Error(data.error || "岗位池整理失败");
    if (data.pending) {
      state.radar = data.radar;
      saveWorkspace();
      return;
    }
    applyRadarResults(data);
  } catch (error) {
    if (sessionId !== state.captureSessionId) return;
    const reconnecting = error.name === "AbortError" || error instanceof TypeError;
    state.radar = { ...(state.radar || {}), status: reconnecting ? "ready" : "error", error: error.message };
    renderRadar();
    saveWorkspace();
    setCaptureStatus(reconnecting ? "正在等待本地助手恢复连接" : "岗位池整理失败", reconnecting ? "已采集的岗位会保留，恢复连接后自动同步结果。" : error.message, "error");
    showToast(reconnecting ? "连接暂时中断，稍后会自动同步匹配结果" : error.message);
  } finally {
    state.radarFinalizing = false;
    renderRadar();
  }
}

function applyRadarResults(data) {
  state.jobs = mergeRadarJobs(data.jobs || []);
  state.visibleJobs = state.jobs;
  state.radar = data.radar;
  state.radarResultsLoaded = state.captureSessionId;
  state.jobSource = "岗位雷达真实岗位";
  state.extensionPlatforms = ["智联招聘", "BOSS直聘"];
  refreshFilterOptions(true);
  applyEngine(data.engine);
  updateResultTabs();
  filterAndRender();
  renderRadar();
  updateSourceNotice(data.source);
  saveWorkspace();
  els.captureStatus.classList.add("hidden");
  showToast("岗位雷达已自动完成匹配，可以查看推荐结果");
}

async function checkRadarStatus() {
  if (!state.profile || !state.radar || state.radarFinalizing || state.radarChecking || ["idle", "error"].includes(state.radar.status)) return;
  if (state.radar.status === "finalized" && state.radarResultsLoaded === state.captureSessionId) return;
  const sessionId = state.captureSessionId;
  state.radarChecking = true;
  try {
    const response = await fetchWithTimeout(`/api/radar/status?session=${encodeURIComponent(sessionId)}`, { cache: "no-store" }, 10000);
    const data = await response.json();
    if (!response.ok || !data.radar || sessionId !== state.captureSessionId) return;
    state.radar = data.radar;
    renderRadar();
    saveWorkspace();
    if (state.radar.status === "paused_blocked" && !state.blockedNotified) {
      state.blockedNotified = true;
      notifyRadarBlocked(state.radar.blockedReason);
    } else if (state.radar.status !== "paused_blocked") {
      state.blockedNotified = false;
    }
    if (state.radar.status === "ready") await finalizeRadar();
    else if (state.radar.status === "finalized") {
      const resultResponse = await fetchWithTimeout(`/api/radar/results?session=${encodeURIComponent(sessionId)}`, { cache: "no-store" }, 10000);
      const result = await resultResponse.json();
      if (resultResponse.ok && result.ready && sessionId === state.captureSessionId) applyRadarResults(result);
    }
  } catch { /* 本地服务恢复后下一轮轮询会继续同步进度和结果。 */ }
  finally { state.radarChecking = false; }
}

function notifyRadarBlocked(reason) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const notification = new Notification("岗位雷达需要你处理一下", {
      body: reason || "招聘页面出现验证码或登录要求",
      tag: "radar-blocked"
    });
    notification.onclick = () => { window.focus(); notification.close(); };
  } catch { /* 通知不可用时静默降级为页面内提示 */ }
}

function renderScheduleState(data) {
  els.scheduleState.textContent = data.enabled
    ? `每天 ${String(data.hour).padStart(2, "0")}:${String(data.minute).padStart(2, "0")} 运行`
    : "未开启";
  const formatTime = value => value ? new Date(Number(value) * 1000).toLocaleString("zh-CN", { hour12: false }) : "";
  const meta = $("#scheduleMeta");
  if (data.storage?.ok === false) {
    meta.textContent = `本机数据保存失败：${data.storage.error || "文件被占用"}`;
    meta.classList.add("error");
  } else if (data.lastError) {
    meta.textContent = `上次自动运行失败：${data.lastError}`;
    meta.classList.add("error");
  } else if (data.lastStartedAt) {
    meta.textContent = `上次成功启动：${formatTime(data.lastStartedAt)}；本地助手短暂关闭时，扩展会在恢复连接后补跑。`;
    meta.classList.remove("error");
  } else {
    meta.textContent = "本地助手和浏览器都需要保持运行；若服务短暂关闭，恢复后会自动补跑。";
    meta.classList.remove("error");
  }
}

async function loadScheduleConfig() {
  try {
    const response = await fetch("/api/radar/schedule");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取定时设置失败");
    els.scheduleEnabled.checked = Boolean(data.enabled);
    els.scheduleTime.value = `${String(data.hour).padStart(2, "0")}:${String(data.minute).padStart(2, "0")}`;
    renderScheduleState(data);
  } catch { /* 服务未启动时保持默认设置 */ }
}

async function saveSchedule() {
  const enabled = els.scheduleEnabled.checked;
  if (enabled && !state.profile) return showToast("请先上传并分析简历，再开启定时雷达");
  const [hour, minute] = els.scheduleTime.value.split(":").map(Number);
  try {
    const response = await fetch("/api/radar/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled,
        hour: Number.isFinite(hour) ? hour : 9,
        minute: Number.isFinite(minute) ? minute : 0,
        platforms: ["zhaopin", "boss"],
        provider: currentProvider(),
        profile: enabled ? profileForRequest() : null
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "保存失败");
    renderScheduleState(data.schedule);
    showToast(enabled
      ? `已开启定时雷达，每天 ${String(data.schedule.hour).padStart(2, "0")}:${String(data.schedule.minute).padStart(2, "0")} 自动运行`
      : "定时雷达已关闭");
  } catch (error) {
    showToast(error.message);
  }
}

async function checkScheduledSummary() {
  try {
    const response = await fetch("/api/radar/scheduled/last");
    const data = await response.json();
    if (!response.ok || !data.summary || !data.summary.runId) return;
    if (data.summary.runId === state.lastScheduledSeen) return;
    state.lastScheduledSeen = data.summary.runId;
    els.scheduledResultTitle.textContent = data.summary.newCount > 0
      ? `定时雷达发现 ${data.summary.newCount} 个新岗位`
      : "定时雷达已完成本轮采集";
    els.scheduledResultText.textContent = data.summary.message;
    els.scheduledResult.classList.remove("hidden");
  } catch { /* 忽略瞬时错误 */ }
}

async function loadScheduledResults() {
  try {
    const response = await fetch("/api/radar/scheduled/results");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "载入失败");
    if (!data.jobs?.length) return showToast("定时雷达还没有结果");
    state.profile = data.profile || state.profile;
    state.jobs = data.jobs;
    state.visibleJobs = data.jobs;
    state.jobSource = "定时雷达";
    state.extensionPlatforms = ["智联招聘", "BOSS直聘"];
    state.captureSessionId = createSessionId();
    state.radar = null;
    state.resultView = "all";
    applyEngine(data.engine || { mode: "local" }, false);
    renderProfile();
    refreshFilterOptions(true);
    filterAndRender();
    renderRadar();
    updateSourceNotice();
    saveWorkspace();
    els.scheduledResult.classList.add("hidden");
    showToast(`已载入 ${data.jobs.length} 个定时雷达结果`);
  } catch (error) {
    showToast(error.message);
  }
}

els.startRadar.addEventListener("click", startRadar);
els.stopRadar.addEventListener("click", stopRadar);
els.resumeRadar.addEventListener("click", resumeRadar);
els.saveSchedule.addEventListener("click", saveSchedule);
els.loadScheduledResults.addEventListener("click", loadScheduledResults);

async function resumeRadar() {
  if (!state.radar) return;
  try {
    const response = await fetch("/api/radar/resume", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.captureSessionId })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "雷达恢复失败");
    state.radar = data.radar;
    renderRadar();
    saveWorkspace();
    showToast("雷达已恢复，浏览器里的招聘页面会自动继续采集");
  } catch (error) {
    showToast(error.message);
  }
}

$("#importZhaopin").addEventListener("click", importZhaopinJobs);
$("#discoverZhaopin").addEventListener("click", () => startExtensionCapture("zhaopin"));
$("#zhaopinModalClose").addEventListener("click", closeZhaopinModal);
$("#cancelZhaopinImport").addEventListener("click", closeZhaopinModal);
els.zhaopinModal.addEventListener("click", event => { if (event.target === els.zhaopinModal) closeZhaopinModal(); });
$("#confirmZhaopinImport").addEventListener("click", importZhaopinTextJobs);
$("#openBossImport").addEventListener("click", () => startExtensionCapture("boss"));
$("#bossModalClose").addEventListener("click", closeBossModal);
$("#cancelBossImport").addEventListener("click", closeBossModal);
els.bossModal.addEventListener("click", event => { if (event.target === els.bossModal) closeBossModal(); });
$("#bossUrl").addEventListener("input", event => {
  const value = event.target.value.trim();
  if (value.startsWith("https://") && value.includes("zhipin.com/zhaopin/")) $("#openBossPage").href = value;
});
$("#confirmBossImport").addEventListener("click", importBossJobs);
$("#manualZhaopinText").addEventListener("click", openZhaopinModal);
$("#manualBossText").addEventListener("click", openBossModal);
$("#showExtensionGuide").addEventListener("click", openExtensionModal);
$("#extensionModalClose").addEventListener("click", closeExtensionModal);
els.extensionModal.addEventListener("click", event => { if (event.target === els.extensionModal) closeExtensionModal(); });
$("#copyExtensionPath").addEventListener("click", copyExtensionPath);
$("#extensionInstalled").addEventListener("click", () => {
  localStorage.setItem("zhideExtensionOnboarded", "1");
  const platform = state.pendingCapturePlatform;
  state.pendingCapturePlatform = null;
  closeExtensionModal();
  if (platform === "radar") startRadar();
  else if (platform) activateAndOpenCapture(platform);
  else showToast("扩展准备完成，打开招聘搜索页就可以一键采集");
});

function openExtensionModal() {
  showDialog(els.extensionModal, "#extensionModalClose");
}

function closeExtensionModal() {
  state.pendingCapturePlatform = null;
  hideDialog(els.extensionModal);
}

async function copyExtensionPath() {
  const value = $("#extensionPath").value;
  try { await navigator.clipboard.writeText(value); showToast("扩展目录已复制"); }
  catch { $("#extensionPath").select(); document.execCommand("copy"); showToast("扩展目录已复制"); }
}

async function startExtensionCapture(platform) {
  if (!state.profile) return showToast("请先上传并分析简历");
  if (!els.jobKeyword.value.trim()) return showToast("请填写岗位关键词");
  if (localStorage.getItem("zhideExtensionOnboarded") !== "1") {
    state.pendingCapturePlatform = platform;
    openExtensionModal();
    return;
  }
  await activateAndOpenCapture(platform);
}

async function activateAndOpenCapture(platform) {
  try {
    const response = await fetchWithTimeout("/api/extension/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.captureSessionId, platform })
    }, 12000);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法创建岗位采集会话");
    state.extensionSequence = data.sequence || 0;
    openCapturePage(platform);
  } catch (error) {
    showToast(error.name === "AbortError" ? "连接本地采集服务超时，请重启应用" : error.message);
  }
}

function buildBossSearchUrl() {
  const cityCodes = {
    全国: "100010000", 北京: "101010100", 上海: "101020100", 广州: "101280100", 深圳: "101280600",
    杭州: "101210100", 成都: "101270100", 重庆: "101040100", 武汉: "101200100", 南京: "101190100",
    苏州: "101190400", 天津: "101030100", 西安: "101110100"
  };
  const keyword = els.jobKeyword.value.trim();
  const city = cityCodes[els.targetCity.value] || cityCodes.全国;
  return `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(keyword)}&city=${city}`;
}

function syncManualBossUrl() {
  const url = buildBossSearchUrl();
  $("#bossUrl").value = url;
  $("#openBossPage").href = url;
}

function openCapturePage(platform) {
  const label = platform === "boss" ? "BOSS" : "智联";
  const url = platform === "boss" ? buildBossSearchUrl() : buildZhaopinSearchUrl();
  const opened = window.open(url, "_blank");
  if (!opened) return showToast("浏览器阻止了新页面，请允许弹出窗口后重试");
  opened.opener = null;
  setCaptureStatus(`等待 ${label} 岗位`, `已打开定向搜索页；确认条件后点击浏览器工具栏里的“职得岗位采集助手”。`, "waiting");
  showToast(`已打开 ${label}，加载岗位后点击扩展图标即可`);
}

function setCaptureStatus(title, detail, mode = "") {
  $("#captureStatusTitle").textContent = title;
  $("#captureStatusText").textContent = detail;
  els.captureStatus.className = `capture-status ${mode}`.trim();
}

function mergeExtensionJobs(incoming) {
  const base = state.extensionPlatforms.length ? state.jobs : [];
  const merged = new Map();
  [...base, ...incoming].forEach(job => {
    const key = `${job.title}|${job.company}|${job.location}`.toLowerCase();
    const existing = merged.get(key);
    if (!existing || job.detailStatus === "detail" && existing.detailStatus !== "detail" || effectiveScore(job) > effectiveScore(existing)) merged.set(key, job);
  });
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 80);
}

async function checkExtensionInbox() {
  if (!state.profile || state.extensionImporting) return;
  try {
    const response = await fetch(`/api/extension/latest?session=${encodeURIComponent(state.captureSessionId)}&after=${state.extensionSequence}`, { cache: "no-store" });
    const data = await response.json();
    const batches = Array.isArray(data.batches) ? data.batches : (data.batch ? [data.batch] : []);
    if (!response.ok || !batches.length) return;
    for (const batch of batches) {
      if (batch.sessionId && batch.sessionId !== state.captureSessionId) continue;
      if (batch.radarTaskId) {
        state.extensionSequence = Math.max(state.extensionSequence, Number(batch.sequence || 0));
        continue;
      }
      await importExtensionBatch(batch);
      state.extensionSequence = Math.max(state.extensionSequence, Number(batch.sequence || 0));
    }
  } catch { /* 服务重新启动时等待下一轮即可 */ }
}

async function importExtensionBatch(batch) {
  state.extensionImporting = true;
  setCaptureStatus(`收到 ${batch.jobs.length} 个${batch.platformLabel}岗位`, "正在去重并根据简历重新计算匹配度…", "working");
  try {
    const response = await fetchWithTimeout(`/api/extension/match?provider=${encodeURIComponent(currentProvider())}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: batch.platform, url: batch.url, jobs: batch.jobs, profile: profileForRequest() })
    }, 120000);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "扩展岗位匹配失败");
    state.jobs = mergeExtensionJobs(data.jobs); state.visibleJobs = state.jobs;
    if (!state.extensionPlatforms.includes(batch.platformLabel)) state.extensionPlatforms.push(batch.platformLabel);
    state.jobSource = `${state.extensionPlatforms.join(" + ")}扩展岗位`;
    refreshFilterOptions(true); applyEngine(data.engine); filterAndRender();
    const excluded = Number(data.source?.excludedCount || 0);
    const detail = excluded
      ? `${batch.platformLabel}采集完成，已按求职条件排除 ${excluded} 个岗位；继续采集会自动合并。`
      : `${batch.platformLabel}采集完成；继续采集其他页面会自动合并和去重。`;
    setCaptureStatus(`已匹配 ${state.jobs.length} 个真实岗位`, detail, "success");
    updateSourceNotice(data.source); saveWorkspace();
    if (!data.engine?.warning) showToast(`${batch.platformLabel}岗位已自动导入并完成匹配`);
  } catch (error) {
    setCaptureStatus("岗位接收失败", error.message, "error");
    showToast(error.message);
  } finally { state.extensionImporting = false; }
}

setInterval(() => {
  checkExtensionInbox();
  checkRadarStatus();
}, 2200);
setInterval(checkScheduledSummary, 30000);

function openBossModal() {
  if (!state.profile) return showToast("请先上传并分析简历");
  if (currentProvider() === "local") return showToast("BOSS 文本导入需要大模型，请先选择千问或 DeepSeek");
  syncManualBossUrl();
  showDialog(els.bossModal, "#bossPageText");
}

function closeBossModal() {
  hideDialog(els.bossModal);
}

async function importBossJobs() {
  const pageText = $("#bossPageText").value.trim();
  const url = $("#bossUrl").value.trim();
  if (pageText.length < 80) return showToast("请粘贴包含职位、公司和薪资的列表文字");
  const button = $("#confirmBossImport");
  button.disabled = true; button.textContent = "正在解析匹配…";
  try {
    const response = await fetchWithTimeout(`/api/boss/import?provider=${encodeURIComponent(currentProvider())}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, pageText, profile: profileForRequest() })
    }, 90000);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "BOSS 岗位导入失败");
    state.jobs = data.jobs; state.visibleJobs = data.jobs; state.jobSource = "BOSS 真实公开岗位"; state.extensionPlatforms = [];
    refreshFilterOptions(true); applyEngine(data.engine); filterAndRender(); closeBossModal();
    updateSourceNotice(data.source); saveWorkspace();
    showToast(`已导入 ${data.jobs.length} 个 BOSS 公开岗位`);
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = "解析并匹配岗位"; }
}

function buildZhaopinSearchUrl() {
  const city = els.targetCity.value;
  const keyword = els.jobKeyword.value.trim();
  const query = city === "全国" ? keyword : `${city} ${keyword}`;
  return `https://sou.zhaopin.com/?kw=${encodeURIComponent(query)}&kt=3`;
}

function openZhaopinModal() {
  if (!state.profile) return showToast("请先上传并分析简历");
  if (currentProvider() === "local") return showToast("智联文本导入需要大模型，请先选择千问或 DeepSeek");
  const keyword = els.jobKeyword.value.trim();
  if (!keyword) return showToast("请填写岗位关键词，例如“环境工程”");
  const url = buildZhaopinSearchUrl();
  $("#zhaopinSearchUrl").value = url; $("#openZhaopinSearch").href = url;
  showDialog(els.zhaopinModal, "#zhaopinPageText");
}

function closeZhaopinModal() {
  hideDialog(els.zhaopinModal);
}

async function importZhaopinTextJobs() {
  const pageText = $("#zhaopinPageText").value.trim();
  const url = $("#zhaopinSearchUrl").value.trim();
  if (pageText.length < 80) return showToast("请粘贴包含职位、公司、薪资和地点的列表文字");
  const button = $("#confirmZhaopinImport");
  button.disabled = true; button.textContent = "正在解析匹配…";
  try {
    const response = await fetchWithTimeout(`/api/zhaopin/text-import?provider=${encodeURIComponent(currentProvider())}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, pageText, profile: profileForRequest() })
    }, 90000);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "智联岗位导入失败");
    const city = els.targetCity.value;
    state.jobs = data.jobs; state.visibleJobs = data.jobs; state.jobSource = `智联${city === "全国" ? "全国" : city}相关岗位`; state.extensionPlatforms = [];
    refreshFilterOptions(true); applyEngine(data.engine); filterAndRender(); closeZhaopinModal();
    updateSourceNotice(data.source); saveWorkspace();
    showToast(`已导入 ${data.jobs.length} 个相关智联岗位`);
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = "解析并匹配岗位"; }
}

async function importZhaopinJobs() {
  if (!state.profile) return showToast("请先上传并分析简历");
  const button = $("#importZhaopin");
  const url = $("#zhaopinUrl").value.trim();
  if (!url) return showToast("请先粘贴智联招聘公开列表页地址");
  button.disabled = true; button.textContent = "正在读取…";
  try {
    const response = await fetchWithTimeout(`/api/zhaopin/import?provider=${encodeURIComponent(currentProvider())}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, profile: profileForRequest() })
    }, 90000);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "真实岗位导入失败");
    state.jobs = data.jobs; state.visibleJobs = data.jobs; state.jobSource = "智联真实公开岗位"; state.extensionPlatforms = [];
    refreshFilterOptions(true); applyEngine(data.engine); filterAndRender();
    updateSourceNotice(data.source); saveWorkspace();
    if (!data.engine?.warning) showToast(`已导入 ${data.jobs.length} 个智联公开岗位`);
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = "导入此页面"; }
}

function applyEngine(engine, showWarning = true) {
  if (!engine) return;
  state.engine = engine;
  const ai = engine.mode === "ai" ? `${engine.label} · ${engine.model}` : "本地规则";
  const text = `${state.jobSource} · ${ai}`;
  els.enginePill.innerHTML = `<span class="status-dot ${engine.mode === "local" ? "local" : ""}"></span> ${escapeHtml(text)}`;
  updateSourceNotice();
  if (showWarning && engine.warning) showToast(engine.warning, 5200);
}

function updateSourceNotice(source = null) {
  if (source) state.sourceMeta = source;
  const notice = $("#sourceNotice");
  if (!notice || !state.profile) return;
  const title = notice.querySelector("b");
  const detail = notice.querySelector("span");
  if (state.engine?.warning) {
    notice.className = "source-notice warning";
    title.textContent = "部分结果已自动降级";
    detail.textContent = state.engine.warning;
    return;
  }
  if (state.jobSource.includes("示例")) {
    notice.className = "source-notice sample";
    title.textContent = "当前展示示例岗位";
    detail.textContent = "确认求职条件并完成一次采集后，这里会切换为智联或 BOSS 的真实岗位。";
    return;
  }
  notice.className = "source-notice live";
  title.textContent = "当前为真实岗位";
  const excluded = Number(state.sourceMeta?.excludedCount || 0);
  const sourceName = state.sourceMeta?.name || state.jobSource;
  if (sourceName === "岗位雷达") {
    const collected = Number(state.sourceMeta?.collectedCount || 0);
    const unique = Number(state.sourceMeta?.uniqueCount || state.jobs.length);
    const duplicates = Number(state.sourceMeta?.duplicateCount || 0);
    detail.textContent = `跨关键词采集 ${collected} 个，去重后 ${unique} 个${duplicates ? `，合并 ${duplicates} 个重复岗位` : ""}${excluded ? `，按硬性条件排除 ${excluded} 个` : ""}。`;
    return;
  }
  detail.textContent = excluded
    ? `${sourceName}；已按求职条件排除 ${excluded} 个岗位。`
    : `${sourceName}；打开职位标题可回到原招聘页面核对详情。`;
}

function showToast(message, duration = 3200) {
  els.toast.textContent = message; els.toast.classList.add("show");
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => els.toast.classList.remove("show"), duration);
}

async function fetchWithTimeout(url, options = {}, timeout = 75000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}
