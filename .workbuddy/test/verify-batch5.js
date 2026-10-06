/**
 * v1.5 第五批专项测试
 *
 * 覆盖：
 *   A. Bug1 悬停角标稳定性
 *      - 鼠标停在包裹层 <a> 上时仍显示（根因：旧 hitImage 只向上找 img）
 *      - <a>/<img> 交替移动不闪没
 *      - 移到图外正确隐藏
 *   B. Bug2 缩略图条拖动 + 点选
 *      - 在缩略图上起拖也能滚动（旧逻辑遇 thumb 直接 return）
 *      - 微动不触发滚动（阈值）
 *      - 滚轮横向滚动
 *      - CSS 不得使用 scroll-behavior: smooth（否则每帧赋值互相覆盖）
 *      - 【v1.5.1 修复】纯点击缩略图必须能切图
 *        （根因：pointerdown 时无条件 setPointerCapture，
 *          导致 pointerup/click 被重定向到 strip，thumb 的 click 永不触发）
 *   C. 分组枚举（ImagePool.groups）
 *   D. 组间连续浏览
 *      - 组尾 navNext 跨到下一组
 *      - 组首 navPrev 跨到上一组
 *      - groupChaining 关闭时不跨组
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const SRC = 'C:/Users/lidt/WorkBuddy/2026-10-05-16-56-29/web-image-viewer.user.js';
const CODE = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✅ ' + n)) : (fail++, console.log('  ❌ ' + n + (e ? '  → ' + e : ''))); };

const THREE_GROUPS = '<div class="thread">'
  + '<div class="post" id="post1"><div class="message" id="mA"><img id="A1" src="https://x.com/a1.jpg"><img id="A2" src="https://x.com/a2.jpg"></div></div>'
  + '<div class="post" id="post2"><div class="message" id="mB"><img id="B1" src="https://x.com/b1.jpg"><img id="B2" src="https://x.com/b2.jpg"><img id="B3" src="https://x.com/b3.jpg"></div></div>'
  + '<div class="post" id="post3"><div class="message" id="mC"><img id="C1" src="https://x.com/c1.jpg"><img id="C2" src="https://x.com/c2.jpg"></div></div>'
  + '</div>';

const WRAPPED = '<div class="thread">'
  + '<div class="post" id="p1"><div class="message" id="mA">'
  + '<a href="https://x.com/a1.jpg" class="zoom"><img id="A1" src="https://x.com/a1.jpg"></a>'
  + '<a href="https://x.com/a2.jpg" class="zoom"><img id="A2" src="https://x.com/a2.jpg"></a>'
  + '</div></div>'
  + '<div class="post" id="p2"><div class="message" id="mB"><img id="B1" src="https://x.com/b1.jpg"><img id="B2" src="https://x.com/b2.jpg"></div></div>'
  + '</div>';

function withPage(html) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>' + html + '</body></html>',
    { url: 'https://forum.example.com/t.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  Object.defineProperty(w.HTMLImageElement.prototype, 'naturalWidth', { get() { return 1200; }, configurable: true });
  Object.defineProperty(w.HTMLImageElement.prototype, 'naturalHeight', { get() { return 800; }, configurable: true });
  w.Element.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 600, bottom: 600, width: 600, height: 600, x: 0, y: 0 };
  };
  w.getComputedStyle = () => ({
    backgroundImage: 'none', display: 'block', visibility: 'visible', opacity: '1',
    getPropertyValue() { return ''; }
  });
  w.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.Element.prototype.scrollIntoView = function () {};
  w.scrollTo = () => {};
  w.console.error = () => {};
  w.console.warn = () => {};
  if (!w.PointerEvent) {
    w.PointerEvent = class extends w.MouseEvent {
      constructor(t, o = {}) { super(t, o); this.pointerId = o.pointerId || 1; this.pointerType = o.pointerType || 'mouse'; this.button = o.button || 0; }
    };
  }
  w.Element.prototype.setPointerCapture = function () {};
  w.Element.prototype.releasePointerCapture = function () {};
  w.eval(CODE);
  return new Promise((resolve) => setTimeout(() => resolve({
    w,
    P: w.__fiv.ImagePool,
    V: w.__fiv.Viewer,
    C: w.__fiv.Config
  }), 400));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* ============ A. Bug1 悬停角标 ============ */
  console.log('\n【Bug1】角标：鼠标停在包裹层 <a> 上也要显示');
  {
    const { w } = await withPage(WRAPPED);
    const img = w.document.getElementById('A1');
    const a = img.parentElement;
    const fire = (t, x, y) => {
      const ev = new w.MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y });
      Object.defineProperty(ev, 'target', { value: t, configurable: true });
      t.dispatchEvent(ev);
    };
    fire(a, 300, 300);
    const badge = w.document.querySelector('.fiv-badge');
    ok('停在 <a> 上角标已创建', !!badge);
    ok('停在 <a> 上角标显示', !!badge && badge.classList.contains('fiv-on'),
      badge ? badge.className : '无');
    // 交替 <a>/<img>（真实鼠标在图片边缘微动）
    for (let i = 0; i < 6; i++) fire(i % 2 ? img : a, 300 + i, 300 + i);
    ok('交替 a/img 后仍显示', badge.classList.contains('fiv-on'));
    // 移到图外
    fire(w.document.body, 5, 5);
    await sleep(220);
    ok('移到图外正确隐藏', !badge.classList.contains('fiv-on'));
  }

  console.log('\n【Bug1】角标：同图连续微动不闪');
  {
    const { w } = await withPage(WRAPPED);
    const img = w.document.getElementById('A1');
    const fire = (t, x, y) => {
      const ev = new w.MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y });
      Object.defineProperty(ev, 'target', { value: t, configurable: true });
      t.dispatchEvent(ev);
    };
    fire(img, 100, 100);
    const badge = w.document.querySelector('.fiv-badge');
    ok('首次悬停显示', badge.classList.contains('fiv-on'));
    for (let i = 0; i < 10; i++) fire(img, 100 + i * 2, 100 + i);
    ok('10 帧微动后仍显示', badge.classList.contains('fiv-on'));
    // 移出又立刻移回（<140ms 的 scheduleHide 应被 show 取消）
    fire(w.document.body, 5, 5);
    fire(img, 100, 100);
    await sleep(200);
    ok('移出后 140ms 内移回，保持显示', badge.classList.contains('fiv-on'));
  }

  /* ============ B. Bug2 缩略图条拖动 ============ */
  console.log('\n【Bug2】缩略图条：在缩略图上起拖也能滚动');
  {
    const { w, V } = await withPage(THREE_GROUPS);
    V.openAt(0);
    await sleep(120);
    const strip = w.document.querySelector('.fiv-strip');
    const track = w.document.querySelector('.fiv-track');
    const thumb = w.document.querySelector('.fiv-thumb');
    let sl = 0;
    Object.defineProperty(track, 'scrollLeft', { get: () => sl, set: (v) => { sl = v; }, configurable: true });
    const P = (t, type, x) => {
      const e = new w.PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 500, pointerId: 1, pointerType: 'mouse', button: 0 });
      Object.defineProperty(e, 'target', { value: t, configurable: true });
      t.dispatchEvent(e);
    };
    P(thumb, 'pointerdown', 400);
    // ⚠️ 断言已修正（v1.5.2）：按下时**不应**进入拖拽态。
    //    旧断言「按下即进入拖拽态」实际上在固化一个 bug：
    //    .fiv-dragging 会让 .fiv-thumb pointer-events:none，
    //    导致松手时浏览器 click 命中测试失败 → 缩略图永远点不动。
    ok('按下时尚未进入拖拽态（避免 pointer-events:none 杀掉 click）',
      !strip.classList.contains('fiv-dragging'),
      strip.classList.contains('fiv-dragging') ? '已加 dragging 类' : '');
    P(thumb, 'pointermove', 250);
    ok('越阈值后进入拖拽态', strip.classList.contains('fiv-dragging'));
    ok('在缩略图上拖动产生滚动', sl === 150, 'scrollLeft=' + sl);
    P(thumb, 'pointerup', 250);
    ok('松手退出拖拽态', !strip.classList.contains('fiv-dragging'));

    // 微动不触发
    sl = 0;
    P(strip, 'pointerdown', 400);
    P(strip, 'pointermove', 399);
    P(strip, 'pointerup', 399);
    ok('1px 微动不算拖动', sl === 0, 'scrollLeft=' + sl);

    // 滚轮
    sl = 0;
    const we = new w.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120, deltaX: 0 });
    Object.defineProperty(we, 'target', { value: track, configurable: true });
    strip.dispatchEvent(we);
    ok('滚轮横向滚动', sl === 120, 'scrollLeft=' + sl);
  }

  /* ==== Bug2-回归：点选必须可用（真实浏览器指针捕获语义） ==== */
  console.log('\n【Bug2-回归】缩略图点选（模拟真实浏览器指针捕获）');
  {
    const { w, V } = await withPage(THREE_GROUPS);
    V.openAt(0);
    await sleep(120);
    const thumbs = w.document.querySelectorAll('.fiv-thumb');
    const strip = w.document.querySelector('.fiv-strip');
    const track = w.document.querySelector('.fiv-track');
    let sl = 0;
    Object.defineProperty(track, 'scrollLeft', { get: () => sl, set: (v) => { sl = v; }, configurable: true });
    // 关键：真实浏览器在捕获生效后，会把事件重定向到捕获元素
    Object.defineProperty(strip, '__capture', { value: null, writable: true, configurable: true });
    strip.setPointerCapture = function () { strip.__capture = this; };
    strip.releasePointerCapture = function () { strip.__capture = null; };

    const target = (t) => (strip.__capture || t);

    /* ---- 模拟真实浏览器的 click 目标解析 ----
     * 真实浏览器 click 的 target = pointerdown 命中元素 ∩ pointerup 命中元素
     * 的「最近公共祖先」。
     *
     * 这解释了 Bug1 的真实机制：
     *   pointerdown 时 .fiv-dragging 已加 → thumb 是 pointer-events:none
     *     → 按下命中测试落到 strip（thumb 被跳过）
     *   pointerup 时 finish() 已移除 .fiv-dragging → 松手命中 thumb
     *   两者公共祖先 = strip  → click 派发到 strip
     *   → 缩略图自身的 click 监听器**永不触发** = 「点不动」
     *
     * jsdom 不实现这一层，必须手工模拟，否则该 bug 会溜过测试。 */
    const isPEThumb = (el) => el && el.classList && el.classList.contains('fiv-thumb');
    // 返回该点在给定 dragging 状态下「命中」的元素
    const hitAt = (t, dragging) => {
      if (isPEThumb(t) && dragging) return strip;   // thumb 被 pointer-events:none 跳过
      return t;
    };
    // 最近公共祖先
    const ancestorOrSelf = (el, maybeAnc) => {
      let n = el;
      while (n) { if (n === maybeAnc) return maybeAnc; n = n.parentNode; }
      return null;
    };
    const commonAncestor = (a, b) => {
      let n = a;
      while (n) { if (ancestorOrSelf(b, n)) return n; n = n.parentNode; }
      return null;
    };
    // 记录按下时的 dragging 状态，用于解析 click target
    let draggingAtDown = false;
    const resolveClickTarget = (t) => commonAncestor(hitAt(t, draggingAtDown), hitAt(t, false)) || t;

    const PD = (t, x) => {
      const e = new w.PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: 500, pointerId: 1, pointerType: 'mouse', button: 0 });
      Object.defineProperty(e, 'target', { value: target(t), configurable: true });
      target(t).dispatchEvent(e);
      // ⚠️ 派发之后再读：pointerdown 处理器可能刚刚加上了 .fiv-dragging。
      //    浏览器做按下命中测试的时刻，正是处理器执行完毕后的状态。
      draggingAtDown = strip.classList.contains('fiv-dragging');
    };
    const PU = (t, x) => {
      const e = new w.PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: 500, pointerId: 1, pointerType: 'mouse', button: 0 });
      Object.defineProperty(e, 'target', { value: target(t), configurable: true });
      target(t).dispatchEvent(e);
    };
    const CLICK = (t) => {
      // 真实浏览器：click target 由按下/松手命中共同决定
      const real = strip.__capture ? strip : resolveClickTarget(target(t));
      CLICK.__target = real;
      const e = new w.MouseEvent('click', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'target', { value: real, configurable: true });
      real.dispatchEvent(e);
    };

    // 1) 纯点击第 3 张 → 应切到 index 2
    const before = V.index;
    PD(thumbs[2], 300);
    ok('纯点击：按下时不捕获指针（否则 click 会被重定向）', strip.__capture === null,
      strip.__capture ? '已捕获' : '');
    PU(thumbs[2], 300);
    CLICK(thumbs[2]);
    ok('纯点击：click 目标仍是缩略图本身（按下时未被 pointer-events:none 跳过）',
      CLICK.__target === thumbs[2],
      'click target = ' + (CLICK.__target === thumbs[2] ? 'thumb' : CLICK.__target.className));
    await sleep(60);
    ok('纯点击缩略图能切图（bug: 点不动）', V.index === 2, 'index=' + V.index + ' (before ' + before + ')');

    // 2) 拖动后不应切图（click 被吞）
    sl = 0;
    const idxAfterClick = V.index;
    PD(thumbs[0], 500);
    const pm = new w.PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: 350, clientY: 500, pointerId: 1, pointerType: 'mouse', button: 0 });
    Object.defineProperty(pm, 'target', { value: target(thumbs[0]), configurable: true });
    target(thumbs[0]).dispatchEvent(pm);
    ok('拖动：越过阈值后才捕获指针', strip.__capture === strip, strip.__capture ? '已捕获' : '未捕获');
    PU(thumbs[0], 350);
    CLICK(thumbs[0]);
    await sleep(60);
    ok('拖动后不误切图（click 被吞）', V.index === idxAfterClick, 'index=' + V.index);
  }

  console.log('\n【Bug2】CSS 不得用 scroll-behavior: smooth');
  {
    const trackRule = CODE.match(/\.\$\{NS\}-track\s*\{[^}]*\}/);
    ok('track 规则存在', !!trackRule);
    // 注释里可能提到 "smooth"（解释为什么不用的原因），断言只看声明本体
    const decl = trackRule ? trackRule[0].replace(/\/\*[\s\S]*?\*\//g, '') : '';
    ok('track 未使用 smooth', !!trackRule && !/scroll-behavior:\s*smooth/.test(decl),
      decl.replace(/\s+/g, ' ').slice(0, 90));
    ok('track 显式 auto', !!trackRule && /scroll-behavior:\s*auto/.test(decl));
    ok('拖拽时缩略图不抢指针', /fiv-dragging .\$\{NS\}-thumb\s*\{[^}]*pointer-events:\s*none/.test(CODE)
      || /\.\$\{NS\}-strip\.\$\{NS\}-dragging \.\$\{NS\}-thumb\s*\{[^}]*pointer-events:\s*none/.test(CODE));
  }

  /* ============ C. 分组枚举 ============ */
  console.log('\n【分组枚举】groups()');
  {
    const { P } = await withPage(THREE_GROUPS);
    const gs = P.groups(2);
    ok('组数 = 3', gs.length === 3, '实际 ' + gs.length);
    ok('组大小 2/3/2', gs.map((g) => g.size).join(',') === '2,3,2', gs.map((g) => g.size).join(','));
    ok('起始下标 0/2/5', gs.map((g) => g.startIndex).join(',') === '0,2,5', gs.map((g) => g.startIndex).join(','));
    ok('组 id 唯一', new Set(gs.map((g) => g.id)).size === gs.length);
    ok('每组均有 label', gs.every((g) => g.label && g.label.length > 0));
  }

  /* ============ D. 组间连续浏览 ============ */
  console.log('\n【组间续览】');
  {
    const { w, V, P, C } = await withPage(THREE_GROUPS);
    const A1 = w.document.getElementById('A1');
    V.openAt(P.items.findIndex((it) => it.el === A1));
    await sleep(80);
    V.openGroup(A1);
    ok('进入第 1 组', V.inGroup && V.itemCount === 2, 'count=' + V.itemCount);

    V.navNext();
    ok('组内翻到第 2 张', V.index === 1, 'index=' + V.index);
    V.navNext();
    ok('组尾再翻 → 跨到第 2 组', V.itemCount === 3 && V.index === 0,
      'count=' + V.itemCount + ' index=' + V.index);
    V.navPrev();
    ok('组首再前翻 → 回到第 1 组', V.itemCount === 2, 'count=' + V.itemCount);

    C.set('groupChaining', false);
    const before = V.itemCount;
    V.navPrev();
    ok('关闭续览后不跨组', V.itemCount === before, 'count=' + V.itemCount);
    C.set('groupChaining', true);

    V.clearScope();
    ok('退出分组后 inGroup=false', !V.inGroup);
    const i0 = V.index;
    V.navNext();
    ok('全局 navNext 正常', V.index === i0 + 1, 'index=' + V.index);
  }

  console.log('\n' + '═'.repeat(31));
  console.log('  通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
  console.log('═'.repeat(31));
  process.exit(fail ? 1 : 0);
})();
