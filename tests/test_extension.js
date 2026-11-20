const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../extension/content.js"), "utf8");

async function harness(options = {}) {
  let clock = 100000;
  let page = 0;
  let blocked = Boolean(options.blocked);
  let activeFailures = options.activeFailures || 0;
  let collectFailures = options.collectFailures || 0;
  let acceptedPages = 0;
  let status = options.status || "running";
  const requests = [];
  const intervals = [];
  const sessionId = "capture_browser_test";
  const location = {
    hostname: options.hostname || "sou.zhaopin.com",
    href: options.url || "https://sou.zhaopin.com/?kw=%E4%B8%8A%E6%B5%B7%20%E6%95%B0%E6%8D%AE%E8%BF%90%E8%90%A5&kt=3",
    assign(url) { this.href = url; },
  };
  const task = {
    id: "radar-test-one", type: "search", platform: options.platform || "zhaopin",
    query: "数据运营", url: options.taskUrl || location.href, maxPages: 3,
  };
  const progress = () => ({
    status, active: status === "running", completed: 0, total: 1,
    currentTask: status === "running" || status === "paused_blocked"
      ? { ...task, pagesCollected: acceptedPages, collected: acceptedPages } : null,
  });
  const textNode = text => ({ textContent: text });
  const cards = () => {
    if (blocked) return [];
    const title = `数据运营${page + 1}`;
    const card = {
      innerText: `${title} 测试企业 上海 8-12K 本科 经验不限`,
      querySelector(selector) {
        if (/job-name/.test(selector)) return textNode(title);
        if (/company-name/.test(selector)) return textNode("测试企业");
        if (/salary/.test(selector)) return textNode("8-12K");
        if (/location|job-area/.test(selector)) return textNode("上海");
        return null;
      },
      querySelectorAll() { return []; },
    };
    return [{
      textContent: title, href: `https://www.zhaopin.com/jobdetail/test-${page + 1}.htm`,
      getAttribute() { return null; }, closest() { return card; }, parentElement: card,
    }];
  };
  const nextButton = {
    textContent: "下一页", className: "btn-next", disabled: false,
    getAttribute() { return null; }, closest() { return null; },
    getClientRects() { return [{}]; }, matches() { return true; },
    click() { page += 1; },
  };
  const statusNode = { style: {}, textContent: "" };
  const document = {
    title: "智联招聘", body: {},
    documentElement: { scrollHeight: 900, appendChild() {} },
    createElement() { return { style: {} }; },
    querySelector(selector) { return selector === "#zhide-radar-status" ? statusNode : null; },
    querySelectorAll(selector) {
      if (selector.includes("/jobdetail/") || selector.includes("/job_detail/")) return cards();
      if (selector === ".btn-next" && page < (options.pages || 3) - 1 && !blocked) return [nextButton];
      return [];
    },
  };
  Object.defineProperty(document.body, "innerText", { get: () => blocked ? "智联招聘 请完成验证码 安全验证" : "公开岗位列表" });
  const storage = new Map([[`zhideRadar:${sessionId}:${task.id}`, "1"]]);
  if (options.owned) storage.set(`zhideRadarOwnedTask:${sessionId}`, task.id);
  const sandbox = {
    document, location, URL, AbortController, console,
    Date: class extends Date { static now() { return clock; } },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    window: { innerHeight: 800, scrollY: 0, scrollBy() { this.scrollY = 500; }, scrollTo() { this.scrollY = 0; } },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    setInterval(fn) { intervals.push(fn); return intervals.length; },
    setTimeout(fn, milliseconds) {
      if (milliseconds < 10000) queueMicrotask(fn);
      return 1;
    },
    clearTimeout() {},
    async fetch(url, request) {
      const payload = request.body ? JSON.parse(request.body) : undefined;
      requests.push({ url, payload });
      if (url.endsWith("/api/radar/active")) {
        if (activeFailures-- > 0) throw new Error("offline");
        return { ok: true, async json() { return { sessionId, radar: progress() }; } };
      }
      if (url.endsWith("/api/radar/blocked")) status = "paused_blocked";
      if (url.endsWith("/api/radar/resume")) status = "running";
      if (url.endsWith("/api/extension/collect")) {
        acceptedPages = Math.max(acceptedPages, payload.pageNumber);
        if (!payload.continueSearch) status = "finalizing";
        if (collectFailures-- > 0) throw new Error("response lost after acceptance");
      }
      const radar = progress();
      return { ok: true, async json() { return { ok: true, radar, nextTask: radar.currentTask }; } };
    },
  };
  vm.runInNewContext(source, sandbox);
  for (let round = 0; round < 4; round += 1) await new Promise(resolve => setImmediate(resolve));
  return {
    requests, statusNode,
    setBlocked(value) { blocked = value; },
    async tick(milliseconds = 6000) { clock += milliseconds; await intervals[0](); },
    get page() { return page; },
  };
}

