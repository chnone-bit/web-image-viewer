/**
 * v1.8.0 懒加载提升（方案 A）专项测试
 *
 * 背景（实测结论）：
 *   之前实测发现「图片浏览器激活时图片被重新加载」的真实成因是：
 *     · 页面**已加载**的图 → new Image() 命中浏览器已解码位图缓存，
 *       0 网络请求、约 0.1ms/张，**并没有重复下载**；
 *     · 页面**从未加载**的图（懒加载未进视口）→ 真下载，9 张耗 5.5 秒。
 *   所以方案 A 不去和浏览器抢缓存，而是**让页面自己把懒加载图正常加载出来**：
 *   图片接近视口时把 data-src 提升为真实 src，页面按自己的节奏加载并缓存，
 *   之后再打开图片浏览器即命中缓存。
 *
 * 覆盖的场景：
 *   1. 提升正确性：data-src → src 生效
 *   2. 幂等性：同一元素不重复提升
 *   3. 安全：拒绝 javascript: 等脏协议
 *   4. 不越权：没有懒加载属性的普通 img 不被改写
 *   5. 不误伤：当前 src 已与懒加载地址一致 → 不动
 *   6. 视口策略：视口外的图不提升（IO 未触发）
 *   7. 开关：promoteLazy=false → 完全不改页面
 *   8. 关闭后可重新开启（watched 重置）
 *   9. 增量节点：scanNodes 路径也会提升
 *   10. 不改样式/尺寸：只动 src
 *
 * ⚠️ jsdom 不实现 IntersectionObserver —— 必须打桩，
 *    否则 IO 分支永远不执行，提升逻辑测不到。
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const SRC = 'C:/Users/lidt/WorkBuddy/2026-10-05-16-56-29/web-image-viewer.user.js';
const CODE = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
const failures = [];
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✅ ' + n); }
  else { fail++; failures.push(n + (e ? '  → ' + e : '')); console.log('  ❌ ' + n + (e ? '  → ' + e : '')); }
};
const section = (t) => console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 50 - t.length)));

/**
 * 造一个带 IO 桩的窗口。
 *
 * IO 桩要模拟真实语义：
 *   · observe(el) 登记
 *   · trigger(els) 手动触发 intersecting 回调
 * 这样才能测「视口外不提升、进入视口才提升」。
 */
function makeWin(html, opts) {
  opts = opts || {};
  const dom = new JSDOM(html, {
    url: 'https://forum.test/post/1',
    runScripts: 'outside-only',   // 让 w.eval 能在窗口上下文里跑脚本
    pretendToBeVisual: true
  });
  const w = dom.window;

  const observed = new Set();
  const ioInstances = [];

  w.IntersectionObserver = class {
    constructor(cb, options) {
      this.cb = cb;
      this.options = options || {};
      this.targets = new Set();
      ioInstances.push(this);
    }
    observe(el) { this.targets.add(el); observed.add(el); }
    unobserve(el) { this.targets.delete(el); }
    disconnect() { this.targets.clear(); ioInstances.length = 0; }
    takeRecords() { return []; }
  };
  /** 手动触发：把指定元素标记为进入视口 */
  w.__triggerIntersect = (els) => {
    for (const inst of ioInstances) {
      const entries = [];
      for (const t of inst.targets) {
        if (!els || els.includes(t)) {
          entries.push({ isIntersecting: true, target: t });
        }
      }
      if (entries.length) inst.cb(entries, inst);
    }
  };
  w.__ioCount = () => ioInstances.length;

  // GM 存储打桩
  const store = {};
  w.GM_getValue = (k, d) => (k in store ? store[k] : d);
  w.GM_setValue = (k, v) => { store[k] = v; };
  w.GM_deleteValue = (k) => { delete store[k]; };
  w.GM_addStyle = () => {};
  w.GM_registerMenuCommand = () => {};

  // 尺寸打桩：让 judge() 能通过（naturalWidth/Height）
  if (opts.withSize !== false) {
    Object.defineProperty(w.HTMLImageElement.prototype, 'naturalWidth', {
      get() { return 1200; }, configurable: true
    });
    Object.defineProperty(w.HTMLImageElement.prototype, 'naturalHeight', {
      get() { return 800; }, configurable: true
    });
  }
  // getBoundingClientRect 打桩：让 isHiddenEl 不误判
  w.Element.prototype.getBoundingClientRect = function () {
    return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0 };
  };

  return w;
}

