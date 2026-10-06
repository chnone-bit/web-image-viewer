/**
 * v1.4 第四批专项测试
 *
 * 覆盖：
 *   - 增量扫描：新注入的容器被并入池，且**只**扫描新增子树（不对全页重扫）
 *   - 准入粒度：新容器整块通过，内部 img 继承结论（不逐个判 root 成员资格）
 *   - 侧边栏/广告区（不在采集范围）不被误收
 *   - 移除节点后的清理（pruneDetached）
 *   - 死代码已清除（throttle / naturalScale / stripOffset / btnSettings / btnHideStrip）
 *   - 新增配置项存在且有 UI 入口（whitelist / whitelistOnly / syncScrollBehavior）
 *   - 迷你进度条存在并随位置更新
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const SRC = 'C:/Users/lidt/WorkBuddy/2026-10-05-16-56-29/web-image-viewer.user.js';
const CODE = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✅ ' + n)) : (fail++, console.log('  ❌ ' + n + (e ? '  → ' + e : ''))); };

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
  w.eval(CODE);
  return new Promise((resolve) => setTimeout(() => resolve({ w, P: w.__fiv.ImagePool, C: w.__fiv.Config }), 140));
}

const ids = (P) => P.items.map((it) => (it.el && it.el.id) || it.el.tagName).join(',');

(async () => {
  /* ---------------- 增量扫描：新增容器并入 ---------------- */
  console.log('\n【增量扫描】新注入的楼层容器自动并入');
  {
    const { w, P } = await withPage(`
      <div class="thread"><div class="post" id="p1"><div class="message">
        <img id="M1" src="https://x.com/m1.jpg"><img id="M2" src="https://x.com/m2.jpg">
      </div></div></div>`);
    const before = P.count;
    ok('初始识别 2 张', before === 2, '实际 ' + before);

    // 注入一个新楼层
    const d = w.document.createElement('div'); d.className = 'message';
    const im = w.document.createElement('img'); im.id = 'NEW'; im.src = 'https://x.com/new.jpg';
    d.appendChild(im);
    w.document.querySelector('.thread').appendChild(d);
    const n = P.scanNodes([d]);
    ok('scanNodes 直接调用可入池', n === 1 && P.count === 3, '返回 ' + n + ' 池 ' + P.count);
    ok('新图已在池中（按 DOM 节点）', ids(P).includes('NEW'), ids(P));
  }

  /* ---------------- 准入粒度：整块容器一次判定 ---------------- */
  console.log('\n【准入粒度】新容器整块通过，内部 img 继承结论');
  {
    const { w, P } = await withPage(`
      <div class="thread"><div class="post" id="p1"><div class="message">
        <img id="M1" src="https://x.com/m1.jpg"><img id="M2" src="https://x.com/m2.jpg">
      </div></div></div>`);
    // 深层嵌套的新容器：img 的 parentElement 不是采集根
    const outer = w.document.createElement('div'); outer.className = 'message';
    const mid = w.document.createElement('div'); mid.className = 'inner';
    const deep = w.document.createElement('div'); deep.className = 'deeper';
    const im = w.document.createElement('img'); im.id = 'DEEP'; im.src = 'https://x.com/deep.jpg';
    deep.appendChild(im); mid.appendChild(deep); outer.appendChild(mid);
    w.document.querySelector('.thread').appendChild(outer);
    const n = P.scanNodes([outer]);
    ok('深层嵌套的新图也能入池（未被准入误杀）', n === 1 && ids(P).includes('DEEP'), '返回 ' + n);
  }

  /* ---------------- 范围外节点不误收 ---------------- */
  console.log('\n【准入过滤】采集范围外的节点不误收');
  {
    const { w, P } = await withPage(`
      <div class="thread"><div class="post" id="p1"><div class="message">
        <img id="M1" src="https://x.com/m1.jpg"><img id="M2" src="https://x.com/m2.jpg">
      </div></div></div>`);
    // 侧边栏：与采集根不同父级、且不是内容容器
    const aside = w.document.createElement('aside'); aside.className = 'sidebar-widget';
    const ai = w.document.createElement('img'); ai.id = 'AD'; ai.src = 'https://x.com/ad.jpg';
    aside.appendChild(ai);
    w.document.body.appendChild(aside);
    const n = P.scanNodes([aside]);
    ok('范围外容器被拒绝（返回 0）', n === 0, '返回 ' + n);
    ok('广告图未进池', !ids(P).includes('AD'), ids(P));
  }

  /* ---------------- 移除节点后的清理 ---------------- */
  console.log('\n【移除清理】脱离文档的条目被 prune 掉');
  {
    const { w, P } = await withPage(`
      <div class="thread"><div class="post" id="p1"><div class="message">
        <img id="R1" src="https://x.com/r1.jpg"><img id="R2" src="https://x.com/r2.jpg">
      </div></div></div>`);
    ok('初始 2 张', P.count === 2, '实际 ' + P.count);
    // 把整块楼层从 DOM 移除
    const post = w.document.getElementById('p1');
    post.remove();
    const pruned = P.prune();
    ok('prune 返回清理数量 2', pruned === 2, '返回 ' + pruned);
    ok('池已清空', P.count === 0, '实际 ' + P.count);
  }

  /* ---------------- 配置项与 UI ---------------- */
  console.log('\n【配置与设置面板】');
  {
    const { w, P, C } = await withPage(`
      <div class="post"><div class="message">
        <img id="X1" src="https://x.com/x1.jpg"><img id="X2" src="https://x.com/x2.jpg">
      </div></div>`);
    ok('whitelistOnly 默认 false', C.get('whitelistOnly') === false, String(C.get('whitelistOnly')));
    ok('whitelist 默认 []', Array.isArray(C.get('whitelist')) && C.get('whitelist').length === 0,
      JSON.stringify(C.get('whitelist')));
    ok('syncScrollBehavior 默认 smooth', C.get('syncScrollBehavior') === 'smooth', String(C.get('syncScrollBehavior')));

    // 打开设置面板，检查新字段是否有 UI 入口
    w.dispatchEvent(new w.KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    const has = (k) => !!w.document.querySelector('.fiv-panel [data-field="' + k + '"]');
    ok('面板含 whitelistOnly 开关', has('whitelistOnly'), '-');
    ok('面板含 whitelist 文本域', has('whitelist'), '-');
    ok('面板含 syncScrollBehavior 下拉', has('syncScrollBehavior'), '-');
    const wl = w.document.querySelector('.fiv-panel [data-field="whitelist"]');
    ok('whitelist 文本域标记为数组型', wl && wl.dataset.array === '1', wl ? wl.dataset.array : 'null');
  }

  /* ---------------- 白名单数组切分 ---------------- */
  console.log('\n【白名单解析】文本 → 数组');
  {
    const { w, C } = await withPage(`
      <div class="post"><div class="message">
        <img id="X1" src="https://x.com/x1.jpg"><img id="X2" src="https://x.com/x2.jpg">
      </div></div>`);
    w.dispatchEvent(new w.KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    const ta = w.document.querySelector('.fiv-panel [data-field="whitelist"]');
    ta.value = 'bbs.example.com\n   \nforum.test.org, bbs.example.com';
    const saveBtn = w.document.querySelector('.fiv-panel [data-save]');
    saveBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    const wl = C.get('whitelist');
    ok('按行/逗号切分并去重', Array.isArray(wl) && wl.length === 2, JSON.stringify(wl));
    ok('包含两条不同站点', wl.indexOf('bbs.example.com') >= 0 && wl.indexOf('forum.test.org') >= 0,
      JSON.stringify(wl));
  }

  /* ---------------- 迷你进度条 ---------------- */
  console.log('\n【迷你进度条】虚拟化后仍表达全局位置');
  {
    const { w, P } = await withPage(`
      <div class="post"><div class="message">
        <img id="G1" src="https://x.com/g1.jpg"><img id="G2" src="https://x.com/g2.jpg">
        <img id="G3" src="https://x.com/g3.jpg"><img id="G4" src="https://x.com/g4.jpg">
      </div></div>`);
    const V = w.__fiv.Viewer;
    V.openAt(0);
    await new Promise((r) => setTimeout(r, 80));
    const mm = w.document.querySelector('.fiv-minimap');
    const fill = w.document.querySelector('.fiv-minimap-fill');
    const head = w.document.querySelector('.fiv-minimap-head');
    ok('迷你进度条存在', !!mm && !!fill && !!head, '-');
    ok('首张时填充 25%（1/4）', fill && fill.style.width === '25%', fill ? fill.style.width : 'null');
    ok('首张时游标在 0%', head && head.style.left === '0%', head ? head.style.left : 'null');
    // 跳到末张
    V.show(3, 1);
    await new Promise((r) => setTimeout(r, 60));
    ok('末张时填充 100%', fill.style.width === '100%', fill.style.width);
    ok('末张时游标在 100%', head.style.left === '100%', head.style.left);
  }

  /* ---------------- 死代码已清除 ---------------- */
  console.log('\n【死代码清除】');
  ok('源码不含 throttle 定义', !/function throttle\s*\(/.test(CODE), '-');
  ok('源码不含 naturalScale', !/naturalScale/.test(CODE), '-');
  ok('源码不含 stripOffset', !/stripOffset/.test(CODE), '-');
  ok('源码不含 btnSettings', !/btnSettings/.test(CODE), '-');
  ok('源码不含 btnHideStrip', !/btnHideStrip/.test(CODE), '-');
  ok('boot 内不再有空操作灯箱监听（无 Viewer.isOpen 空转）',
    !/if \(!Viewer\.isOpen\) return;\s*\n\s*const img = e\.target/.test(CODE), '-');

  console.log('\n' + '═'.repeat(31));
  console.log('  通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
  console.log('═'.repeat(31));
  process.exit(fail ? 1 : 0);
})();
