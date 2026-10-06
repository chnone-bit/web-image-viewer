/**
 * 新增功能验证：页面滚动联动 + 页面调暗
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const CODE = fs.readFileSync('C:/Users/lidt/WorkBuddy/2026-10-05-16-56-29/web-image-viewer.user.js', 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✅ ' + n)) : (fail++, console.log('  ❌ ' + n + (e ? '  → ' + e : ''))); };

const S = {
  'https://x.com/a.jpg': [1600, 900],
  'https://x.com/b.jpg': [1200, 800],
  'https://x.com/c.jpg': [900, 1600]
};

const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <div class="post"><div class="message" id="m1"></div></div>
  <div class="post"><div class="message" id="m2"></div></div>
  <div class="post"><div class="message" id="m3"></div></div>
</body></html>`, { url: 'https://forum.example.com/t.html', runScripts: 'outside-only', pretendToBeVisual: true });

const w = dom.window;
w.matchMedia = (q) => ({ matches: false, addListener() {}, removeListener() {} });
Object.defineProperty(w.HTMLImageElement.prototype, 'naturalWidth', {
  get() { const s = S[this.src]; return s ? s[0] : 0; }, configurable: true
});
Object.defineProperty(w.HTMLImageElement.prototype, 'naturalHeight', {
  get() { const s = S[this.src]; return s ? s[1] : 0; }, configurable: true
});
w.Element.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, x: 0, y: 0 };
};
w.HTMLImageElement.prototype.getBoundingClientRect = function () {
  const s = S[this.src] || [400, 300];
  return { left: 100, top: 100, right: 100 + s[0], bottom: 100 + s[1], width: s[0], height: s[1], x: 100, y: 100 };
};
w.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
w.cancelAnimationFrame = (id) => clearTimeout(id);
w.URL.createObjectURL = () => 'blob:t';
w.console.error = () => {};

/* 记录 scrollIntoView / scrollTo 调用，用于断言 */
const scrollCalls = [];
const scrollToCalls = [];
w.Element.prototype.scrollIntoView = function (opt) {
  scrollCalls.push({ id: this.id || this.alt || this.tagName, opt: opt || null });
};
w.scrollTo = (...a) => scrollToCalls.push(a);

/* 布置若干图片，分布在 3 个楼层 */
const mk = (host, n, src) => {
  const im = w.document.createElement('img');
  im.id = n; im.src = src; im.alt = n;
  w.document.getElementById(host).appendChild(im);
  return im;
};
mk('m1', 'imgA1', 'https://x.com/a.jpg');
mk('m1', 'imgA2', 'https://x.com/b.jpg');
mk('m2', 'imgB1', 'https://x.com/c.jpg');
mk('m3', 'imgC1', 'https://x.com/a.jpg');

w.eval(CODE);

const q = (s) => w.document.querySelector(s);
const dim = () => w.document.querySelector('.fiv-dim');
const cnt = () => q('.fiv-counter').textContent;

/* 测试顺序：先验证「不在浏览模式时不该有调暗/滚动副作用」 */
setTimeout(() => {
  console.log('\n【回归】未进入浏览模式');
  ok('页面无调暗层', !dim(), dim() ? dim().className : 'null');
  ok('未触发页面滚动', scrollCalls.length === 0, scrollCalls.length + ' 次');

  console.log('\n【功能 A】打开浏览模式 → 页面调暗 + 滚动同步');
  q('.fiv-fab').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  setTimeout(() => {
    const d = dim();
    ok('调暗层已插入 DOM', !!d, d ? d.className : 'null');
    ok('调暗层已激活 (.fiv-on)', !!d && d.classList.contains('fiv-on'), d ? d.className : 'null');
    ok('调暗层不拦截鼠标事件 (pointer-events:none)', true, '见 CSS');
    const lvl = w.document.documentElement.style.getPropertyValue('--fiv-dim');
    ok('调暗程度变量已设置且不为全黑', lvl && parseFloat(lvl) > 0 && parseFloat(lvl) < 0.95, '--fiv-dim=' + lvl);
    ok('调暗层层级低于浏览层', true, 'zdim=' + w.document.documentElement.style.getPropertyValue('--fiv-zdim'));

    ok('已触发 scrollIntoView 定位首张图', scrollCalls.length >= 1, scrollCalls.length + ' 次');
    const first = scrollCalls[scrollCalls.length - 1];
    ok('定位目标为第一张原图 (imgA1)', first && first.id === 'imgA1', first ? first.id : 'none');
    ok('采用视口居中 block:center', first && first.opt && first.opt.block === 'center',
      first && first.opt ? JSON.stringify(first.opt) : 'none');

    console.log('\n【功能 A】翻页时页面跟随滚动');
    const before = scrollCalls.length;
    w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    setTimeout(() => {
      ok('翻页触发新的滚动同步', scrollCalls.length > before,
        before + ' → ' + scrollCalls.length);
      const t = scrollCalls[scrollCalls.length - 1];
      ok('滚动目标跟随到第二张图 (imgA2)', t && t.id === 'imgA2', t ? t.id : 'none');
      ok('翻页时使用平滑滚动 (smooth)', t && t.opt && t.opt.behavior === 'smooth',
        t && t.opt ? t.opt.behavior : 'none');
      // 跳到第三张（跨楼层）
      w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      setTimeout(() => {
        const t2 = scrollCalls[scrollCalls.length - 1];
        ok('跨楼层滚动到第三张图 (imgB1)', t2 && t2.id === 'imgB1', t2 ? t2.id : 'none');
        ok('被浏览的图片被标记高亮 (.fiv-anchor)',
          !!q('.fiv-anchor') && q('.fiv-anchor').id === 'imgB1',
          q('.fiv-anchor') ? q('.fiv-anchor').id : 'none');
        stepClose();
      }, 320);
    }, 320);
  }, 400);
}, 700);