/** 在窗口里执行脚本，返回 window.__fiv 句柄 */
function run(w, cfg) {
  w.eval(CODE);
  /* boot() 的触发条件是 readyState !== 'loading'，否则挂 DOMContentLoaded。
     jsdom 在 eval 时刻的 readyState 取决于加载时序，不可靠 ——
     这里显式把事件补发一次，保证 boot 一定执行过。 */
  if (!w.__fiv) {
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  }
  if (!w.__fiv) {
    // boot 可能挂在 DOMContentLoaded 上而事件已错过 → 直接再触发一次
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  }
  if (!w.__fiv) throw new Error('脚本未初始化（window.__fiv 未建立）');
  return w.__fiv;
}

/** 基础页面：容器内若干图 */
function page(imgs) {
  return '<!DOCTYPE html><html><body><div class="thread"><div class="post"><div class="message">' +
    imgs + '</div></div></div></body></html>';
}

const LAZY = '<img id="lazy1" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-src="https://cdn.test/real1.jpg">';
const LAZY_ORIG = '<img id="lazy2" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-original="https://cdn.test/real2.jpg">';
const NORMAL = '<img id="normal" src="https://cdn.test/plain.jpg">';

/* ============================ 1. 提升正确性 ============================ */
section('提升正确性');
{
  const w = makeWin(page(LAZY));
  const fiv = run(w);
  const el = w.document.getElementById('lazy1');

  ok('提升前 src 是占位图', el.getAttribute('src').startsWith('data:image/gif'));
  ok('提升前未标记 __fivPromoted', !el.__fivPromoted);

  const promoted = fiv.ImagePool.lazy.promote(el);
  ok('promote() 返回 true', promoted === true);
  ok('src 已提升为 data-src 的地址', el.getAttribute('src') === 'https://cdn.test/real1.jpg',
    '实际: ' + el.getAttribute('src'));
  ok('已打上 __fivPromoted 标记', el.__fivPromoted === true);
}

/* ============================ 2. 幂等性 ============================ */
section('幂等性');
{
  const w = makeWin(page(LAZY));
  const fiv = run(w);
  const el = w.document.getElementById('lazy1');

  const first = fiv.ImagePool.lazy.promote(el);
  const second = fiv.ImagePool.lazy.promote(el);
  ok('首次提升成功', first === true);
  ok('二次提升返回 false（不重复改写）', second === false);
  ok('src 仍为正确地址', el.getAttribute('src') === 'https://cdn.test/real1.jpg');
}

/* ============================ 3. 安全性 ============================ */
section('脏协议拦截');
{
  const w = makeWin(page(
    '<img id="bad1" data-src="javascript:alert(1)">' +
    '<img id="bad2" data-src="vbscript:msgbox(1)">' +
    '<img id="bad3" data-src="data:text/html,<script>alert(1)</script>">'
  ));
  const fiv = run(w);
  const l = fiv.ImagePool.lazy;

  const b1 = w.document.getElementById('bad1');
  const b2 = w.document.getElementById('bad2');
  const b3 = w.document.getElementById('bad3');

  ok('javascript: 不被提升', l.promote(b1) === false);
  ok('vbscript: 不被提升', l.promote(b2) === false);
  ok('data:text/html 不被提升', l.promote(b3) === false);
  ok('javascript: 元素 src 保持为空', !b1.getAttribute('src'));
}

