/**
 * v1.3 分组算法收敛专项测试
 *
 * 针对第三方评审核实出的核心缺陷：
 *   「bestHint 可以跨越 best，导致同一 post/article 下的多个独立图集被合并」
 *
 * 每个场景**独立建页**，避免 collectRoots 的根选择互相干扰
 * （真实页面不会把"论坛楼层"和"电商图集"混在一起，混着测反而失真）。
 *
 * 覆盖：
 *   - 并列 gallery 不合并
 *   - 两个内容块被外层 article 包裹 → 各自成组
 *   - 嵌套 gallery 取最紧层
 *   - 背景图以真实 DOM 节点入池并可参与分组
 *   - 孤立单图不吞并他人
 *   - 去重策略 / 采集根 / 索引一致性
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const CODE = fs.readFileSync('C:/Users/lidt/WorkBuddy/2026-10-05-16-56-29/forum-image-viewer.user.js', 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✅ ' + n)) : (fail++, console.log('  ❌ ' + n + (e ? '  → ' + e : ''))); };

/** 在隔离环境里跑一页并回调 ImagePool */
function withPage(html, fn) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>' + html + '</body></html>',
    { url: 'https://forum.example.com/t.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = (q) => ({ matches: false, addListener() {}, removeListener() {} });
  Object.defineProperty(w.HTMLImageElement.prototype, 'naturalWidth', { get() { return 1200; }, configurable: true });
  Object.defineProperty(w.HTMLImageElement.prototype, 'naturalHeight', { get() { return 800; }, configurable: true });
  w.Element.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 600, bottom: 600, width: 600, height: 600, x: 0, y: 0 };
  };
  // jsdom 不算 background-image → 给场景 4 的容器喂值
  w.getComputedStyle = (el) => ({
    backgroundImage: (el && el.id === 'BG1') ? 'url(https://x.com/bg1.jpg)' : 'none',
    getPropertyValue() { return ''; }
  });
  w.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.Element.prototype.scrollIntoView = function () {};
  w.scrollTo = () => {};
  w.console.error = () => {};
  w.console.warn = () => {};
  w.eval(CODE);
  return new Promise((resolve) => setTimeout(() => resolve({ w, P: w.__fiv.ImagePool, C: w.__fiv.Config }), 140));
}

const ids = (arr) => arr.map((it) => (it.el && it.el.id) || '?').join(',');

