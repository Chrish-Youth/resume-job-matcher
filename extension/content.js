(() => {
  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  const uniq = values => [...new Set(values.map(clean).filter(Boolean))];
  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

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
    if (autoScroll) {
      const originalY = window.scrollY;
      for (let index = 0; index < 4; index += 1) {
        window.scrollBy({ top: Math.max(window.innerHeight * 0.85, 650), behavior: "smooth" });
        await new Promise(resolve => setTimeout(resolve, 700));
      }
      window.scrollTo({ top: originalY, behavior: "smooth" });
    }
    return collect(platform);
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
    const response = await fetch("http://127.0.0.1:8765/api/radar/skip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, taskId })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "无法跳过当前搜索任务。");
    return data;
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
      if (jobs.length) return jobs;
      if (attempt < attempts) {
        showRadarStatus(`第 ${attempt} 次未识别到岗位，稍后自动重试…`);
        await wait(4000 * attempt);
      }
    }
    return jobs;
  }

  async function reportRadarBlocked(sessionId, taskId, reason) {
    try {
      const response = await fetch("http://127.0.0.1:8765/api/radar/blocked", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, taskId, reason })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "阻塞上报失败。");
      return data;
    } catch (error) {
      showRadarStatus(`无法连接本地助手：${error.message || "请检查应用是否在运行"}`, "error");
      return null;
    }
  }

  async function watchRadarResume() {
    const platform = currentPlatform();
    if (!platform) return;
    let active;
    try {
      const response = await fetch("http://127.0.0.1:8765/api/radar/active", { cache: "no-store" });
      if (!response.ok) return;
      active = await response.json();
    } catch {
      return;
    }
    const radar = active.radar;
    const task = radar?.currentTask;
    if (!active.sessionId || !radar?.active || !task) return;
    const blockedKey = `zhideRadarBlocked:${active.sessionId}:${task.id}`;
    if (!sessionStorage.getItem(blockedKey)) return;
    sessionStorage.removeItem(blockedKey);
    showRadarStatus(`雷达已恢复，正在重新进入「${task.query}」…`);
    await wait(800);
    location.assign(task.url);
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
    const platform = currentPlatform();
    if (!platform) return;
    await wait(1800);
    let activeResponse;
    try {
      activeResponse = await fetch("http://127.0.0.1:8765/api/radar/active", { cache: "no-store" });
    } catch {
      return;
    }
    if (!activeResponse.ok) return;
    const active = await activeResponse.json();
    const radar = active.radar;
    const task = radar?.currentTask;
    if (!active.sessionId || !radar?.active || !task || task.platform !== platform) return;
    let readableUrl = location.href.toLowerCase();
    try { readableUrl = decodeURIComponent(location.href).toLowerCase(); } catch { /* 保留编码后的地址 */ }
    if (!readableUrl.includes(String(task.query || "").toLowerCase())) return;
    const runKey = `zhideRadar:${active.sessionId}:${task.id}`;
    if (sessionStorage.getItem(runKey)) return;
    sessionStorage.setItem(runKey, "1");
    showRadarStatus(`岗位雷达 ${radar.completed + 1}/${radar.total}：正在采集「${task.query}」`);
    try {
      const jobs = await collectWithRetry(platform, 3);
      let result;
      if (!jobs.length) {
        const reason = blockedPageReason();
        if (reason) {
          const blocked = await reportRadarBlocked(active.sessionId, task.id, reason);
          if (blocked?.ok) {
            sessionStorage.removeItem(runKey);
            sessionStorage.setItem(`zhideRadarBlocked:${active.sessionId}:${task.id}`, "1");
            showRadarStatus(reason, "error");
            return;
          }
        }
        result = await sendRadarSkip(active.sessionId, task.id);
      } else {
        const response = await fetch("http://127.0.0.1:8765/api/extension/collect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            platform,
            jobs,
            url: location.href,
            pageTitle: document.title,
            radarTaskId: task.id
          })
        });
        result = await response.json();
        if (!response.ok) throw new Error(result.error || "岗位回传失败。");
      }
      await continueRadar(result.nextTask, result.radar?.completed || radar.completed + 1, result.radar?.total || radar.total);
    } catch (error) {
      sessionStorage.removeItem(runKey);
      showRadarStatus(`岗位雷达暂停：${error.message || "采集失败"}`, "error");
    }
  }

  runRadar();
  setInterval(watchRadarResume, 6000);
})();
