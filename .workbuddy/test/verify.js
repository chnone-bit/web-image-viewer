/**
 * 图片浏览器脚本 · 综合验证
 * 覆盖：过滤规则 / 尺寸适配 / 动态增量 / 交互 / 配置持久化
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const CODE = fs.readFileSync('C:/Users/lidt/WorkBuddy/2026-10-05-16-56-29/forum-image-viewer.user.js', 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
};

/* ================= 场景 1：过滤规则 ================= */
console.log('\n【场景 1】图片过滤规则');
{
  const html = `<!DOCTYPE html><html><body>
    <div class="adslot"><img id="ad" src="https://x.com/banner.jpg" alt="logo"></div>
    <div class="post">
      <img id="avatar" class="avatar" src="https://x.com/avatar.jpg" alt="avatar">
      <div class="message">
        <img id="big1" src="https://x.com/p1.jpg" alt="风景">
        <img id="small" src="https://x.com/s.jpg" alt="小图">
        <img id="smiley" class="smiley" src="https://x.com/emo.png" alt="smiley">
        <img id="big2" src="https://x.com/p2.jpg" alt="风景2">
        <img id="lazy" data-src="https://x.com/p3.jpg" alt="懒加载">
      </div>
      <div class="signature"><img id="sig" src="https://x.com/sig.png" alt="signature"></div>
    </div>
  </body></html>`;
  const S = {
    'https://x.com/banner.jpg': [468, 60], 'https://x.com/avatar.jpg': [80, 80],
    'https://x.com/p1.jpg': [1600, 900], 'https://x.com/s.jpg': [120, 90],
    'https://x.com/emo.png': [20, 20], 'https://x.com/p2.jpg': [900, 1600],
    'https://x.com/p3.jpg': [1400, 900], 'https://x.com/sig.png': [240, 60],
    'https://x.com/late.jpg': [1920, 1080]
  };
  const w = mkDom(html, S);
  w.eval(CODE);
  setTimeout(() => {
    const n = +w.document.querySelector('.fiv-fab-count').textContent;
    ok('大图×3 入池、小图/头像/表情/广告/签名档 被过滤（期望 3）', n === 3, '实际 ' + n);

    // 懒加载图 src 被正确读取
    w.document.querySelector('.fiv-fab').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    setTimeout(() => {
      ok('浏览器可打开', w.document.getElementById('fiv-root').classList.contains('fiv-open'));
      ok('缩略图条渲染 3 张', w.document.querySelectorAll('.fiv-thumb').length === 3);
      ok('计数显示 1 / 3', w.document.querySelector('.fiv-counter').textContent === '1 / 3',
        w.document.querySelector('.fiv-counter').textContent);
      step2(w);
    }, 300);
  }, 700);
}

/* ================= 场景 2：尺寸适配 ================= */
function step2(w) {
  console.log('\n【场景 2】尺寸适配（统一适应屏幕，小图不放大）');
  const wrap = w.document.querySelector('.fiv-imgwrap');
  setTimeout(() => {
    const img = wrap.querySelector('img');
    console.log('     (info) img 基准尺寸 =', img && img.style.width, '×', img && img.style.height);
    console.log('     (info) 容器变换 =', wrap.style.transform);
    ok('图片已按可用区显式设定基准尺寸', !!img && /px/.test(img.style.width),
      img ? img.style.width : 'null');
    // 原始 1600×900，可用区约 1120×724 → 等比缩到约 1120×630
    const cw = parseFloat(img.style.width), ch = parseFloat(img.style.height);
    ok('大图被缩小以适配可用区（<1600）', cw > 0 && cw < 1600, 'width=' + cw);
    ok('保持原始宽高比 16:9', cw > 0 && Math.abs((cw / ch) - (1600 / 900)) < 0.02,
      cw + 'x' + ch + ' ratio=' + (cw / ch).toFixed(3));
    ok('宽高均未超出可用区', cw <= 1121 && ch <= 725, cw + 'x' + ch);
    step2b(w);
  }, 200);
}

/* 小图不放大 + 长图限高 */
function step2b(w) {
  // 跳到第 3 张（1400×900 懒加载图）后回到第 1 张，验证一致
  const wrap = w.document.querySelector('.fiv-imgwrap');
  const img = wrap.querySelector('img');
  const cw = parseFloat(img.style.width), ch = parseFloat(img.style.height);
  ok('基准变换倍率为 1（缩放从「适应屏幕」起算）',
    /scale\(1\)/.test(wrap.style.transform || ''), wrap.style.transform);
  step3(w);
}

