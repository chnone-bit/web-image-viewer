/**
 * 「以图定域」（按组浏览）回归测试
 * 场景：一页里有两个图组（楼层），验证：
 *   - groupOf() 能正确框出「用户点的那张图」所属的那一组
 *   - openGroup() 只把这组收进浏览列表，且定位到源图
 *   - 组内只有 1 张时回退全局
 *   - 缩略图条只显示本组数量
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const CODE = fs.readFileSync('C:/Users/lidt/WorkBuddy/2026-10-05-16-56-29/web-image-viewer.user.js', 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✅ ' + n)) : (fail++, console.log('  ❌ ' + n + (e ? '  → ' + e : ''))); };

// 页面结构：两个 .post（楼层），A 组 3 张，B 组 2 张，另有一个孤立单图
const html = `<!DOCTYPE html><html><body>
  <div class="thread">
    <div class="post" id="postA"><div class="message">
      <img id="A1" src="https://x.com/a1.jpg">
      <img id="A2" src="https://x.com/a2.jpg">
      <img id="A3" src="https://x.com/a3.jpg">
    </div></div>
    <div class="post" id="postB"><div class="message">
      <img id="B1" src="https://x.com/b1.jpg">
      <img id="B2" src="https://x.com/b2.jpg">
    </div></div>
    <div class="single" id="postC"><div class="message">
      <img id="C1" src="https://x.com/c1.jpg">
    </div></div>
  </div>
</body></html>`;

const dom = new JSDOM(html, { url: 'https://forum.example.com/t.html', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.matchMedia = (q) => ({ matches: false, addListener() {}, removeListener() {} });
Object.defineProperty(w.HTMLImageElement.prototype, 'naturalWidth', { get() { return 1200; }, configurable: true });
Object.defineProperty(w.HTMLImageElement.prototype, 'naturalHeight', { get() { return 800; }, configurable: true });
w.Element.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, x: 0, y: 0 }; };
w.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
w.cancelAnimationFrame = (id) => clearTimeout(id);
w.Element.prototype.scrollIntoView = function () {};
w.scrollTo = () => {};
w.console.error = () => {};

w.eval(CODE);

const q = (s) => w.document.querySelector(s);
const counter = () => (q('.fiv-counter') ? q('.fiv-counter').textContent : '');
const scopeBadge = () => (q('.fiv-scope') ? { text: q('.fiv-scope').textContent, hidden: q('.fiv-scope').hidden } : null);
const curAlt = () => { const a = q('.fiv-anchor'); return a ? (a.id || a.alt) : 'none'; };

setTimeout(() => {
  const P = w.__fiv.ImagePool;
  ok('图片池共 6 张（3+2+1）', P.count === 6, '实际 ' + P.count);

  console.log('\n【分组解析】groupOf()');
  const elA2 = w.document.getElementById('A2');
  const gA = P.groupOf(elA2);
  ok('A2 → 命中 A 组', !!gA, gA ? JSON.stringify({ size: gA.size, reason: gA.reason }) : 'null');
  ok('A 组共 3 张（只含 A1-A3）', gA && gA.size === 3, gA ? gA.size : '-');

  const elB1 = w.document.getElementById('B1');
  const gB = P.groupOf(elB1);
  ok('B1 → 命中 B 组，共 2 张', gB && gB.size === 2, gB ? gB.size : 'null');

  const elC1 = w.document.getElementById('C1');
  const gC = P.groupOf(elC1);
  ok('C1（孤立单图）→ 返回 null（应回退全局）', gC === null, gC ? gC.size : 'null');

  console.log('\n【按组浏览】openGroup(A2)');
  const opened = w.__fiv.Viewer.openGroup(elA2);
  setTimeout(() => {
    ok('成功按组打开', opened === true);
    ok('计数器显示 1 / 3（仅本组）', counter().indexOf('/ 3') >= 0, counter());
    const b = scopeBadge();
    ok('顶栏出现「本组」标识', b && !b.hidden && /本组|3 张/.test(b.text), b ? b.text : 'null');
    ok('进入后定位到用户点的 A2', curAlt() === 'A2', '实际 ' + curAlt());

    console.log('\n【组内翻页】');
    w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    setTimeout(() => {
      ok('A2 → A3', curAlt() === 'A3', '实际 ' + curAlt());
      w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      setTimeout(() => {
        ok('组尾再翻 → 续览到下一组 B1（v1.5 组间续览）', curAlt() === 'B1', '实际 ' + curAlt());

        console.log('\n【Esc 退组】第一下回全部，不关闭浏览器');
        w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        setTimeout(() => {
          ok('浏览器仍打开', !!w.document.getElementById('fiv-root').classList.contains('fiv-open'));
          ok('计数器已变为 / 6（全部）', counter().indexOf('/ 6') >= 0, counter());
          const b2 = scopeBadge();
          ok('「本组」标识已隐藏', !b2 || b2.hidden === true);
          ok('退出分组后停留在续览到的 B1', curAlt() === 'B1', '实际 ' + curAlt());

          console.log('\n【第二下 Esc 才关闭】');
          w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          setTimeout(() => {
            ok('浏览器已关闭', !w.document.getElementById('fiv-root').classList.contains('fiv-open'));

            console.log('\n【单图组回退】openGroup(C1)');
            const r = w.__fiv.Viewer.openGroup(w.document.getElementById('C1'));
            setTimeout(() => {
              ok('返回值 false（表示回退全局）', r === false, String(r));
              ok('计数器变为 / 6（全局）', counter().indexOf('/ 6') >= 0, counter());
              ok('定位到 C1', curAlt() === 'C1', '实际 ' + curAlt());
              finish();
            }, 300);
          }, 320);
        }, 320);
      }, 260);
    }, 260);
  }, 400);
}, 700);

function finish() {
  console.log('\n═══════════════════════════════');
  console.log('  通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
  console.log('═══════════════════════════════');
  process.exit(fail ? 1 : 0);
}
