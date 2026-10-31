/**
 * 方案 A（懒加载提升）真机验证 · CDP 驱动
 *
 * 为什么必须用真实 Chrome 而不是 jsdom：
 *   jsdom 没有真实网络栈，也没有浏览器的「已解码位图缓存」。
 *   本脚本要验证的核心命题恰恰是「命中缓存 → 零请求」——
 *   只有真浏览器能证明这一点。
 *
 * 验证链路：
 *   1. 注入 web-image-viewer.user.js（模拟油猴环境，GM_* 打桩）
 *   2. 页面初始：img 仅有 data-src（src 为占位）
 *   3. 滚动 → 脚本的 IntersectionObserver 触发 → 提升 data-src → src
 *   4. 断言：src 已变成真图地址，且网络层确实发起了请求（页面自己加载了）
 *   5. ★ 关键断言：提升完成后再走 new Image() 取图路径，
 *      **新增网络请求数应为 0** —— 这正是方案 A 的价值
 *
 * 依赖：Chrome 可执行文件 + Node 内置 WebSocket（Node 22+）
 *
 * 用法：
 *   node verify-lazy-live.js
 *   CHROME_PATH=... node verify-lazy-live.js   # 指定其它 Chrome
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGE = 'file:///' + path.join(ROOT, 'test-lazy.html').replace(/\\/g, '/');
const SCRIPT = path.join(ROOT, 'web-image-viewer.user.js');

/* Chrome 候选路径：环境变量优先，其次常见安装位置 */
function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const bases = [
    'C:\\Users\\lidt\\.agent-browser\\browsers',
    'C:\\Program Files\\Google\\Chrome\\Application',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application'
  ];
  for (const b of bases) {
    if (!b || !fs.existsSync(b)) continue;
    // agent-browser 的版本目录形如 chrome-156.0.8078.80
    const dirs = fs.readdirSync(b);
    for (const d of dirs) {
      for (const rel of ['chrome.exe', 'Application\\chrome.exe']) {
        const p = path.join(b, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
    const direct = path.join(b, 'chrome.exe');
    if (fs.existsSync(direct)) return direct;
  }
  return null;
}

const PORT = 9400 + Math.floor(Math.random() * 300);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
async function waitForChrome() {
  for (let i = 0; i < 60; i++) {
    try {
      const tabs = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
      if (tabs && tabs.length) return tabs;
    } catch (e) {}
    await sleep(500);
  }
  throw new Error('Chrome 调试端口未就绪');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    const onMsg = raw => {
      const msg = JSON.parse(typeof raw === 'string' ? raw : raw.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      }
    };
    if (typeof ws.addEventListener === 'function') ws.addEventListener('message', onMsg);
    else ws.on('message', onMsg);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); }
      }, 120000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
}

/* 注入脚本：模拟油猴环境 */
const INJECT = (code, promoteOn) => `(() => {
  const store = {};
  window.GM_getValue = (k, d) => (k in store ? store[k] : d);
  window.GM_setValue = (k, v) => { store[k] = v; };
  window.GM_deleteValue = (k) => { delete store[k]; };
  window.GM_addStyle = () => {};
  window.GM_registerMenuCommand = () => {};
  store['config:global'] = { promoteLazy: ${promoteOn ? 'true' : 'false'} };
  try { ${code} } catch (e) { return 'ERR: ' + e.message; }
  return 'OK';
})()`;

/* 滚动 + 等待加载 */
const SCROLL_AND_WAIT = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const total = document.body.scrollHeight;
  for (let y = 0; y <= total; y += 300) { window.scrollTo(0, y); await sleep(110); }
  window.scrollTo(0, 0);
  await sleep(300);
  const t0 = performance.now();
  while (performance.now() - t0 < 25000) {
    const imgs = Array.from(document.querySelectorAll('img'));
    if (imgs.length && imgs.every(i => i.complete && i.naturalWidth > 0)) break;
    await sleep(200);
  }
  await sleep(500);
  return true;
})()`;

/* 页面状态 + 网络证据 */
const CHECK_PAGE = `(() => {
  const imgs = Array.from(document.querySelectorAll('img'));
  const res = performance.getEntriesByType('resource')
    .filter(e => e.initiatorType === 'img' || /\\.(jpg|jpeg|png|gif|webp)(\\?|$)/i.test(e.name));
  return {
    total: imgs.length,
    promoted: imgs.filter(i => (i.getAttribute('src')||'').startsWith('http')).length,
    loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
    imgRequests: res.length,
    imgBytes: res.reduce((s,e)=>s+(e.transferSize||0),0),
    srcs: imgs.map(i => i.getAttribute('src'))
  };
})()`;

/* 模拟图片浏览器取图（脚本 show() 走的正是 new Image() + src 路径） */
const SIMULATE_VIEWER = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const urls = Array.from(document.querySelectorAll('img'))
    .map(i => i.getAttribute('data-src')).filter(Boolean);
  const before = performance.getEntriesByType('resource').length;
  const t0 = performance.now();
  const per = [];
  for (const u of urls) {
    const im = new Image();
    im.referrerPolicy = 'no-referrer';
    const t = performance.now();
    await new Promise(r => { im.onload = r; im.onerror = r; im.src = u; });
    per.push(+(performance.now()-t).toFixed(2));
  }
  const total = performance.now() - t0;
  const fresh = performance.getEntriesByType('resource').slice(before)
    .filter(e => e.initiatorType === 'img');
  return {
    count: urls.length,
    totalMs: +total.toFixed(1),
    avgMs: +(total/Math.max(1,urls.length)).toFixed(2),
    freshRequests: fresh.length,
    freshBytes: fresh.reduce((s,e)=>s+(e.transferSize||0),0),
    perImage: per
  };
})()`;