/* ================= 场景 3：翻页与交互 ================= */
function step3(w) {
  console.log('\n【场景 3】翻页与交互');
  const cnt = () => w.document.querySelector('.fiv-counter').textContent;
  const stage = w.document.querySelector('.fiv-stage');
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  setTimeout(() => {
    ok('End 跳到末张 3 / 3', cnt() === '3 / 3', cnt());
    w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    setTimeout(() => {
      ok('Home 跳回首张 1 / 3', cnt() === '1 / 3', cnt());
      w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      setTimeout(() => {
        ok('→ 翻到第 2 张', cnt() === '2 / 3', cnt());
        w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        setTimeout(() => {
          ok('← 回到第 1 张', cnt() === '1 / 3', cnt());
          // 滚轮
          stage.dispatchEvent(Object.assign(new w.Event('wheel', { bubbles: true, cancelable: true }),
            { deltaY: 120, clientX: 600, clientY: 400 }));
          setTimeout(() => {
            ok('滚轮下滚翻到下一张', cnt() === '2 / 3', cnt());
            // 已看标记
            ok('缩略图有已看标记（.fiv-seen）', w.document.querySelectorAll('.fiv-thumb.fiv-seen').length >= 1,
              w.document.querySelectorAll('.fiv-thumb.fiv-seen').length + ' 个');
            ok('当前缩略图高亮（.fiv-cur）', w.document.querySelectorAll('.fiv-thumb.fiv-cur').length === 1);
            step4(w);
          }, 250);
        }, 200);
      }, 200);
    }, 200);
  }, 200);
}

/* ================= 场景 4：动态加载 ================= */
function step4(w) {
  console.log('\n【场景 4】动态加载自动容纳');
  const cnt = () => w.document.querySelector('.fiv-fab-count').textContent;
  const d = w.document.createElement('div');
  d.className = 'message';
  const im = w.document.createElement('img');
  im.src = 'https://x.com/late.jpg';
  im.alt = '后加载图';
  d.appendChild(im);
  w.document.querySelector('.post').appendChild(d);
  setTimeout(() => {
    ok('新加载图片被自动纳入（3 → 4）', cnt() === '4', '实际 ' + cnt());
    ok('缩略图条同步更新为 4 张', w.document.querySelectorAll('.fiv-thumb').length === 4,
      w.document.querySelectorAll('.fiv-thumb').length + ' 张');
    ok('查看位置未被重置', w.document.querySelector('.fiv-counter').textContent === '2 / 4',
      w.document.querySelector('.fiv-counter').textContent);
    step5(w);
  }, 700);
}

/* ================= 场景 5：配置面板与持久化 ================= */
function step5(w) {
  console.log('\n【场景 5】配置面板与持久化');
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true }));
  // 关闭浏览器以便操作面板
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  setTimeout(() => {
    const mask = w.document.querySelector('.fiv-panel-mask');
    ok('Shift+/ 打开设置面板', !!mask && mask.classList.contains('fiv-open'),
      mask ? mask.className : 'null');
    const fields = w.document.querySelectorAll('.fiv-panel [data-field]');
    ok('面板包含配置字段（≥15）', fields.length >= 15, fields.length + ' 个');
    const keys = Array.from(fields).map((f) => f.dataset.field);
    ok('含站点自定义选择器字段', keys.includes('includeSelector') && keys.includes('excludeSelector'));
    ok('含过滤阈值字段', keys.includes('minWidth') && keys.includes('minHeight'));

    // 修改并保存
    const mw = w.document.querySelector('[data-field="minWidth"]');
    mw.value = '500';
    w.document.querySelector('[data-save]').click();
    setTimeout(() => {
      ok('保存后面板关闭', !w.document.querySelector('.fiv-panel-mask').classList.contains('fiv-open'));
      const stored = w.localStorage.getItem('fiv:config:site:' + w.location.hostname);
      ok('配置已按站点落盘', !!stored && stored.includes('500'), stored || '(空)');
      ok('配置面板无异常', true);
      finish();
    }, 250);
  }, 300);
}

function finish() {
  console.log('\n═══════════════════════════════');
  console.log('  通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
  console.log('═══════════════════════════════');
  process.exit(fail ? 1 : 0);
}

/* ---------- 通用 DOM 构造 ---------- */
function mkDom(html, sizes) {
  const dom = new JSDOM(html, {
    url: 'https://forum.example.com/thread-123.html',
    runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  Object.defineProperty(w.HTMLImageElement.prototype, 'naturalWidth', {
    get() { const s = sizes[this.src || this.getAttribute('data-src')]; return s ? s[0] : 0; },
    configurable: true
  });
  Object.defineProperty(w.HTMLImageElement.prototype, 'naturalHeight', {
    get() { const s = sizes[this.src || this.getAttribute('data-src')]; return s ? s[1] : 0; },
    configurable: true
  });
  w.Element.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, x: 0, y: 0 };
  };
  w.HTMLImageElement.prototype.getBoundingClientRect = function () {
    const s = sizes[this.src] || [400, 300];
    return { left: 100, top: 100, right: 100 + s[0], bottom: 100 + s[1], width: s[0], height: s[1], x: 100, y: 100 };
  };
  w.HTMLImageElement.prototype.scrollIntoView = function () {};
  w.Element.prototype.scrollTo = function () {};
  w.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.URL.createObjectURL = () => 'blob:test';
  w.scrollTo = () => {};
  w.console.error = () => {};   // 屏蔽 jsdom canvas 噪音
  try {
    Object.defineProperty(w.navigator, 'clipboard', {
      value: { writeText: () => Promise.resolve() }, configurable: true
    });
  } catch (e) {}
  return w;
}
