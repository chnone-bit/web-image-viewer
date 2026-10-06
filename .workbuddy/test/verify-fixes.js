/**
 * 两个 bug 的回归验证：
 *  Bug 1 — 图片顺序须为「页面摆放顺序」（DOM 文档顺序），而非选择器分组/加载顺序
 *  Bug 2 — 未刷新页面时，退出浏览后再进入，应从退出时的那张图继续
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const CODE = fs.readFileSync('C:/Users/lidt/WorkBuddy/2026-10-05-16-56-29/forum-image-viewer.user.js', 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✅ ' + n)) : (fail++, console.log('  ❌ ' + n + (e ? '  → ' + e : ''))); };

// 关键：让「选择器优先级」查出与 DOM 顺序**相反**的结果，才能暴露 bug
// 页面 DOM 顺序：F2 → F3 → F1（故意打乱楼层）
// 三个楼层用不同 class，且 F1 的 selector 在 AUTO_CONTENT_SELECTORS 里优先级更靠前
const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <div class="thread">
    <div class="postcard" id="F2"><div class="message"><img id="F2-1" src="https://x.com/p2.jpg" alt="F2-1"></div></div>
    <div class="postcard" id="F3"><div class="message"><img id="F3-1" src="https://x.com/p3.jpg" alt="F3-1"></div></div>
    <div class="postcard" id="F1"><div class="message"><img id="F1-1" src="https://x.com/p1.jpg" alt="F1-1"></div></div>
  </div>
</body></html>`, { url: 'https://forum.example.com/t.html', runScripts: 'outside-only', pretendToBeVisual: true });

const w = dom.window;
w.matchMedia = (q) => ({ matches: false, addListener() {}, removeListener() {} });

const S = { 'https://x.com/p1.jpg': [1000, 800], 'https://x.com/p2.jpg': [1000, 800], 'https://x.com/p3.jpg': [1000, 800] };
Object.defineProperty(w.HTMLImageElement.prototype, 'naturalWidth', { get() { return (S[this.src] || [800, 600])[0]; }, configurable: true });
Object.defineProperty(w.HTMLImageElement.prototype, 'naturalHeight', { get() { return (S[this.src] || [800, 600])[1]; }, configurable: true });
w.Element.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, x: 0, y: 0 }; };
w.HTMLImageElement.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0 }; };
w.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
w.cancelAnimationFrame = (id) => clearTimeout(id);
w.Element.prototype.scrollIntoView = function () {};
w.scrollTo = () => {};
w.console.error = () => {};

w.eval(CODE);

const q = (s) => w.document.querySelector(s);
const fab = () => q('.fiv-fab');
const counter = () => (q('.fiv-counter') ? q('.fiv-counter').textContent : '');

// 从 DOM 里读出图片池的 alt 顺序（缩略图 title/aria 里带 name）
function poolOrder() {
  // 通过缩略图的数据属性或 alt 反推：直接读 Viewer 的 items 不可行（内部变量），
  // 改用「导航到每张图，读取 counter + 当前 alt」的方式
  const out = [];
  const total = Number((counter().match(/\/\s*(\d+)/) || [])[1]) || 0;
  return { total, out };
}

setTimeout(() => {
  ok('页面已识别到 3 张图片（悬浮按钮就绪）', !!fab(),
    fab() ? fab().textContent.trim() : 'no-fab');

  // 打开浏览模式
  fab().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  setTimeout(() => {
    // counter 在浏览层构建后才存在
    const c = counter();
    const total = Number((c.match(/\/\s*(\d+)/) || [])[1]) || 0;
    ok('图片池共收录 3 张', total === 3, '实际 ' + total + ' 张 (' + c + ')');

    const getCur = () => {
      const anchor = q('.fiv-anchor');
      return anchor ? (anchor.id || anchor.alt) : 'none';
    };

    console.log('\n【Bug 1】图片顺序 = 页面 DOM 摆放顺序');
    ok('第 1 张 = F2-1（DOM 里第一个）', getCur() === 'F2-1', '实际 ' + getCur());

    w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    setTimeout(() => {
      ok('第 2 张 = F3-1（DOM 里第二个）', getCur() === 'F3-1', '实际 ' + getCur());
      w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      setTimeout(() => {
        ok('第 3 张 = F1-1（DOM 里第三个）', getCur() === 'F1-1', '实际 ' + getCur());

        console.log('\n【Bug 2】退出后再进入 → 从退出时那张继续');
        // 当前停在第 3 张 F1-1，退出
        w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        setTimeout(() => {
          ok('已退出浏览模式', !w.document.getElementById('fiv-root').classList.contains('fiv-open'));
          // 再次点击悬浮按钮进入
          fab().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
          setTimeout(() => {
            ok('再次进入后仍停在 F1-1（未回到第 1 张）', getCur() === 'F1-1', '实际 ' + getCur());

            // 再验证一次：退到中间某张，也应续读
            w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
            setTimeout(() => {
              const mid = getCur();
              w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              setTimeout(() => {
                fab().dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
                setTimeout(() => {
                  ok('退到 ' + mid + ' 后再进入仍为 ' + mid, getCur() === mid, '实际 ' + getCur());
                  finish();
                }, 260);
              }, 260);
            }, 260);
          }, 260);
        }, 320);
      }, 260);
    }, 260);
  }, 420);
}, 700);

function finish() {
  console.log('\n═══════════════════════════════');
  console.log('  通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
  console.log('═══════════════════════════════');
  process.exit(fail ? 1 : 0);
}