test("radar accumulates three pages, ignoring an old permanent run marker", async () => {
  const runtime = await harness();
  await runtime.tick();
  await runtime.tick();
  const collected = runtime.requests.filter(item => item.url.endsWith("/api/extension/collect"));
  assert.deepEqual(collected.map(item => item.payload.pageNumber), [1, 2, 3]);
  assert.deepEqual(collected.map(item => item.payload.continueSearch), [true, true, false]);
  assert.equal(runtime.page, 2);
});

test("transient network failure recovers automatically after backoff", async () => {
  const runtime = await harness({ activeFailures: 1, pages: 1 });
  assert.match(runtime.statusNode.textContent, /自动重试/);
  await runtime.tick(1000);
  assert.equal(runtime.requests.length, 1);
  await runtime.tick(5000);
  assert.equal(runtime.requests.filter(item => item.url.endsWith("/api/extension/collect")).length, 1);
});

test("a lost response resends the same page rather than skipping the next one", async () => {
  const runtime = await harness({ collectFailures: 1 });
  await runtime.tick();
  await runtime.tick();
  await runtime.tick();
  const pages = runtime.requests.filter(item => item.url.endsWith("/api/extension/collect")).map(item => item.payload.pageNumber);
  assert.deepEqual(pages, [1, 1, 2, 3]);
});

test("captcha pauses collection and visible jobs resume it after user completes verification", async () => {
  const runtime = await harness({ blocked: true, pages: 1 });
  assert.equal(runtime.requests.filter(item => item.url.endsWith("/api/extension/collect")).length, 0);
  await runtime.tick();
  assert.equal(runtime.requests.filter(item => item.url.endsWith("/api/radar/resume")).length, 0);
  runtime.setBlocked(false);
  await runtime.tick();
  assert.equal(runtime.requests.filter(item => item.url.endsWith("/api/radar/resume")).length, 1);
  assert.equal(runtime.requests.filter(item => item.url.endsWith("/api/extension/collect")).length, 1);
});

test("a manually paused radar stays paused", async () => {
  const runtime = await harness({ status: "paused" });
  await runtime.tick();
  assert.equal(runtime.requests.filter(item => item.payload).length, 0);
});

test("redirecting to verification pauses instead of repeatedly reloading the job search", async () => {
  const runtime = await harness({
    blocked: true, owned: true,
    url: "https://sou.zhaopin.com/security/verify",
    taskUrl: "https://sou.zhaopin.com/?kw=上海%20数据运营&kt=3",
  });
  assert.equal(runtime.requests.filter(item => item.url.endsWith("/api/radar/blocked")).length, 1);
  await runtime.tick();
  assert.equal(runtime.requests.filter(item => item.url.endsWith("/api/radar/resume")).length, 0);
});

test("another city with the same keyword is not collected", async () => {
  const runtime = await harness({
    platform: "boss", hostname: "www.zhipin.com",
    url: "https://www.zhipin.com/web/geek/job?query=数据运营&city=101010100",
    taskUrl: "https://www.zhipin.com/web/geek/job?query=数据运营&city=101020100",
  });
  assert.equal(runtime.requests.filter(item => item.payload).length, 0);
});