(async () => {
  /* ---------------- 场景 1：并列 gallery（论坛一楼两个图集） ---------------- */
  console.log('\n【场景 1】同一 post 下两个并列 gallery —— 不得合并');
  {
    const { w, P } = await withPage(`
      <div class="thread"><div class="post" id="post1">
        <div class="gallery" id="galA"><img id="A1" src="https://x.com/a1.jpg"><img id="A2" src="https://x.com/a2.jpg"></div>
        <div class="gallery" id="galB"><img id="B1" src="https://x.com/b1.jpg"><img id="B2" src="https://x.com/b2.jpg"></div>
      </div></div>`);
    const gA = P.groupOf(w.document.getElementById('A1'));
    ok('A1 恰为 A1,A2', gA && gA.size === 2 && ids(gA.items) === 'A1,A2', gA ? gA.size + ':' + ids(gA.items) : 'null');
    ok('未被 post1 吞并（size !== 4）', gA && gA.size !== 4, gA ? 'size=' + gA.size : '-');
    ok('A 组不含 B 组任何一张', !!gA && gA.items.every((it) => /^A/.test(it.el.id)), gA ? ids(gA.items) : '-');
    const gB = P.groupOf(w.document.getElementById('B2'));
    ok('B2 恰为 B1,B2', gB && gB.size === 2 && ids(gB.items) === 'B1,B2', gB ? gB.size + ':' + ids(gB.items) : 'null');
  }

  /* ---------------- 场景 2：两个内容块被外层 article 包裹 ---------------- */
  console.log('\n【场景 2】两个 .post-content 被 article 包裹 —— 各自成组');
  {
    const { w, P } = await withPage(`
      <article id="art2">
        <div class="post-content" id="pc1"><img id="P1" src="https://x.com/p1.jpg"><img id="P2" src="https://x.com/p2.jpg"></div>
        <div class="post-content" id="pc2"><img id="P3" src="https://x.com/p3.jpg"><img id="P4" src="https://x.com/p4.jpg"></div>
      </article>`);
    const g1 = P.groupOf(w.document.getElementById('P1'));
    ok('P1 恰为 P1,P2（未扩到 4 张）', g1 && g1.size === 2 && ids(g1.items) === 'P1,P2', g1 ? g1.size + ':' + ids(g1.items) : 'null');
    const g4 = P.groupOf(w.document.getElementById('P4'));
    ok('P4 恰为 P3,P4', g4 && g4.size === 2 && ids(g4.items) === 'P3,P4', g4 ? g4.size + ':' + ids(g4.items) : 'null');
  }

  /* ---------------- 场景 3：嵌套 gallery ---------------- */
  console.log('\n【场景 3】嵌套 gallery —— 取最紧的一层');
  {
    const { w, P } = await withPage(`
      <div class="gallery" id="galOuter">
        <img id="N0" src="https://x.com/n0.jpg">
        <div class="gallery" id="galInner"><img id="N1" src="https://x.com/n1.jpg"><img id="N2" src="https://x.com/n2.jpg"></div>
      </div>`);
    const gN = P.groupOf(w.document.getElementById('N1'));
    ok('N1 取内层（恰为 N1,N2，不含 N0）', gN && gN.size === 2 && ids(gN.items) === 'N1,N2',
      gN ? gN.size + ':' + ids(gN.items) : 'null');
  }

  /* ---------------- 场景 4：背景图容器 ---------------- */
  console.log('\n【背景图】真实 DOM 节点入池，不再有 fake 断链');
  {
    const { w, P } = await withPage(`
      <div class="floor" id="floorBg">
        <div class="bgpic" id="BG1" style="width:600px;height:600px"></div>
        <img id="I1" src="https://x.com/i1.jpg">
      </div>`);
    const bgEl = w.document.getElementById('BG1');
    const item = P.itemOf(bgEl);
    ok('背景图容器可在池中按元素查到', !!item, item ? item.src : 'null');
    ok('池内 el 就是真实 DOM 元素（=== BG1）', !!item && item.el === bgEl, item ? String(item.el === bgEl) : '-');
    ok('该条目带 isBg 标记', !!item && item.isBg === true, item ? String(item.isBg) : '-');
    const gBg = P.groupOf(bgEl);
    ok('背景图能参与分组（与 I1 同组）',
      !!gBg && gBg.size === 2 && gBg.items.some((it) => it.el === bgEl),
      gBg ? gBg.size + ':' + ids(gBg.items) : 'null');
  }

  /* ---------------- 场景 5：孤立单图 ---------------- */
  console.log('\n【场景 5】孤立单图不吞并他人');
  {
    const { w, P } = await withPage(`
      <div class="post" id="pa"><div class="gallery" id="ga">
        <img id="A1" src="https://x.com/a1.jpg"><img id="A2" src="https://x.com/a2.jpg"></div></div>
      <div class="lonely" id="lonelyBox"><img id="L1" src="https://x.com/l1.jpg"></div>`);
    const gL = P.groupOf(w.document.getElementById('L1'));
    ok('孤立图不把他组图片并入自己',
      gL === null || gL.items.every((it) => it.el.id === 'L1'),
      gL ? gL.size + ':' + ids(gL.items) : 'null');
  }

  /* ---------------- 配置 / 索引 ---------------- */
  console.log('\n【配置与索引】');
  {
    const { w, P, C } = await withPage(`
      <div class="post"><div class="gallery" id="g1">
        <img id="X1" src="https://x.com/x1.jpg"><img id="X2" src="https://x.com/x2.jpg"></div></div>`);
    ok('dedupeByUrl 默认关闭', C.get('dedupeByUrl') === false, String(C.get('dedupeByUrl')));
    ok('ImagePool.roots 可读且非空', Array.isArray(P.roots) && P.roots.length > 0, P.roots ? P.roots.length : '-');
    const before = P.count;
    P.scanNow(); P.scanNow();
    ok('重复扫描不改变池大小', P.count === before, before + ' → ' + P.count);
    ok('byEl 索引与 items 数量一致', P.items.length === before, before + ' → ' + P.items.length);
  }

  /* ---------------- 场景 6：同 URL 出现在两个帖子（去重策略） ---------------- */
  console.log('\n【场景 6】同一图片 URL 出现在两个帖子');
  {
    const { w, P } = await withPage(`
      <div class="post" id="t1"><div class="gallery" id="g1">
        <img id="U1" src="https://x.com/same.jpg"><img id="U2" src="https://x.com/u2.jpg"></div></div>
      <div class="post" id="t2"><div class="gallery" id="g2">
        <img id="U3" src="https://x.com/same.jpg"><img id="U4" src="https://x.com/u4.jpg"></div></div>`);
    ok('两个帖子共 4 个节点全部入池（默认按节点收）', P.count === 4, '实际 ' + P.count);
    const g2 = P.groupOf(w.document.getElementById('U3'));
    ok('第二个帖子仍能正常成组（2 张）', !!g2 && g2.size === 2, g2 ? g2.size + ':' + ids(g2.items) : 'null');
    ok('第二组的 el 是 U3/U4（未被去重吞掉）',
      !!g2 && g2.items.some((it) => it.el.id === 'U3') && g2.items.some((it) => it.el.id === 'U4'),
      g2 ? ids(g2.items) : '-');
  }

  console.log('\n' + '═'.repeat(31));
  console.log('  通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
  console.log('═'.repeat(31));
  process.exit(fail ? 1 : 0);
})();
