/**
 * v1.6.1 缩略图条跟随专项测试
 *
 * 覆盖两个用户报告的 bug：
 *   Bug1 焦点缩略图跑出显示范围
 *         根因：show() 只调 updateStripCurrent() 改高亮，**从不调 scrollStripTo()**
 *              → 翻图时缩略图条不滚动，焦点直接跑出视野
 *   Bug2 缩略图数量与实际可浏览数不符
 *         根因：>120 张走虚拟化 computeVirtualWindow()，但它依赖 index 且
 *              **只在 renderStrip() 时算一次** → 翻图时窗口不跟随
 *
 * ⚠️ 测试要点：jsdom 的 offsetLeft / clientWidth 全是 0，必须打桩，
 *    否则 scrollLeft 恒为 0，两个 bug 都测不出来。
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const SRC = 'C:/Users/lidt/WorkBuddy/2026-10-05-16-56-29/web-image-viewer.user.js';
const CODE = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✅ ' + n)) : (fail++, console.log('  ❌ ' + n + (e ? '  → ' + e : ''))); };

/** 造 n 张图的页面（全部同一容器 → 单组） */
function manyImages(n) {
  let s = '<div class="thread"><div class="post"><div class="message">';
  for (let i = 0; i < n; i++) {
    s += '<img id="i' + i + '" src="https://x.com/p' + i + '.jpg">';
  }
  return s + '</div></div></div>';
}

/**
 * 给缩略图条装上真实布局的模拟。
 *
 * ⚠️ 三层坑（都踩过）：
 *  1. jsdom 的 offsetLeft 是**实例级可覆盖**的，原型级 defineProperty 无效；
 *  2. 但 renderStrip() 会 `track.innerHTML=''` **重建全部 thumb 节点**，
 *     实例级桩会随旧节点一起丢失 → 滚动永远算成 0；
 *  3. 所以必须**劫持 document.createElement**，让新建的 thumb 一出生就带上桩。
 *     这是唯一能覆盖「渲染 → 读布局 → 写 scrollLeft」完整链路的办法。
 */
function installLayoutStubs(w) {
  if (w.__fivStubInstalled) return;
  const origCreate = w.document.createElement.bind(w.document);
  w.document.createElement = function (tag, ...rest) {
    const el = origCreate(tag, ...rest);
    if (String(tag).toLowerCase() === 'button' || String(tag).toLowerCase() === 'div') {
      // 用 defineProperty 挂到实例上（原型级无效）
      Object.defineProperty(el, 'offsetLeft', {
        get() {
          if (this.classList && this.classList.contains('fiv-thumb')) {
            return 2 + Number(this.dataset.i || 0) * 87;
          }
          return 0;
        },
        configurable: true
      });
      Object.defineProperty(el, 'offsetWidth', {
        get() {
          if (this.classList && this.classList.contains('fiv-thumb')) return 80;
          return 0;
        },
        configurable: true
      });
    }
    return el;
  };
  w.__fivStubInstalled = true;
}

/** 给 track 装 scrollLeft / clientWidth（状态挂在元素上，跨 DOM 重建存活） */
function layoutTrack(w, track, clientW) {
  const st = track.__fivSlState || (track.__fivSlState = { v: 0 });
  Object.defineProperty(track, 'clientWidth', { get: () => clientW, configurable: true });
  Object.defineProperty(track, 'scrollLeft', {
    get: () => st.v,
    set: (x) => { st.v = Math.max(0, x); },
    configurable: true
  });
  return st;
}

