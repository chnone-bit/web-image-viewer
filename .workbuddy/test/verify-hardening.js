/**
 * 第一批加固回归测试
 *  1. URL 安全边界：javascript:/file: 被拦；http/https 放行；download/open 只走 http(s)
 *  2. Observer 不再监听 style（避免自触发扫描）
 *  3. rejected 只缓存「永久拒绝」，尺寸类不缓存
 *  4. 白名单模式 + 空名单 → 不启用
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const CODE = fs.readFileSync('C:/Users/lidt/WorkBuddy/2026-10-05-16-56-29/web-image-viewer.user.js', 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✅ ' + n)) : (fail++, console.log('  ❌ ' + n + (e ? '  → ' + e : ''))); };

const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <div class="post"><div class="message">
    <img id="good" src="https://x.com/a.jpg">
    <img id="evil" data-original="javascript:alert(1)" src="https://x.com/b.jpg">
    <img id="fg" data-src="file:///etc/passwd" src="https://x.com/c.jpg">
    <img id="datasvg" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='400'%3E%3C/svg%3E">
    <img id="small" src="https://x.com/s.jpg">
  </div></div>
</body></html>`, { url: 'https://forum.example.com/t.html', runScripts: 'outside-only', pretendToBeVisual: true });

const w = dom.window;
w.matchMedia = (q) => ({ matches: false, addListener() {}, removeListener() {} });

// naturalWidth/Height：small 图很小（应被尺寸过滤）
const sizes = {
  'https://x.com/a.jpg': [1200, 800], 'https://x.com/b.jpg': [1200, 800],
  'https://x.com/c.jpg': [1200, 800], 'https://x.com/s.jpg': [50, 50],
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='400'%3E%3C/svg%3E": [600, 400]
};
Object.defineProperty(w.HTMLImageElement.prototype, 'naturalWidth', {
  get() { const s = sizes[this.src]; return s ? s[0] : 0; }, configurable: true
});
Object.defineProperty(w.HTMLImageElement.prototype, 'naturalHeight', {
  get() { const s = sizes[this.src]; return s ? s[1] : 0; }, configurable: true
});
w.Element.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, x: 0, y: 0 }; };
w.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
w.cancelAnimationFrame = (id) => clearTimeout(id);
w.Element.prototype.scrollIntoView = function () {};
w.scrollTo = () => {};
w.console.error = () => {};

// 捕获 window.open 调用，避免真的开窗
const opened = [];
w.open = (u) => { opened.push(u); return null; };

w.eval(CODE);

const q = (s) => w.document.querySelector(s);

setTimeout(() => {
  const P = w.__fiv.ImagePool;

  console.log('\n【1. URL 安全边界】pickSrc 过滤脏协议');
  const poolSrcs = P.items.map((it) => it.src);
  ok('http 图正常入池', poolSrcs.indexOf('https://x.com/a.jpg') >= 0, poolSrcs.join(', '));
  ok('javascript: 未入池', poolSrcs.indexOf('javascript:alert(1)') < 0);
  ok('file: 未入池', poolSrcs.indexOf('file:///etc/passwd') < 0);
  ok('evil 图回退到自身合法 src（b.jpg）', poolSrcs.indexOf('https://x.com/b.jpg') >= 0);
  ok('fg 图回退到自身合法 src（c.jpg）', poolSrcs.indexOf('https://x.com/c.jpg') >= 0);

  console.log('\n【1b. 外部动作只放行 http(s)】');
  const isSafeExt = w.__fiv.isSafeExternalUrl;
  const isSafeImg = w.__fiv.isSafeImageSrc;
  ok('isSafeExternalUrl 放行 https', isSafeExt('https://x.com/a.jpg') === true);
  ok('isSafeExternalUrl 放行 http', isSafeExt('http://x.com/a.jpg') === true);
  ok('isSafeExternalUrl 拦 javascript:', isSafeExt('javascript:alert(1)') === false);
  ok('isSafeExternalUrl 拦 data:svg', isSafeExt('data:image/svg+xml,<svg/>') === false);
  ok('isSafeExternalUrl 拦 blob:', isSafeExt('blob:https://x.com/abc') === false);
  ok('isSafeExternalUrl 拦 file:', isSafeExt('file:///etc/passwd') === false);
  ok('isSafeImageSrc 拦 javascript:', isSafeImg('javascript:alert(1)') === false);
  ok('isSafeImageSrc 放行 data:image/', isSafeImg('data:image/png;base64,AAA') === true);
  ok('isSafeImageSrc 拦 data:text/html', isSafeImg('data:text/html,<script>') === false);

  const viewer = w.__fiv.Viewer;
  viewer.openAt(0);
  setTimeout(() => {
    opened.length = 0;
    w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'o', bubbles: true }));
    setTimeout(() => {
      ok('合法 http 图可打开新标签', opened.length === 1 && /^https?:/.test(opened[0]), opened.join(','));

      // 强行把当前图改成脏地址，验证"打开原图"真的被拦（行为级验证）
      const cur = viewer.itemCount ? w.__fiv.ImagePool.items[viewer.index] : null;
      if (cur) {
        const backup = cur.src;
        cur.src = 'javascript:alert(1)';
        opened.length = 0;
        w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'o', bubbles: true }));
        setTimeout(() => {
          ok('脏地址被拦截，未打开新标签', opened.length === 0, 'opened=' + opened.length);
          cur.src = backup;
          sections234();
        }, 150);
      } else {
        ok('能够定位当前图以做行为级验证', false, 'cur is null');
        sections234();
      }
    }, 200);
  }, 300);
}, 700);

function sections234() {
  console.log('\n【2. Observer 不再监听 style】');
  ok('源码注释已说明不监听 style', CODE.indexOf("不要监听 'style'") >= 0);
  /* ⚠️ 这里必须**解析** attributeFilter 的内容，不能整段字面匹配。
     v1.8.0 把它从一行展开成多行（与 pickSrc 的采集面对齐，共 20 个名字），
     字面匹配整段字符串就会假失败 —— 断言的是「filter 里没有 style」，
     不是「filter 长什么样」。 */
  const filters = (CODE.match(/attributeFilter:\s*\[([^\]]+)\]/g) || []).join(',');
  ok('attributeFilter 已声明', filters.length > 0, '未找到 attributeFilter');
  ok('attributeFilter 不含 style', !/'style'/.test(filters),
    filters.slice(0, 120));

  console.log('\n【3. rejected 语义】');
  ok('存在 judge.isPermanent 判定', /judge\.isPermanent = function/.test(CODE));
  ok('尺寸类拒绝不缓存（注释明确）', CODE.indexOf('尺寸不足') >= 0 && CODE.indexOf('不缓存') >= 0);

  console.log('\n【4. 白名单语义】');
  ok('空名单时返回 false', CODE.indexOf('if (!wl.length) return false;') >= 0);

  finish();
}

function finish() {
  console.log('\n═══════════════════════════════');
  console.log('  通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
  console.log('═══════════════════════════════');
  process.exit(fail ? 1 : 0);
}
