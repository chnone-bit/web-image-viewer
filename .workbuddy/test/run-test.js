/**
 * 用 jsdom 模拟论坛页面，真实执行油猴脚本，验证：
 *  1) 脚本能无异常加载
 *  2) 图片池能正确识别大图、过滤头像/表情/小图/广告
 *  3) 动态插入的图片能被自动收纳
 *  4) 悬浮按钮、浏览器 UI、配置面板能正确构建
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SCRIPT = path.join('C:/Users/lidt/WorkBuddy/2026-10-05-16-56-29', 'web-image-viewer.user.js');
const code = fs.readFileSync(SCRIPT, 'utf8');

/* ---------- 构造模拟论坛页面 ---------- */
const html = `<!DOCTYPE html><html><head><title>测试帖</title></head>
<body>
  <div class="adslot"><img id="ad" src="https://x.com/banner.jpg" class="ad-banner" alt="logo"></div>
  <div class="post">
    <img id="avatar" class="avatar" src="https://x.com/avatar.jpg" alt="avatar">
    <div class="message">
      <img id="big1" src="https://x.com/p1.jpg" alt="大图1">
      <img id="small" src="https://x.com/s.jpg" alt="小图">
      <img id="smiley" class="smiley" src="https://x.com/emo.png" alt="smiley">
      <img id="big2" src="https://x.com/p2.jpg" alt="大图2">
      <img id="lazy" data-src="https://x.com/p3.jpg" alt="懒加载">
    </div>
    <div class="signature"><img id="sig" src="https://x.com/sig.png" alt="signature"></div>
  </div>
</body></html>`;

const dom = new JSDOM(html, {
  url: 'https://forum.example.com/thread-123.html',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;

/* ---------- 补 jsdom 缺失的能力 ---------- */
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
const imgSizes = {
  'https://x.com/banner.jpg': [468, 60],
  'https://x.com/avatar.jpg': [80, 80],
  'https://x.com/p1.jpg': [1600, 900],
  'https://x.com/s.jpg': [120, 90],
  'https://x.com/emo.png': [20, 20],
  'https://x.com/p2.jpg': [900, 1600],
  'https://x.com/p3.jpg': [1400, 900],
  'https://x.com/sig.png': [240, 60],
  'https://x.com/ajax1.jpg': [1920, 1080],
  'https://x.com/ajax2.jpg': [1100, 1400]
};
Object.defineProperty(window.HTMLImageElement.prototype, 'naturalWidth', {
  get() { const s = imgSizes[this.src || this.getAttribute('data-src')]; return s ? s[0] : 0; },
  configurable: true
});
Object.defineProperty(window.HTMLImageElement.prototype, 'naturalHeight', {
  get() { const s = imgSizes[this.src || this.getAttribute('data-src')]; return s ? s[1] : 0; },
  configurable: true
});
window.HTMLImageElement.prototype.getBoundingClientRect = function () {
  const s = imgSizes[this.src] || this.__rect || [300, 200];
  return { left: 0, top: 0, right: s[0], bottom: s[1], width: s[0], height: s[1], x: 0, y: 0 };
};
window.Element.prototype.getBoundingClientRect = window.Element.prototype.getBoundingClientRect || function () {
  return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 };
};
// jsdom 里元素默认 rect 全是 0，会让 isHiddenEl 误判 → 覆写
window.Element.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 };
};
window.HTMLImageElement.prototype.getBoundingClientRect = function () {
  const s = imgSizes[this.src] || [300, 200];
  return { left: 0, top: 0, right: s[0], bottom: s[1], width: s[0], height: s[1], x: 0, y: 0 };
};
window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);
window.URL.createObjectURL = () => 'blob:x';

/* MutationObserver 在 jsdom 中存在，确认 */
console.log('MutationObserver 可用:', typeof window.MutationObserver);

/* ---------- 捕获脚本内所有异常 ---------- */
const errors = [];
window.onerror = (m, s, l, c, e) => { errors.push(String(m)); };
const origErr = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); };
window.console.error = console.error;
window.console.warn = () => {};
window.console.log = () => {};

/* ---------- 执行脚本 ---------- */
let threw = null;
try {
  window.eval(code);
} catch (e) {
  threw = e;
}

setTimeout(() => {
  console.log('\n=========== 测试结果 ===========');
  console.log('脚本执行异常:', threw ? threw.message : '无 ✅');
  console.log('运行期错误:', errors.length ? errors.slice(0, 5) : '无 ✅');

  const doc = window.document;
  const fab = doc.querySelector('.fiv-fab');
  console.log('\n悬浮按钮已创建:', !!fab);
  if (fab) {
    console.log('  按钮文字:', fab.textContent.replace(/\s+/g, ' ').trim());
    console.log('  是否可见(.fiv-on):', fab.classList.contains('fiv-on'));
  }
  const root = doc.getElementById('fiv-root');
  console.log('浏览器根节点已创建:', !!root);

  // 验证图片池：通过打开浏览器读取计数
  if (fab) {
    fab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }
  setTimeout(() => {
    const counter = doc.querySelector('.fiv-counter');
    console.log('浏览计数显示:', counter ? counter.textContent : '(未打开)');

    // 动态插入新图 → 验证自动收纳
    const dummy = doc.createElement('div');
    dummy.className = 'message';
    const im = doc.createElement('img');
    im.src = 'https://x.com/ajax1.jpg';
    im.alt = '动态图';
    dummy.appendChild(im);
    doc.querySelector('.post').appendChild(dummy);

    setTimeout(() => {
      const fabCount = doc.querySelector('.fiv-fab-count');
      console.log('动态插入后按钮计数:', fabCount ? fabCount.textContent : '?');
      const items = doc.querySelectorAll('.fiv-thumb');
      console.log('缩略图节点数:', items.length);
      const strips = doc.querySelector('.fiv-hasstrip');
      console.log('缩略图条已启用:', !!strips);

      // 验证配置面板
      const panelMask = doc.querySelector('.fiv-panel-mask');
      console.log('\n配置面板已创建:', !!panelMask);
      console.log('\n=========== 测试结束 ===========');
      process.exit(0);
    }, 400);
  }, 300);
}, 900);