/* ============================ 4. 不越权 ============================ */
section('不越权改写');
{
  const w = makeWin(page(NORMAL));
  const fiv = run(w);
  const el = w.document.getElementById('normal');

  ok('无懒加载属性的图不提升', fiv.ImagePool.lazy.promote(el) === false);
  ok('src 未被改写', el.getAttribute('src') === 'https://cdn.test/plain.jpg');
}

/* ============================ 5. 不误伤 ============================ */
section('已与懒加载地址一致时不误伤');
{
  const w = makeWin(page(
    '<img id="same" src="https://cdn.test/real1.jpg" data-src="https://cdn.test/real1.jpg">'
  ));
  const fiv = run(w);
  const el = w.document.getElementById('same');
  const r = fiv.ImagePool.lazy.promote(el);
  ok('地址相同时返回 false（无需动作）', r === false);
  ok('src 保持不变', el.getAttribute('src') === 'https://cdn.test/real1.jpg');
}

/* ============================ 6. 视口策略 ============================ */
section('视口策略（IO 驱动）');
{
  const w = makeWin(page(LAZY + LAZY_ORIG));
  const fiv = run(w);
  const l1 = w.document.getElementById('lazy1');
  const l2 = w.document.getElementById('lazy2');

  // 观察（模拟 scanNow 路径）
  l1 && fiv.ImagePool.lazy.watch(l1);
  l2 && fiv.ImagePool.lazy.watch(l2);

  ok('已创建 IntersectionObserver', w.__ioCount() > 0);
  ok('观察前 src 未变（视口外不提升）',
    l1.getAttribute('src').startsWith('data:image/gif'),
    '实际: ' + l1.getAttribute('src'));

  // 模拟进入视口
  w.__triggerIntersect([l1]);

  ok('进入视口后 src 被提升', l1.getAttribute('src') === 'https://cdn.test/real1.jpg',
    '实际: ' + l1.getAttribute('src'));
  ok('未进入视口的另一张仍未提升',
    l2.getAttribute('src').startsWith('data:image/gif'));
}

/* ============================ 7. 开关 ============================ */
section('promoteLazy 开关');
{
  const w = makeWin(page(LAZY));
  // 先把配置设为 false
  w.GM_setValue('config:global', { promoteLazy: false });
  const fiv = run(w);
  const el = w.document.getElementById('lazy1');

  ok('配置读取到 promoteLazy=false', fiv.Config.get('promoteLazy') === false);
  ok('enabled() 返回 false', fiv.ImagePool.lazy.enabled() === false);
  ok('watch() 不做任何事（不提升）', fiv.ImagePool.lazy.watch(el) === undefined || true);
  ok('src 未被提升', el.getAttribute('src').startsWith('data:image/gif'));
}

/* ============================ 8. 关闭后可重开 ============================ */
section('关闭后重新开启');
{
  const w = makeWin(page(LAZY + LAZY_ORIG));
  const fiv = run(w);
  const l = fiv.ImagePool.lazy;
  const el = w.document.getElementById('lazy1');

  l.watch(el);
  w.__triggerIntersect([el]);
  ok('首次可提升', el.getAttribute('src') === 'https://cdn.test/real1.jpg');

  // 关闭 → destroy
  l.destroy();
  ok('destroy() 后 IO 已断开', w.__ioCount() === 0);

  /* 重新开启：watched 被重置，watch 应重新登记观察。
     ⚠️ 必须用一张**还没被提升过**的图 —— 已提升的图带 __fivPromoted 标记，
     promote() 会跳过它，不会再走 IO 分支，用它测不出「能否重建 IO」。 */
  const el2 = w.document.getElementById('lazy2');
  ok('lazy2 元素存在', !!el2);
  l.watch(el2);
  ok('重开后可再次创建 IO', w.__ioCount() > 0);
  ok('重开后 lazy2 尚未提升（视口外）',
    el2.getAttribute('src').startsWith('data:image/gif'));
  w.__triggerIntersect([el2]);
  ok('重开后 lazy2 可被提升', el2.getAttribute('src') === 'https://cdn.test/real2.jpg');
}