/** 跑一轮完整实验 */
async function runRound(cdp, code, promoteOn) {
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(500);
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(2200);

  const inj = await cdp.eval(INJECT(code, promoteOn));
  if (inj !== 'OK') throw new Error('注入失败: ' + inj);
  await sleep(1000);

  const cfg = await cdp.eval(`window.__fiv.Config.get('promoteLazy')`);
  await cdp.eval(SCROLL_AND_WAIT);
  const pageState = await cdp.eval(CHECK_PAGE);
  const viewer = await cdp.eval(SIMULATE_VIEWER);
  return { cfg, pageState, viewer };
}

/**
 * 启动一个独立 Chrome 实例。
 *
 * ⚠️ 必须独立 profile：A/B 对照时若共用缓存，第二轮会命中第一轮的
 *    磁盘缓存，测出来全是 0 请求 —— 那是假的。
 */
function launchChrome(tag) {
  const exe = findChrome();
  if (!exe) throw new Error('找不到 Chrome，可设 CHROME_PATH 环境变量指定');
  const userDir = path.join(os.tmpdir(), 'cdp-lazy-' + tag + '-' + Date.now());
  fs.mkdirSync(userDir, { recursive: true });
  const proc = spawn(exe, [
    '--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + userDir, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    '--disk-cache-size=1', '--disable-application-cache', 'about:blank'
  ], { stdio: 'ignore' });
  return { proc, userDir, exe };
}

async function connect() {
  const tabs = await waitForChrome();
  const pg = tabs.find(t => t.type === 'page') || tabs[0];
  const WebSocket = await loadWS();
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('WS 连接失败')));
    } else {
      ws.on('open', res);
      ws.on('error', () => rej(new Error('WS 连接失败')));
    }
  });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return cdp;
}

(async () => {
  const code = fs.readFileSync(SCRIPT, 'utf8');
  const results = {};

  for (const on of [false, true]) {
    const label = on ? '实验组（promoteLazy=true）' : '对照组（promoteLazy=false）';
    console.log('\n' + '='.repeat(58));
    console.log('  ' + label);
    console.log('='.repeat(58));

    const { proc, userDir, exe } = launchChrome(on ? 'on' : 'off');
    let cdp = null;
    try {
      console.log('  Chrome:', exe);
      cdp = await connect();
      const r = await runRound(cdp, code, on);
      results[on ? 'on' : 'off'] = r;

      console.log('  配置读取        :', r.cfg);
      console.log('  —— 页面阶段 ——');
      console.log('    已提升为真图  :', r.pageState.promoted, '/', r.pageState.total);
      console.log('    已加载完成    :', r.pageState.loaded, '/', r.pageState.total);
      console.log('    页面图片请求  :', r.pageState.imgRequests, '个');
      console.log('  —— 图片浏览器阶段 ——');
      console.log('    取图数量      :', r.viewer.count);
      console.log('    新增请求      :', r.viewer.freshRequests, '个');
      console.log('    总耗时        :', r.viewer.totalMs, 'ms   平均', r.viewer.avgMs, 'ms');
    } finally {
      if (cdp) { try { cdp.ws.close(); } catch (e) {} }
      proc.kill();
      await sleep(700);
      try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}
    }
  }

  const off = results.off, on = results.on;
  console.log('\n' + '='.repeat(58));
  console.log('  A/B 对照结论');
  console.log('='.repeat(58));
  console.log('  浏览器器新增请求 : 对照 ' + off.viewer.freshRequests + ' 个  →  实验 ' + on.viewer.freshRequests + ' 个');
  console.log('  浏览器器取图耗时 : 对照 ' + off.viewer.totalMs + ' ms  →  实验 ' + on.viewer.totalMs + ' ms');
  const saved = off.viewer.totalMs - on.viewer.totalMs;
  console.log('  节省耗时         : ' + saved.toFixed(1) + ' ms (' +
    (off.viewer.totalMs > 0 ? (saved / off.viewer.totalMs * 100).toFixed(1) : '0') + '%)');

  /* 断言 */
  const asserts = {
    offNoPromote: off.pageState.promoted === 0,
    onAllPromoted: on.pageState.promoted === on.pageState.total && on.pageState.total > 0,
    onPageLoaded: on.pageState.loaded === on.pageState.total,
    onZeroRequests: on.viewer.freshRequests === 0,
    offHasRequests: off.viewer.freshRequests > 0
  };
  console.log('\n断言：');
  for (const [k, v] of Object.entries(asserts)) {
    console.log('  ' + (v ? '✅' : '❌') + ' ' + k);
  }
  const allPass = Object.values(asserts).every(Boolean);
  console.log('\n' + (allPass ? '🎉 全部断言通过' : '⚠️ 有断言未通过'));
  process.exit(allPass ? 0 : 1);
})().catch(e => { console.error('失败:', e.message); process.exit(1); });

async function loadWS() {
  if (typeof WebSocket !== 'undefined') return WebSocket;
  try { return require('ws'); } catch (e) {}
  throw new Error('找不到 ws 库（Node 22+ 内置 WebSocket 可用）');
}