function withPage(html) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>' + html + '</body></html>',
    { url: 'https://forum.example.com/t.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.__fivNS = 'fiv';
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
  // ⚠️ 必须在 eval 之前装：脚本运行时创建的 thumb 才会带上布局桩
  installLayoutStubs(w);
  w.eval(CODE);
  return new Promise((resolve) => setTimeout(() => resolve({
    w,
    P: w.__fiv.ImagePool,
    V: w.__fiv.Viewer,
    C: w.__fiv.Config
  }), 400));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 典型参数：thumbSize 64 → 宽 80，gap 7 → 步长 87
const STEP = 87, CLIENTW = 600;

(async () => {
  /* ============ Bug1：翻图时缩略图条应跟随滚动 ============ */
  console.log('\n【Bug1】翻图后当前缩略图应滚入视野');
  {
    const N = 30;
    const { w, V, C } = await withPage(manyImages(N));
    C.set('thumbSize', 64);
    C.set('thumbnailBar', true);
    V.openAt(0);
    await sleep(150);

    const track = w.document.querySelector('.fiv-track');
    const sl = layoutTrack(w, track, CLIENTW);

    ok('缩略图已全部渲染（30 < 120 虚拟化阈值）',
      track.querySelectorAll('.fiv-thumb').length === N,
      'count=' + track.querySelectorAll('.fiv-thumb').length);

    // 翻到第 20 张（0-based 19）：应滚动使它居中
    V.openAt(19);
    await sleep(120);
    const expect = 2 + 19 * STEP - (CLIENTW - (STEP - 7)) / 2;
    ok('翻到第 20 张后缩略图条已滚动', sl.v > 0, 'scrollLeft=' + sl.v);
    ok('当前缩略图滚入视野（居中附近）',
      Math.abs(sl.v - expect) < STEP, 'scrollLeft=' + sl.v + ' expect≈' + expect.toFixed(0));

    // 再往前翻几张，滚动位置应继续跟进
    const before = sl.v;
    V.openAt(24);
    await sleep(120);
    ok('继续前翻时滚动位置继续跟进', sl.v > before, before + ' → ' + sl.v);

    // 回到开头，应滚回 0
    V.openAt(0);
    await sleep(120);
    ok('回到第 1 张时滚回起点', sl.v === 0, 'scrollLeft=' + sl.v);
  }

  console.log('\n【Bug1】高亮与滚动必须指向同一张');
  {
    const N = 30;
    const { w, V, C } = await withPage(manyImages(N));
    C.set('thumbSize', 64);
    C.set('thumbnailBar', true);
    V.openAt(0);
    await sleep(150);
    const track = w.document.querySelector('.fiv-track');
    const sl = layoutTrack(w, track, CLIENTW);

    V.openAt(25);
    await sleep(120);
    const cur = track.querySelector('.fiv-thumb.fiv-cur');
    ok('高亮落在当前图上', !!cur && cur.dataset.i === '25', cur ? cur.dataset.i : '无高亮');
    // 当前缩略图的 left 应在 [scrollLeft, scrollLeft+clientWidth] 内
    if (cur) {
      const left = 2 + Number(cur.dataset.i) * STEP;
      const inView = left >= sl.v - STEP && left <= sl.v + CLIENTW;
      ok('高亮那张在可视范围内（焦点不跑出视野）', inView,
        'left=' + left + ' scrollLeft=' + sl.v + ' view=[' + sl.v + ',' + (sl.v + CLIENTW) + ']');
    }
  }

  /* ============ Bug2：>120 张虚拟化窗口必须跟随 ============ */
  console.log('\n【Bug2】超过 120 张走虚拟化');
  {
    const N = 200;
    const { w, V, C } = await withPage(manyImages(N));
    C.set('thumbSize', 64);
    C.set('thumbnailBar', true);
    V.openAt(0);
    await sleep(200);

    const track = w.document.querySelector('.fiv-track');
    const rendered = track.querySelectorAll('.fiv-thumb').length;
    ok('大数量时只渲染窗口（不全量渲染）', rendered < N, 'rendered=' + rendered);
    ok('实际可浏览数量 = 200', V.itemCount === N, 'itemCount=' + V.itemCount);

    // 关键：渲染的窗口应包含当前下标
    let cur = track.querySelector('.fiv-thumb.fiv-cur');
    ok('虚拟窗口包含当前图', !!cur, cur ? 'i=' + cur.dataset.i : '无高亮');
  }

  console.log('\n【Bug2】翻图时虚拟窗口与滚动必须跟随');
  {
    const N = 200;
    const { w, V, C } = await withPage(manyImages(N));
    C.set('thumbSize', 64);
    C.set('thumbnailBar', true);
    V.openAt(0);
    await sleep(200);
    const track = w.document.querySelector('.fiv-track');
    let sl = layoutTrack(w, track, CLIENTW);

    // 翻到很靠后的位置
    V.openAt(150);
    await sleep(200);
    // 虚拟窗口可能已重渲染 → 重新打桩
    sl = layoutTrack(w, track, CLIENTW);
    V.openAt(150);
    await sleep(150);

    const cur = track.querySelector('.fiv-thumb.fiv-cur');
    ok('翻到第 151 张后有高亮', !!cur, cur ? 'i=' + cur.dataset.i : '无');
    ok('虚拟窗口已跟随到当前下标', !!cur && cur.dataset.i === '150', cur ? 'i=' + cur.dataset.i : '无');

    if (cur) {
      const left = 2 + Number(cur.dataset.i) * STEP;
      const inView = left >= sl.v - STEP && left <= sl.v + CLIENTW;
      ok('第 151 张在可视范围内（焦点不跑出）', inView,
        'left=' + left + ' scrollLeft=' + sl.v);
    }
  }

  console.log('\n【Bug2】虚拟窗口跟随应覆盖连续翻图');
  {
    const N = 200;
    const { w, V, C } = await withPage(manyImages(N));
    C.set('thumbSize', 64);
    C.set('thumbnailBar', true);
    V.openAt(0);
    await sleep(200);
    const track = w.document.querySelector('.fiv-track');
    layoutTrack(w, track, CLIENTW);
    // 连翻 20 次，每次 10 张；最后一次 k*10=200 会被 clamp 到 199
    let lastExpected = -1;
    for (let k = 1; k <= 20; k++) {
      const target = Math.min(N - 1, k * 10);
      lastExpected = target;
      V.openAt(target);
      await sleep(12);
    }
    await sleep(250);
    const cur = track.querySelector('.fiv-thumb.fiv-cur');
    ok('连续翻图后高亮仍准确', !!cur && Number(cur.dataset.i) === lastExpected,
      cur ? 'i=' + cur.dataset.i + ' expect=' + lastExpected : '无');
    ok('最终下标正确', V.index === lastExpected, 'index=' + V.index + ' expect=' + lastExpected);
  }

  /* ============ 边界：单图 / 关闭缩略图条 ============ */
  console.log('\n【边界】');
  {
    const { w, V, C } = await withPage(manyImages(3));
    C.set('thumbnailBar', true);
    V.openAt(0);
    await sleep(150);
    const track = w.document.querySelector('.fiv-track');
    layoutTrack(w, track, CLIENTW);
    V.openAt(2);
    await sleep(100);
    ok('少于阈值时翻图正常（无异常）', V.index === 2, 'index=' + V.index);
  }
  {
    const { w, V, C } = await withPage(manyImages(30));
    C.set('thumbnailBar', false);   // 关掉缩略图条
    V.openAt(0);
    await sleep(150);
    ok('缩略图条关闭时翻图不报错', V.index === 0);
    V.openAt(10);
    await sleep(100);
    ok('缩略图条关闭时仍能翻图', V.index === 10, 'index=' + V.index);
    ok('缩略图条确实没渲染', w.document.querySelectorAll('.fiv-thumb').length === 0,
      'count=' + w.document.querySelectorAll('.fiv-thumb').length);
  }

  /* ============ 数量一致性（用户报告的第 2 个问题） ============ */
  console.log('\n【数量】缩略图序号与实际可浏览数必须对得上');
  {
    // 小于阈值：全量渲染，序号 1..N 连续
    const N = 40;
    const { w, V, C } = await withPage(manyImages(N));
    C.set('thumbnailBar', true);
    V.openAt(0);
    await sleep(200);
    let track = w.document.querySelector('.fiv-track');
    const idxs = [...track.querySelectorAll('.fiv-thumb .fiv-idx')].map((e) => e.textContent);
    ok('小数量：缩略图个数 = 可浏览数', idxs.length === N, idxs.length + ' vs ' + N);
    ok('小数量：序号连续 1..N', idxs[0] === '1' && idxs[idxs.length - 1] === String(N),
      idxs[0] + '..' + idxs[idxs.length - 1]);

    // 大于阈值：虚拟化渲染，但**序号必须反映真实位置**（不能从 1 重新数）
    const M = 200;
    const { w: w2, V: V2, C: C2 } = await withPage(manyImages(M));
    C2.set('thumbnailBar', true);
    V2.openAt(150);
    await sleep(250);
    track = w2.document.querySelector('.fiv-track');
    const nums = [...track.querySelectorAll('.fiv-thumb .fiv-idx')].map((e) => Number(e.textContent));
    ok('大数量：只渲染窗口', nums.length < M, 'rendered=' + nums.length);
    ok('大数量：序号反映真实位置（含 151）', nums.includes(151),
      '范围 ' + nums[0] + '..' + nums[nums.length - 1]);
    ok('大数量：序号单调递增', nums.every((v, i) => i === 0 || v === nums[i - 1] + 1),
      nums.slice(0, 5).join(','));
    ok('大数量：当前图序号 = index+1', nums.includes(V2.index + 1),
      'index=' + V2.index + ' 序号含 ' + (V2.index + 1));
  }

  console.log('\n' + '═'.repeat(31));
  console.log('  通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
  console.log('═'.repeat(31));
  process.exit(fail ? 1 : 0);
})();
