/**
 * 诊断：设置面板「看不清 / 点不了」
 * 重点检查：面板层级 vs 站点自身高 z-index 元素；面板 CSS 变量是否生效
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const CODE = fs.readFileSync('C:/Users/lidt/WorkBuddy/2026-10-05-16-56-29/forum-image-viewer.user.js', 'utf8');

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

// 捕获注入的 CSS 文本
let cssText = '';
const origAppend = w.document.head.appendChild.bind(w.document.head);
w.eval(CODE);

setTimeout(() => {
  // 找 GM_addStyle 注入的 <style>
  const styles = Array.from(w.document.querySelectorAll('style')).map((s) => s.textContent).join('\n');
  cssText = styles;

  const panelCss = (cssText.match(/\.fiv-panel\s*\{[^}]*\}/) || [''])[0];
  const maskCss = (cssText.match(/\.fiv-panel-mask\s*\{[^}]*\}/) || [''])[0];
  console.log('--- .fiv-panel CSS ---\n' + panelCss);
  console.log('\n--- .fiv-panel-mask CSS ---\n' + maskCss);

  // 打开设置
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true }));

  setTimeout(() => {
    const mask = w.document.querySelector('.fiv-panel-mask');
    const panel = w.document.querySelector('.fiv-panel');
    console.log('\n--- DOM ---');
    console.log('mask 存在:', !!mask, '| open:', mask && mask.className);
    console.log('panel 存在:', !!panel, '| open:', panel && panel.className);
    console.log('panel 父节点:', panel && panel.parentNode && panel.parentNode.tagName);

    // 检查 :root 主题变量（现在写在 <style> 节点里）
    const varsEl = w.document.getElementById('fiv-theme-vars');
    const rootCss = varsEl ? varsEl.textContent : '';
    console.log('\n--- :root 主题变量（来自 <style id=fiv-theme-vars>）---');
    console.log(rootCss.slice(0, 420));
    console.log('\n含 --fiv-fg:', rootCss.indexOf('--fiv-fg') >= 0);
    console.log('含 --fiv-panelbg:', rootCss.indexOf('--fiv-panelbg') >= 0);
    console.log('含 --fiv-border:', rootCss.indexOf('--fiv-border') >= 0);
    console.log('含 --fiv-input:', rootCss.indexOf('--fiv-input') >= 0);
    console.log('含 --fiv-z:', rootCss.indexOf('--fiv-z') >= 0);
    console.log('<html> theme 标记:', w.document.documentElement.getAttribute('data-fiv-theme'));

    process.exit(0);
  }, 200);
}, 700);