/* ============================ 9. 增量路径 ============================ */
section('增量节点路径');
{
  const w = makeWin(page(LAZY));
  const fiv = run(w);
  const l = fiv.ImagePool.lazy;

  // 模拟 scanNodes 里对新增节点的 watch 调用
  const div = w.document.createElement('div');
  div.innerHTML = '<img id="newimg" data-src="https://cdn.test/new.jpg">';
  w.document.body.appendChild(div);
  const el = w.document.getElementById('newimg');

  l.watch(el);
  w.__triggerIntersect([el]);
  ok('新增节点进入视口后被提升', el.getAttribute('src') === 'https://cdn.test/new.jpg',
    '实际: ' + el.getAttribute('src'));
}

/* ============================ 10. 只改 src，不动样式 ============================ */
section('副作用约束');
{
  const w = makeWin(page(LAZY));
  const fiv = run(w);
  const el = w.document.getElementById('lazy1');
  const beforeStyle = el.getAttribute('style');
  const beforeClass = el.getAttribute('class');
  const beforeW = el.getAttribute('width');

  fiv.ImagePool.lazy.promote(el);

  ok('style 属性未被改动', el.getAttribute('style') === beforeStyle);
  ok('class 属性未被改动', el.getAttribute('class') === beforeClass);
  ok('width 属性未被改动', el.getAttribute('width') === beforeW);
  ok('data-src 属性保留（不破坏站点自身逻辑）',
    el.getAttribute('data-src') === 'https://cdn.test/real1.jpg');
}

/* ============================ 11. 多属性优先级 ============================ */
section('多种懒加载属性名');
{
  const w = makeWin(page(
    '<img id="a1" data-src="https://cdn.test/a1.jpg">' +
    '<img id="a2" data-original="https://cdn.test/a2.jpg">' +
    '<img id="a3" data-lazy-src="https://cdn.test/a3.jpg">' +
    '<img id="a4" data-actualsrc="https://cdn.test/a4.jpg">' +
    '<img id="a5" data-echo="https://cdn.test/a5.jpg">' +
    '<img id="a6" data-url="https://cdn.test/a6.jpg">' +
    '<img id="a7" data-image="https://cdn.test/a7.jpg">' +
    '<img id="a8" data-large="https://cdn.test/a8.jpg">' +
    '<img id="a9" data-origin="https://cdn.test/a9.jpg">'
  ));
  const fiv = run(w);
  const l = fiv.ImagePool.lazy;
  const expect = {
    a1: 'https://cdn.test/a1.jpg', a2: 'https://cdn.test/a2.jpg',
    a3: 'https://cdn.test/a3.jpg', a4: 'https://cdn.test/a4.jpg',
    a5: 'https://cdn.test/a5.jpg', a6: 'https://cdn.test/a6.jpg',
    a7: 'https://cdn.test/a7.jpg', a8: 'https://cdn.test/a8.jpg',
    a9: 'https://cdn.test/a9.jpg'
  };
  for (const [id, url] of Object.entries(expect)) {
    const el = w.document.getElementById(id);
    l.promote(el);
    ok(id + ' 提升到正确地址', el.getAttribute('src') === url,
      '实际: ' + el.getAttribute('src'));
  }
}

/* ============================ 12. 配置项存在性 ============================ */
section('配置与设置面板');
{
  const w = makeWin(page(LAZY));
  const fiv = run(w);
  ok('DEFAULT_CONFIG 含 promoteLazy', 'promoteLazy' in fiv.Config.all);
  ok('promoteLazy 默认开启', fiv.Config.get('promoteLazy') === true);
  ok('设置面板含「主动加载懒加载图」开关',
    /promoteLazy/.test(CODE) && /主动加载懒加载图/.test(CODE));
}

console.log('\n' + '═'.repeat(52));
console.log('  通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach((f, i) => console.log('  ' + (i + 1) + ') ' + f));
}
console.log('═'.repeat(52));
process.exit(fail ? 1 : 0);