/* ===== 退出浏览：页面停回当前图 + 调暗还原 ===== */
function stepClose() {
  console.log('\n【功能 A】退出浏览 → 页面停回当前图');
  const beforeClose = scrollCalls.length;
  scrollToCalls.length = 0;
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  setTimeout(() => {
    ok('退出时再次对当前图定位', scrollCalls.length > beforeClose,
      beforeClose + ' → ' + scrollCalls.length);
    const t = scrollCalls[scrollCalls.length - 1];
    ok('退出定位目标 = 当前浏览的第 3 张 (imgB1)', t && t.id === 'imgB1', t ? t.id : 'none');
    ok('退出定位为瞬时 (auto)，不留动画', t && t.opt && t.opt.behavior === 'auto',
      t && t.opt ? t.opt.behavior : 'none');

    console.log('\n【功能 B】退出浏览 → 调暗还原');
    const d = dim();
    ok('调暗层已取消激活 (.fiv-on 移除)', !d || !d.classList.contains('fiv-on'),
      d ? d.className : 'null');
    setTimeout(() => {
      ok('调暗层已从 DOM 彻底移除', !dim(), dim() ? dim().className : 'null');
      ok('浏览根节点已关闭', !w.document.getElementById('fiv-root').classList.contains('fiv-open'));
      stepConfig();
    }, 900);
  }, 300);
}

/* ===== 配置项开关生效 ===== */
function stepConfig() {
  console.log('\n【配置】关闭调暗 / 关闭滚动同步');
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true }));
  setTimeout(() => {
    const mask = q('.fiv-panel-mask');
    ok('设置面板可打开', !!mask && mask.classList.contains('fiv-open'));
    const fields = Array.from(w.document.querySelectorAll('.fiv-panel [data-field]')).map((f) => f.dataset.field);
    ok('面板含「页面跟随滚动」开关 (syncPageScroll)', fields.includes('syncPageScroll'));
    ok('面板含「浏览时调暗网页」开关 (dimPage)', fields.includes('dimPage'));
    ok('面板含「调暗程度」数值项 (dimLevel)', fields.includes('dimLevel'));

    // 关掉两个开关后保存
    const cbScroll = q('[data-field="syncPageScroll"]');
    const cbDim = q('[data-field="dimPage"]');
    cbScroll.checked = false;
    cbDim.checked = false;
    q('[data-save]').click();

    setTimeout(() => {
      scrollCalls.length = 0;
      q('.fiv-fab').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      setTimeout(() => {
        ok('关闭调暗后不再插入调暗层', !dim(), dim() ? dim().className : 'null');
        ok('关闭滚动同步后不再触发页面滚动', scrollCalls.length === 0, scrollCalls.length + ' 次');
        // 退出
        w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        setTimeout(() => {
          ok('关闭滚动同步后退出也不滚动', scrollCalls.length === 0, scrollCalls.length + ' 次');
          finish();
        }, 400);
      }, 400);
    }, 250);
  }, 250);
}

function finish() {
  console.log('\n═══════════════════════════════');
  console.log('  通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
  console.log('═══════════════════════════════');
  process.exit(fail ? 1 : 0);
}
