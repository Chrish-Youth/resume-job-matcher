(() => {
  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  const uniq = values => [...new Set(values.map(clean).filter(Boolean))];
  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const API = "http://127.0.0.1:8765";
  let radarRunning = false;
  let nextRadarCheckAt = 0;
  let radarFailures = 0;
  let pendingCapture = null;

  async function radarRequest(path, payload) {
    if (payload?.sessionId && ["/api/extension/collect", "/api/radar/skip"].includes(path)) {
      sessionStorage.setItem(`zhideRadarLastSubmitted:${payload.sessionId}`, payload.radarTaskId || payload.taskId);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(API + path, {
        method: payload ? "POST" : "GET",
        headers: payload ? { "Content-Type": "application/json" } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
        cache: "no-store", signal: controller.signal
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `本地助手返回 ${response.status}`);
      return result;
    } finally { clearTimeout(timer); }
  }

  function taskMatchesPage(task) {
    if (!task || task.platform !== currentPlatform()) return false;
    try {
      const expected = new URL(task.url);
      const current = new URL(location.href);
      if (task.type === "detail") {
        return expected.hostname === current.hostname &&
          expected.pathname.replace(/\/$/, "") === current.pathname.replace(/\/$/, "");
      }
      const queryName = task.platform === "boss" ? "query" : "kw";
      const expectedQuery = expected.searchParams.get(queryName);
      const currentQuery = current.searchParams.get(queryName);
      if (expectedQuery && currentQuery) {
        if (clean(expectedQuery) !== clean(currentQuery)) return false;
      } else if (!decodeURIComponent(current.href).toLowerCase().includes(String(task.query || "").toLowerCase())) {
        return false;
      }
      const city = expected.searchParams.get("city");
      return !city || current.searchParams.get("city") === city;
    } catch { return false; }
  }

  function currentPlatform() {
    const host = location.hostname.toLowerCase();
    return host.endsWith("zhaopin.com") ? "zhaopin" : host.endsWith("zhipin.com") ? "boss" : "";
  }

  function showRadarStatus(message, type = "working") {
    let node = document.querySelector("#zhide-radar-status");
    if (!node) {
      node = document.createElement("div");
      node.id = "zhide-radar-status";
      Object.assign(node.style, {
        position: "fixed", right: "18px", bottom: "18px", zIndex: "2147483647",
        maxWidth: "330px", padding: "12px 14px", borderRadius: "10px",
        color: "#fff", background: "#17633f", boxShadow: "0 4px 8px rgba(0,0,0,.18)",
        font: "600 13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif"
      });
      document.documentElement.appendChild(node);
    }
    node.style.background = type === "error" ? "#a13a32" : type === "done" ? "#17633f" : "#174a95";
    node.textContent = message;
  }

  function textFrom(root, selectors) {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      const text = clean(node?.textContent);
      if (text) return text;
    }
    return "";
  }

  function findCard(anchor, preferredSelectors = []) {
    for (const selector of preferredSelectors) {
      const card = anchor.closest(selector);
      const text = clean(card?.innerText);
      if (card && text.length >= 30 && text.length < 2400 && /(?:\d+(?:\.\d+)?[-–—]\d+(?:\.\d+)?[Kk万千元]|薪资面议)/.test(text)) return card;
    }
    let node = anchor;
    for (let depth = 0; depth < 7 && node; depth += 1, node = node.parentElement) {
      const text = clean(node.innerText);
      if (text.length >= 30 && text.length <= 1600 && /(?:\d+(?:\.\d+)?[-–—]\d+(?:\.\d+)?[Kk万千元]|薪资面议)/.test(text)) return node;
    }
    return anchor.parentElement;
  }

  function metaFrom(text) {
    const education = text.match(/(?:博士|硕士|本科|大专|中专(?:\/中技)?|高中|学历不限|不限学历)/)?.[0] || "学历不限";
    const experience = text.match(/(?:经验不限|无需经验|无经验|应届生|在校生|1年以内|1-3年|3-5年|5-10年|10年以上)/)?.[0] || "经验不限";
    const posted = text.match(/(?:刚刚|今日|今天|昨天|\d+分钟前|\d+小时前|\d+天前)/)?.[0] || "扩展采集";
    return { education, experience, posted };
  }

  function tagsFrom(card) {
    const nodes = card.querySelectorAll("[class*='tag'] span, [class*='tag'] li, [class*='label'], [class*='skill'] span, .tag-list li");
    return uniq([...nodes].map(node => node.textContent)).filter(item => item.length <= 30).slice(0, 10);
  }

  function makeJob(card, anchor, platform) {
    const text = clean(card.innerText);
    const isBoss = platform === "boss";
    const titleCandidates = [
      anchor.getAttribute("title"),
      textFrom(card, isBoss
        ? [".job-name", "[class*='job-name']", "[class*='job-title']", "h3", "h4"]
        : ["[class*='job-name']", "[class*='job-title']", "[class*='position']", "h3", "h4"]
      ),
      anchor.textContent
    ].map(clean);
    const title = titleCandidates.find(item => item && item.length <= 100) || "";
    let company = textFrom(card, [
      ".company-name", "[class*='company-name']", "[class*='company_title']",
      "[class*='company'] a", "[class*='company']"
    ]);
    if (!company || company.length > 120) {
      const companyLinks = [...card.querySelectorAll("a[href*='company'], a[href*='gongsi']")]
        .map(node => clean(node.textContent)).filter(item => item.length >= 2 && item.length <= 120);
      company = companyLinks[0] || "";
    }
    const salary = textFrom(card, [".salary", "[class*='salary']", "[class*='job-salary']"]) ||
      text.match(/\d+(?:\.\d+)?[-–—]\d+(?:\.\d+)?\s*(?:K|k|万|千|元)(?:\/月|\/天|·\d+薪)?/)?.[0] || "薪资面议";
    const jobLocation = textFrom(card, [
      ".job-area", "[class*='job-area']", "[class*='location']", "[class*='workplace']", "[class*='area']"
    ]) || text.match(/(?:北京|上海|天津|重庆|广州|深圳|杭州|成都|武汉|南京|苏州|西安|长沙|郑州|合肥|济南|青岛|厦门|福州|昆明|南昌|沈阳|大连|宁波|无锡|佛山|东莞)(?:[·\s][\u4e00-\u9fff]{2,8}(?:区|县))?/)?.[0] || "地点待确认";
    const meta = metaFrom(text);
    const url = anchor.href || window.location.href;
    if (!title || !company || title.length > 100 || company.length > 120) return null;
    return {
      title, company, salary: clean(salary), location: clean(jobLocation),
      education: meta.education, experience: meta.experience,
      fresh: /实习|应届|校招|在校/.test(`${title} ${text}`),
      tags: tagsFrom(card), description: text.slice(0, 500), posted: meta.posted, url
    };
  }

  function collect(platform) {
    const anchorSelector = platform === "boss"
      ? "a[href*='/job_detail/'], a[href*='/jobdetail/']"
      : "a[href*='/jobdetail/'], a[href*='/job_detail/']";
    const preferred = platform === "boss"
      ? [".job-card-wrapper", ".job-card-box", "li[class*='job-card']", "[class*='job-card-wrapper']"]
      : ["[class*='joblist-box__item']", "[class*='joblist-card']", "[class*='job-card']", "article", "li"];
    const jobs = [];
    const seenCards = new Set();
    const seenJobs = new Set();
    for (const anchor of document.querySelectorAll(anchorSelector)) {
      const card = findCard(anchor, preferred);
      if (!card || seenCards.has(card)) continue;
      seenCards.add(card);
      const job = makeJob(card, anchor, platform);
      if (!job) continue;
      const key = `${job.title}|${job.company}|${job.location}`.toLowerCase();
      if (seenJobs.has(key)) continue;
      seenJobs.add(key);
      jobs.push(job);
      if (jobs.length >= 60) break;
    }
    return jobs;
  }

  async function scrollAndCollect(platform, autoScroll) {
    if (!autoScroll) return collect(platform);
    const originalY = window.scrollY;
    const jobs = new Map();
    const merge = () => {
      for (const job of collect(platform)) {
        const key = `${job.title}|${job.company}|${job.location}`.toLowerCase();
        if (!jobs.has(key)) jobs.set(key, job);
      }
    };
    merge();
    let unchanged = 0;
    for (let index = 0; index < 8 && jobs.size < 60; index += 1) {
      const before = jobs.size;
      window.scrollBy({ top: Math.max(window.innerHeight * 0.85, 650), behavior: "smooth" });
      await wait(700);
      merge();
      unchanged = jobs.size === before ? unchanged + 1 : 0;
      const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 80;
      if (atBottom && unchanged >= 2) break;
    }
    window.scrollTo({ top: originalY, behavior: "smooth" });
    await wait(400);
    merge();
    return [...jobs.values()].slice(0, 60);
  }

  function nextPageButton() {
    const selectors = [
      "a[rel='next']", "button[aria-label='下一页']", "a[aria-label='下一页']",
      "button[aria-label='Next page']", ".btn-next", ".ant-pagination-next",
      ".pagination-next", "[class*='pagination'] a", "[class*='pagination'] button",
      "[class*='pagination'] li", "[class*='page-box'] a"
    ];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (!node.getClientRects().length || node.disabled || node.getAttribute("aria-disabled") === "true" ||
            node.closest(".disabled, .is-disabled, [aria-disabled='true']") || /disabled/.test(node.className || "")) continue;
        const label = clean(node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent);
        if (/^(下一页|下页|next(?: page)?|[>›»])$/i.test(label) ||
            node.matches("a[rel='next'], .btn-next, .ant-pagination-next, .pagination-next")) return node;
      }
    }
    return null;
  }

  function pageSignature(platform) {
    return collect(platform).map(job => `${job.title}|${job.company}|${job.location}`).sort().join("\n");
  }

  async function advanceSearchPage(platform) {
    const button = nextPageButton();
    if (!button) return false;
    const signature = pageSignature(platform);
    button.click();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(700);
      if (blockedPageReason()) return false;
      const changed = pageSignature(platform);
      if (changed && changed !== signature) return true;
    }
    return false;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "ZHIDE_COLLECT_JOBS") return false;
    const platform = currentPlatform();
    if (!platform) {
      sendResponse({ ok: false, error: "当前页面不是智联招聘或 BOSS 直聘。" });
      return false;
    }
    scrollAndCollect(platform, Boolean(message.autoScroll))
      .then(jobs => sendResponse({ ok: true, platform, jobs, url: location.href, pageTitle: document.title }))
      .catch(error => sendResponse({ ok: false, error: error.message || "采集失败" }));
    return true;
  });

  async function sendRadarSkip(sessionId, taskId) {
    return radarRequest("/api/radar/skip", { sessionId, taskId });
  }

  function blockedPageReason() {
    const title = clean(document.title || "");
    const text = clean(document.body?.innerText || "").slice(0, 8000);
    const haystack = `${title} ${text}`;
    if (/(安全验证|验证码|滑动验证|人机验证|请完成验证|captcha)/i.test(haystack)) {
      return "招聘网站弹出了安全验证，需要你手动完成一次验证后继续";
    }
    if (/(扫码登录|立即登录|请登录|登录后才能|账号登录)/i.test(haystack) && /(智联|BOSS|zhaopin|zhipin)/i.test(haystack)) {
      return "当前页面需要登录招聘网站后才能继续采集，请先完成登录";
    }
    return null;
  }

  async function collectWithRetry(platform, attempts) {
    let jobs = [];
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      jobs = await scrollAndCollect(platform, true);
      if (jobs.length || blockedPageReason()) return jobs;
      if (attempt < attempts) {
        showRadarStatus(`第 ${attempt} 次未识别到岗位，稍后自动重试…`);
        await wait(4000 * attempt);
      }
    }
    return jobs;
  }

  function collectCurrentJobDetail(platform) {
    const selectors = platform === "boss"
      ? [".job-sec-text", ".job-detail-section", ".job-detail", "[class*='job-detail']", "[class*='job-description']"]
      : [".describtion__detail-content", ".job-detail", "[class*='job-detail']", "[class*='description']", "[class*='job-content']"];
    const sections = [];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const value = clean(node.innerText || node.textContent);
        if (value.length >= 80 && value.length <= 12000) sections.push(value);
      }
    }
    let description = uniq(sections).sort((left, right) => right.length - left.length)[0] || "";
    if (description.length < 120) {
      const body = clean(document.body?.innerText || "");
      const marker = body.search(/职位描述|岗位职责|工作职责|职位要求|任职要求/);
      if (marker >= 0) description = body.slice(marker, marker + 6000);
    }
    const meta = metaFrom(description);
    const tagNodes = document.querySelectorAll("[class*='tag'] span, [class*='skill'] span, [class*='label']");
    const tags = uniq([...tagNodes].map(node => node.textContent))
      .filter(item => item.length >= 2 && item.length <= 30)
      .slice(0, 16);
    return {
      description: description.slice(0, 6000),
      tags,
      education: meta.education,
      experience: meta.experience
    };
  }

  async function reportRadarBlocked(sessionId, taskId, reason) {
    return radarRequest("/api/radar/blocked", { sessionId, taskId, reason });
  }

  async function continueRadar(nextTask, completed, total) {
    if (!nextTask?.url) {
      showRadarStatus(`岗位雷达已完成 ${completed}/${total} 组搜索，正在统一匹配。`, "done");
      return;
    }
    showRadarStatus(`已完成 ${completed}/${total} 组，正在切换到「${nextTask.query}」…`);
    await wait(1200);
    location.assign(nextTask.url);
  }

  async function runRadar() {
    if (radarRunning || Date.now() < nextRadarCheckAt) return;
    const platform = currentPlatform();
    if (!platform) return;
    radarRunning = true;
    try {
      const active = await radarRequest("/api/radar/active");
      let radar = active.radar;
      const task = radar?.currentTask;
      if (!active.sessionId || !task) return;
      const submittedKey = `zhideRadarLastSubmitted:${active.sessionId}`;
      const submittedTask = sessionStorage.getItem(submittedKey);
      if (radar.active && submittedTask && submittedTask !== task.id && !taskMatchesPage(task)) {
        pendingCapture = null;
        sessionStorage.setItem(submittedKey, "");
        await continueRadar(task, radar.completed, radar.total);
        return;
      }
      if (pendingCapture && pendingCapture.sessionId !== active.sessionId) pendingCapture = null;
      if (pendingCapture && pendingCapture.radarTaskId !== task.id) {
        pendingCapture = null;
        if (radar.active) await continueRadar(task, radar.completed, radar.total);
        return;
      }
      const ownedKey = `zhideRadarOwnedTask:${active.sessionId}`;
      const ownsTask = sessionStorage.getItem(ownedKey) === task.id;
      const matches = taskMatchesPage(task);
      if (!matches && !ownsTask) return;
      const pageReady = task.type === "detail"
        ? collectCurrentJobDetail(platform).description.length >= 120
        : collect(platform).length > 0;
      const blockReason = blockedPageReason();
      if (radar.active && blockReason && !pageReady) {
        await reportRadarBlocked(active.sessionId, task.id, blockReason);
        showRadarStatus(blockReason, "error");
        return;
      }
      if (radar.status === "paused_blocked") {
        if (!pageReady || blockReason) return;
        const resumed = await radarRequest("/api/radar/resume", { sessionId: active.sessionId });
        radar = resumed.radar;
        showRadarStatus("页面已恢复，正在自动继续采集…");
      }
      if (!radar?.active) return;
      if (!matches) {
        await continueRadar(task, radar.completed, radar.total);
        return;
      }
      sessionStorage.setItem(ownedKey, task.id);
      showRadarStatus(`岗位雷达 ${radar.completed + 1}/${radar.total}：正在采集「${task.query}」`);
      let result;
      if (task.type === "detail") {
        const detail = collectCurrentJobDetail(platform);
        if (detail.description.length < 120) {
          const reason = blockedPageReason();
          if (reason) {
            const blocked = await reportRadarBlocked(active.sessionId, task.id, reason);
            if (blocked?.ok) {
              showRadarStatus(reason, "error");
              return;
            }
          }
        }
        result = await radarRequest("/api/extension/collect", {
          platform, detail, sessionId: active.sessionId,
          url: location.href, pageTitle: document.title, radarTaskId: task.id
        });
      } else {
        const jobs = pendingCapture?.jobs || await collectWithRetry(platform, 3);
        if (!jobs.length) {
          const reason = blockedPageReason();
          if (reason) {
            const blocked = await reportRadarBlocked(active.sessionId, task.id, reason);
            if (blocked?.ok) {
              showRadarStatus(reason, "error");
              return;
            }
          }
          result = await sendRadarSkip(active.sessionId, task.id);
        } else {
          const pageNumber = Number(task.pagesCollected || 0) + 1;
          const maxPages = Math.min(3, Number(task.maxPages || 3));
          pendingCapture ||= {
            platform, jobs, sessionId: active.sessionId,
            url: location.href, pageTitle: document.title, radarTaskId: task.id,
            pageNumber, continueSearch: pageNumber < maxPages &&
              Number(task.collected || 0) + jobs.length < 120 && Boolean(nextPageButton())
          };
          result = await radarRequest("/api/extension/collect", pendingCapture);
          const continuing = pendingCapture.continueSearch && result.nextTask?.id === task.id;
          pendingCapture = null;
          if (continuing) {
            showRadarStatus(`「${task.query}」已采集 ${result.radar.currentTask.pagesCollected} 页，正在打开下一页…`);
            if (await advanceSearchPage(platform)) {
              radarFailures = 0;
              nextRadarCheckAt = Date.now() + 1000;
              return;
            }
            const reason = blockedPageReason();
            if (reason) {
              await reportRadarBlocked(active.sessionId, task.id, reason);
              showRadarStatus(reason, "error");
              return;
            }
            result = await sendRadarSkip(active.sessionId, task.id);
          }
        }
      }
      radarFailures = 0;
      await continueRadar(result.nextTask, result.radar?.completed || radar.completed + 1, result.radar?.total || radar.total);
    } catch (error) {
      radarFailures += 1;
      const delay = Math.min(60000, 6000 * 2 ** Math.min(radarFailures - 1, 4));
      nextRadarCheckAt = Date.now() + delay;
      showRadarStatus(`连接暂时中断，${Math.round(delay / 1000)} 秒后自动重试：${error.message || "采集失败"}`, "error");
    } finally { radarRunning = false; }
  }

  wait(1800).then(runRadar);
  setInterval(runRadar, 6000);
})();
