/**
 * 回归：设置面板「看不清 / 点不了」
 * 根因：主题变量被拆两处，全量那份只写在懒构建的浏览层上；
 *       首次用 Shift+/ 打开设置时变量全缺 → 背景透明 + 文字继承站点色 + 点击穿透。
 * 断言：不经浏览层、直接打开设置，全量变量必须已就绪，且面板可读写保存。
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const CODE = fs.readFileSync('C:/Users/lidt/WorkBuddy/2026-10-05-16-56-29/forum-image-viewer.user.js', 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✅ ' + n)) : (fail++, console.log('  ❌ ' + n + (e ? '  → ' + e : ''))); };

const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <div class="post"><div class="message"><img id="i1" src="https://x.com/a.jpg"></div></div>
  <div class="post"><div class="message"><img id="i2" src="https://x.com/b.jpg"></div></div>
  <div class="post"><div class="message"><img id="i3" src="https://x.com/c.jpg"></div></div>
</body></html>`, { url: 'https://forum.example.com/t.html', runScripts: 'outside-only', pretendToBeVisual: true });

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

setTimeout(() => {
  console.log('\n【前置】启动即注入 :root 全量主题变量（浏览层尚未构建）');
  ok('浏览层尚未构建（已确认真实场景）', !w.document.getElementById('fiv-root'));
  const varsEl = w.document.getElementById('fiv-theme-vars');
  ok('存在主题变量 style 节点', !!varsEl);
  const css = varsEl ? varsEl.textContent : '';
  ok(':root 含 --fiv-fg（文字色）', css.indexOf('--fiv-fg') >= 0);
  ok(':root 含 --fiv-panelbg（面板底色）', css.indexOf('--fiv-panelbg') >= 0);
  ok(':root 含 --fiv-border（描边）', css.indexOf('--fiv-border') >= 0);
  ok(':root 含 --fiv-input（输入框底）', css.indexOf('--fiv-input') >= 0);

  console.log('\n【面板可见性】CSS 兜底值');
  const allCss = Array.from(w.document.querySelectorAll('style')).map((s) => s.textContent).join('\n');
  ok('面板 background 带兜底值', /\.fiv-panel\s*\{[\s\S]*?background:\s*var\(--fiv-panelbg,\s*#?\w/.test(allCss));
  ok('面板 color 带兜底值', /\.fiv-panel\s*\{[\s\S]*?color:\s*var\(--fiv-fg,\s*#?\w/.test(allCss));
  ok('暗色兜底规则存在', allCss.indexOf('data-fiv-theme="dark"') >= 0);

  console.log('\n【交互】不经浏览层，直接 Shift+/ 打开设置');
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true }));

  setTimeout(() => {
    const mask = q('.fiv-panel-mask');
    const panel = q('.fiv-panel');
    ok('设置面板已打开 (.fiv-open)', !!panel && panel.classList.contains('fiv-open'));
    ok('遮罩层已打开 (.fiv-open)', !!mask && mask.classList.contains('fiv-open'));

    // 打开后变量应仍然在（show() 会刷新一次）
    const cssAfter = (w.document.getElementById('fiv-theme-vars') || {}).textContent || '';
    ok('打开面板后主题变量仍完整', cssAfter.indexOf('--fiv-fg') >= 0 && cssAfter.indexOf('--fiv-panelbg') >= 0);

    // 可读性：字段齐全
    const fields = Array.from(w.document.querySelectorAll('.fiv-panel [data-field]')).map((f) => f.dataset.field);
    ok('面板渲染出字段（可读可改）', fields.length >= 10, '字段数 ' + fields.length);
    ok('含开关字段 dimPage', fields.includes('dimPage'));
    ok('含选择器文本框 includeSelector', fields.includes('includeSelector'));

    console.log('\n【可设置】改动 → 保存 → 落盘生效');
    const cb = q('[data-field="dimPage"]');
    cb.checked = false;
    const num = q('[data-field="dimLevel"]');
    num.value = '0.4';
    q('[data-save]').click();

    setTimeout(() => {
      // 存储结构：全局字段落 config:global，站点字段落 config:site:<host>
      const raw = ['config:global', 'config:site:forum.example.com']
        .map((k) => w.localStorage.getItem('fiv:' + k) || '')
        .join('\n');
      ok('保存后面板关闭', !q('.fiv-panel').classList.contains('fiv-open'));
      ok('配置已写入存储', raw.trim().length > 0, raw.slice(0, 100));
      ok('dimPage=false 已落盘', /"dimPage":false/.test(raw), raw.slice(0, 100));
      ok('dimLevel=0.4 已落盘', /"dimLevel":0\.4/.test(raw));

      // 再次打开，值应回显
      w.dispatchEvent(new w.KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true }));
      setTimeout(() => {
        ok('重开后 dimPage 回显为未勾选', q('[data-field="dimPage"]').checked === false);
        ok('重开后 dimLevel 回显 0.4', String(q('[data-field="dimLevel"]').value) === '0.4');
        finish();
      }, 200);
    }, 250);
  }, 250);
}, 700);

function finish() {
  console.log('\n═══════════════════════════════');
  console.log('  通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
  console.log('═══════════════════════════════');
  process.exit(fail ? 1 : 0);
}
